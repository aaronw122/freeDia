import { existsSync } from "node:fs";

const PORT = Number(process.env.FAUX_PORT ?? 8787);
const LATENCY_MS = Number(process.env.FREEDIA_FAUX_LATENCY_MS ?? 0);
const TOKEN_DELAY_MS = 1000 / Number(process.env.FREEDIA_FAUX_TPS ?? 400);

interface ChatMessage {
	role?: unknown;
	content?: unknown;
	name?: unknown;
	toolName?: unknown;
}

interface ChatBody {
	stream?: boolean;
	messages?: unknown;
	model?: unknown;
}

function textOf(message: ChatMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			block !== null &&
			typeof block === "object" &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
		) {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function asChatMessages(messages: unknown): ChatMessage[] {
	if (!Array.isArray(messages)) return [];
	return messages.filter(
		(m): m is ChatMessage => m !== null && typeof m === "object",
	);
}

const LONG_TEXT = Array.from(
	{ length: 60 },
	(_, index) => `Sentence ${index + 1} of a deliberately long faux reply.`,
).join(" ");

const QUESTION_HEADING = "## Question\n\n";
const TITLE_REQUEST = "Title this chat in 8 words or fewer.";
const PAGE_FILE = /\S*\/\.freedia\/pages\/[0-9a-f-]+\.md/;

function between(text: string, start: string, ends: string[]): string | null {
	const from = text.indexOf(start);
	if (from < 0) return null;
	const rest = text.slice(from + start.length);
	for (const end of ends) {
		const to = rest.indexOf(end);
		if (to >= 0) return rest.slice(0, to);
	}
	return rest;
}

function lineValue(text: string, name: string): string {
	const prefix = `${name}: `;
	const line = text.split("\n").find((value) => value.startsWith(prefix));
	return line?.slice(prefix.length) ?? "";
}

function questionOf(prompt: string): string | null {
	const at = prompt.lastIndexOf(QUESTION_HEADING);
	return at < 0 ? null : prompt.slice(at + QUESTION_HEADING.length).trim();
}

function questionsSoFar(messages: ChatMessage[]): string[] {
	return messages
		.filter((message) => message.role === "user")
		.map((message) => questionOf(textOf(message)) ?? textOf(message));
}

function titleReply(prompt: string): string {
	const question = lineValue(prompt, "Question")
		.replace(/\[\[[a-z-]+\]\]/g, "")
		.replace(/[?.!]+$/, "")
		.trim();
	return question
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 6)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

interface Reply {
	text?: string;
	tool?: { name: string; args: string };
	slow?: boolean;
	error?: { status: number; body: unknown };
}

function planReply(messages: ChatMessage[], model: string): Reply {
	const last = messages.at(-1);
	if (!last) return { text: "[faux] empty conversation" };
	const prompt = textOf(last);
	if (last.role === "tool") {
		const lower = prompt.toLowerCase();
		const toolName =
			last.toolName ??
			last.name ??
			(prompt.startsWith("#")
				? "read"
				: lower.includes("bash")
					? "bash"
					: lower.includes("write")
						? "write"
						: "tool");
		return {
			text: `[${model}] tool ${String(toolName)} isError=${/not found|error/i.test(prompt)}: ${prompt.slice(0, 300)}`,
		};
	}
	if (prompt.includes(TITLE_REQUEST)) return { text: titleReply(prompt) };
	const question = questionOf(prompt);
	if (question !== null) {
		const page = messages
			.filter((message) => message.role === "system")
			.map(textOf)
			.join("\n")
			.match(PAGE_FILE)?.[0];
		if (question.includes("[[page]]") && page) {
			return { tool: { name: "read", args: JSON.stringify({ path: page }) } };
		}
		if (question.includes("[[bash]]")) {
			return {
				text: "Running a command now.",
				tool: {
					name: "bash",
					args: JSON.stringify({ command: "touch freedia-bash-ran" }),
				},
			};
		}
		if (question.includes("[[write]]")) {
			return {
				text: "Writing the file now.",
				tool: {
					name: "write",
					args: JSON.stringify({
						path: "freedia-write-ran.txt",
						content: "written by faux",
					}),
				},
			};
		}
		if (question.includes("[[reject]]")) {
			return {
				error: {
					status: 401,
					body: {
						type: "error",
						error: {
							type: "authentication_error",
							message: "invalid x-api-key",
						},
					},
				},
			};
		}
		if (question.includes("[[ratelimit]]")) {
			return {
				error: {
					status: 429,
					body: {
						type: "error",
						error: {
							type: "rate_limit_error",
							message:
								"This request would exceed your account's rate limit. Please try again later.",
						},
					},
				},
			};
		}
		if (question.includes("[[env]]")) {
			const keys = Object.keys(process.env).sort();
			return {
				text: `[${model}] env keys: ${keys.join(" ")} HOME=${process.env.HOME} PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR} cwd=${process.cwd()}`,
			};
		}
		if (question.includes("[[slow]]")) {
			return { text: `[${model}] ${LONG_TEXT}`, slow: true };
		}
		const quotes = between(prompt, "## Selected text\n\n", [
			"\n\n## Page excerpt",
			`\n\n${QUESTION_HEADING}`,
		]);
		const excerpt =
			between(prompt, "## Page excerpt\n\n", [`\n\n${QUESTION_HEADING}`]) ??
			between(prompt, "## Page excerpt around the selected text\n\n", [
				`\n\n${QUESTION_HEADING}`,
			]);
		const earlier = questionsSoFar(messages).slice(0, -1);
		const quoteCount =
			quotes === null ? 0 : quotes.split(/\n\n(?=> )/).filter(Boolean).length;
		return {
			text: [
				`[${model}] **${lineValue(prompt, "Title") || "This page"}**`,
				`You asked: ${question}`,
				`- Page: ${lineValue(prompt, "URL")}`,
				`- Selected text: ${quoteCount}${quotes ? ` (“${quotes.replace(/^>\s?/gm, "").replace(/\n/g, " ").slice(0, 120)}”)` : ""}`,
				`- Page excerpt: ${excerpt === null ? "none" : `${excerpt.length} characters${excerpt.includes("characters omitted") ? ", middle omitted" : ""}`}`,
				`- Earlier questions: ${earlier.length === 0 ? "none" : earlier.map((text) => `“${text.slice(0, 60)}”`).join(", ")}`,
				`- Earlier replies: ${messages.filter((message) => message.role === "assistant").length}`,
				`- Page file: ${page && existsSync(page) ? "available" : "none"}`,
			].join("\n\n"),
		};
	}
	return { text: `[${model}] faux reply to: ${prompt.slice(0, 120)}` };
}

function completionId(): string {
	return `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
}

Bun.serve({
	port: PORT,
	async fetch(request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname.endsWith("/models")) {
			return Response.json({
				object: "list",
				data: [
					{ id: "faux-1", object: "model", owned_by: "freedia" },
					{ id: "faux-2", object: "model", owned_by: "freedia" },
				],
			});
		}
		if (
			request.method !== "POST" ||
			!url.pathname.includes("chat/completions")
		) {
			return new Response("not found", { status: 404 });
		}
		const body = (await request.json()) as ChatBody;
		const messages = asChatMessages(body.messages);
		const model = typeof body.model === "string" ? body.model : "unknown";
		const reply = planReply(messages, model);
		if (LATENCY_MS > 0) await Bun.sleep(LATENCY_MS);
		if (reply.error) {
			return Response.json(reply.error.body, {
				status: reply.error.status,
				headers:
					reply.error.status === 429 ? { "retry-after": "0" } : undefined,
			});
		}
		const id = completionId();
		if (body.stream) {
			const chunks: string[] = [
				JSON.stringify({
					id,
					choices: [{ index: 0, delta: { role: "assistant" } }],
				}),
			];
			if (reply.text) {
				const pieces = reply.text.match(/[^ ]+ ?/g) ?? [reply.text];
				for (const piece of pieces) {
					chunks.push(
						JSON.stringify({
							id,
							choices: [{ index: 0, delta: { content: piece } }],
						}),
					);
				}
			}
			if (reply.tool) {
				chunks.push(
					JSON.stringify({
						id,
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call-faux-1",
											type: "function",
											function: {
												name: reply.tool.name,
												arguments: reply.tool.args,
											},
										},
									],
								},
							},
						],
					}),
				);
			}
			chunks.push(
				JSON.stringify({
					id,
					choices: [
						{
							index: 0,
							delta: {},
							finish_reason: reply.tool ? "tool_calls" : "stop",
						},
					],
				}),
			);
			let sent = 0;
			const stream = new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (sent > 0) await Bun.sleep(reply.slow ? 300 : TOKEN_DELAY_MS);
					const encoder = new TextEncoder();
					if (sent >= chunks.length) {
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
						return;
					}
					controller.enqueue(encoder.encode(`data: ${chunks[sent]}\n\n`));
					sent += 1;
				},
			});
			return new Response(stream, {
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
				},
			});
		}
		const message: Record<string, unknown> = reply.tool
			? {
					role: "assistant",
					content: reply.text ?? null,
					tool_calls: [
						{
							id: "call-faux-1",
							type: "function",
							function: { name: reply.tool.name, arguments: reply.tool.args },
						},
					],
				}
			: { role: "assistant", content: reply.text ?? "" };
		return Response.json({
			id,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model,
			choices: [
				{
					index: 0,
					message,
					finish_reason: reply.tool ? "tool_calls" : "stop",
				},
			],
			usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
		});
	},
});

console.log(`faux server on :${PORT}`);
