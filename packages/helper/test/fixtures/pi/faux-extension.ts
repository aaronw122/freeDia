import { existsSync } from "node:fs";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function textOf(message: Message): string {
	const { content } = message;
	if (message.role === "system") {
		const sections = Object.values(message.sections ?? {}).join("\n");
		return `${typeof content === "string" ? content : content.map((block) => block.text).join("")}\n${sections}`;
	}
	if (typeof content === "string") return content;
	let text = "";
	for (const block of content) {
		if (block.type === "text") text += block.text;
	}
	return text;
}

const LONG_TEXT = Array.from(
	{ length: 400 },
	(_, index) => `Sentence ${index + 1} of a deliberately long faux reply.`,
).join(" ");

const QUESTION_HEADING = "## Question\n\n";
const TITLE_REQUEST = "Title this chat in 8 words or fewer.";
const PAGE_FILE = /\S*\/\.freedia\/pages\/[0-9a-f-]+\.md/;

function between(text: string, start: string, ends: string[]): string | null {
	const from = text.indexOf(start);
	if (from < 0) return null;
	const rest = text.slice(from + start.length);
	const cut = Math.min(
		...ends.map((end) => rest.indexOf(end)).filter((index) => index >= 0),
		rest.length,
	);
	return rest.slice(0, cut);
}

function lineValue(text: string, name: string): string {
	return text.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1] ?? "";
}

function questionOf(prompt: string): string | null {
	const at = prompt.lastIndexOf(QUESTION_HEADING);
	return at < 0 ? null : prompt.slice(at + QUESTION_HEADING.length).trim();
}

function questionsSoFar(messages: Message[]): string[] {
	return messages
		.filter((message) => message.role === "user")
		.map((message) => questionOf(textOf(message)) ?? textOf(message));
}

function titleReply(prompt: string): string {
	const question = lineValue(prompt, "Question")
		.replace(/\[\[[a-z]+\]\]/g, "")
		.replace(/[?.!]+$/, "")
		.trim();
	const words = question.split(/\s+/).filter((word) => word !== "");
	return words
		.slice(0, 6)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

const freediaRespond = async (
	messages: Message[],
	prompt: string,
	question: string,
	modelId: string,
) => {
	const latency = Number(process.env.FREEDIA_FAUX_LATENCY_MS ?? 0);
	if (latency > 0) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, latency);
		await promise;
	}
	const page = messages
		.filter((message) => message.role === "system")
		.map(textOf)
		.join("\n")
		.match(PAGE_FILE)?.[0];
	if (question.includes("[[page]]") && page !== undefined) {
		return fauxAssistantMessage(fauxToolCall("read", { path: page }), {
			stopReason: "toolUse",
		});
	}
	if (question.includes("[[ratelimit]]")) {
		return fauxAssistantMessage([], {
			stopReason: "error",
			errorMessage:
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
		});
	}
	if (question.includes("[[bash]]")) {
		return fauxAssistantMessage(
			[
				fauxText("Running a command now."),
				fauxToolCall("bash", { command: "touch freedia-bash-ran" }),
			],
			{ stopReason: "toolUse" },
		);
	}
	if (question.includes("[[write]]")) {
		return fauxAssistantMessage(
			[
				fauxText("Writing the file now."),
				fauxToolCall("write", {
					path: "freedia-write-ran.txt",
					content: "written by faux",
				}),
			],
			{ stopReason: "toolUse" },
		);
	}
	if (question.includes("[[reject]]")) {
		return fauxAssistantMessage([], {
			stopReason: "error",
			errorMessage:
				'401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
		});
	}
	if (question.includes("[[slow]]")) {
		return fauxAssistantMessage([
			fauxThinking("Reading the page."),
			fauxText(
				`[${modelId}] ${LONG_TEXT.split(". ").slice(0, 120).join(". ")}.`,
			),
		]);
	}
	const quotes = between(prompt, "## Selected text\n\n", [
		"\n\n## Page excerpt",
		"\n\nNo page text",
		`\n\n${QUESTION_HEADING}`,
	]);
	const excerpt =
		between(prompt, "## Page excerpt\n\n", [`\n\n${QUESTION_HEADING}`]) ??
		between(prompt, "## Page excerpt around the selected text\n\n", [
			`\n\n${QUESTION_HEADING}`,
		]);
	const quoteCount =
		quotes === null ? 0 : quotes.split(/\n\n(?=> )/).filter(Boolean).length;
	const firstQuote =
		quotes
			?.split("\n")
			.map((line) => line.replace(/^>\s?/, ""))
			.join(" ")
			.trim()
			.slice(0, 120) ?? "";
	const earlier = questionsSoFar(messages).slice(0, -1);
	const lines = [
		`[${modelId}] **${lineValue(prompt, "Title") || "This page"}**`,
		"",
		`You asked: ${question}`,
		"",
		`- Page: ${lineValue(prompt, "URL")}`,
		`- Selected text: ${quoteCount}${quoteCount > 0 ? ` (“${firstQuote}”)` : ""}`,
		`- Page excerpt: ${excerpt === null ? "none" : `${excerpt.length} characters${excerpt.includes("characters omitted") ? ", middle omitted" : ""}`}`,
		`- Earlier questions: ${earlier.length === 0 ? "none" : earlier.map((text) => `“${text.slice(0, 60)}”`).join(", ")}`,
		`- Earlier replies: ${messages.filter((message) => message.role === "assistant").length}`,
		`- Page file: ${page !== undefined && existsSync(page) ? "available" : "none"}`,
	];
	if (question.includes("[[code]]")) {
		lines.push("", "```ts", 'const answer = "from the page";', "```");
	}
	return fauxAssistantMessage([
		fauxThinking("Reading the page and the selected text."),
		fauxText(lines.join("\n")),
	]);
};

const respond: FauxResponseFactory = (context, _options, _state, model) => {
	const last = context.messages[context.messages.length - 1];
	if (last?.role === "toolResult") {
		return fauxAssistantMessage(
			`[${model.id}] tool ${last.toolName} isError=${last.isError}: ${textOf(last).slice(0, 300)}`,
		);
	}
	const prompt = last ? textOf(last) : "";
	if (prompt.startsWith(TITLE_REQUEST)) {
		return fauxAssistantMessage(titleReply(prompt));
	}
	const question = questionOf(prompt);
	if (question !== null) {
		return freediaRespond(context.messages, prompt, question, model.id);
	}
	if (prompt.includes("[[write]]")) {
		return fauxAssistantMessage(
			[
				fauxText("Writing the file now."),
				fauxToolCall("write", {
					path: "freedia-should-not-exist.txt",
					content: "written by faux",
				}),
			],
			{ stopReason: "toolUse" },
		);
	}
	if (prompt.includes("[[read]]")) {
		return fauxAssistantMessage(fauxToolCall("ls", { path: "." }), {
			stopReason: "toolUse",
		});
	}
	if (prompt.includes("[[long]]")) {
		return fauxAssistantMessage(`[${model.id}] ${LONG_TEXT}`);
	}
	if (prompt.includes("[[ratelimit]]")) {
		return fauxAssistantMessage([], {
			stopReason: "error",
			errorMessage:
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
		});
	}
	if (prompt.includes("[[recall]]")) {
		const turns = context.messages
			.filter(
				(message) => message.role === "user" || message.role === "assistant",
			)
			.map(
				(message) =>
					`${message.role}:${JSON.stringify(textOf(message).slice(0, 40))}`,
			);
		return fauxAssistantMessage(
			`[${model.id}] I can see ${turns.length} turns: ${turns.join(", ")}`,
		);
	}
	return fauxAssistantMessage(`[${model.id}] faux reply to: ${prompt}`);
};

export default function (pi: ExtensionAPI): void {
	const contextWindow = Number(process.env.FREEDIA_FAUX_CONTEXT ?? 128_000);
	const faux = fauxProvider({
		provider: "faux",
		api: "faux",
		models: [
			{ id: "faux-1", name: "Faux One", contextWindow },
			{ id: "faux-2", name: "Faux Two", contextWindow },
		],
		tokensPerSecond: Number(process.env.FREEDIA_FAUX_TPS ?? 400),
	});
	faux.setResponses(Array.from({ length: 100_000 }, () => respond));
	pi.registerProvider(faux.provider);
}
