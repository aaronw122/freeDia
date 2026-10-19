import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function textOf(message: Message): string {
	const { content } = message;
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

const respond: FauxResponseFactory = (context, _options, _state, model) => {
	const last = context.messages[context.messages.length - 1];
	if (last?.role === "toolResult") {
		return fauxAssistantMessage(
			`[${model.id}] tool ${last.toolName} isError=${last.isError}: ${textOf(last).slice(0, 300)}`,
		);
	}
	const prompt = last ? textOf(last) : "";
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
