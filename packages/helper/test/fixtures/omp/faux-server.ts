// OpenAI-compatible mock provider for the omp spike: scripted replies keyed on
// prompt markers, mirroring the old pi faux fixture. Run under Bun.
const PORT = Number(process.env.FAUX_PORT ?? 8787);

interface ChatMessage {
	role?: unknown;
	content?: unknown;
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
	let out = "";
	for (const block of content) {
		if (
			block !== null &&
			typeof block === "object" &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
		) {
			out += block.text;
		}
	}
	return out;
}

function asChatMessages(messages: unknown): ChatMessage[] {
	if (!Array.isArray(messages)) return [];
	return messages.filter(
		(m): m is ChatMessage => m !== null && typeof m === "object",
	);
}

const LONG_TEXT = Array.from(
	{ length: 400 },
	(_, index) => `Sentence ${index + 1} of a deliberately long faux reply.`,
).join(" ");

const QUESTION_HEADING = "## Question\n\n";
const TITLE_REQUEST = "Title this chat in 8 words or fewer.";

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
	const match = text.match(new RegExp(`^${name}: (.*)$`, "m"));
	return match?.[1] ?? "";
}

function questionOf(prompt: string): string | null {
	return between(prompt, QUESTION_HEADING, ["\n## ", "\nURL: "]);
}

function titleReply(prompt: string): string {
	const pageTitle = lineValue(prompt, "Page title");
	const question = questionOf(prompt) ?? "";
	return `Title: ${pageTitle} ${question}`
		.trim()
		.split(/\s+/)
		.slice(0, 8)
		.join(" ");
}

interface Reply {
	text?: string;
	tool?: { name: string; args: string };
	slow?: boolean;
	error?: { status: number; body: unknown };
}

function planReply(messages: ChatMessage[], model: string): Reply {
	const last = messages[messages.length - 1];
	if (!last) return { text: "[faux] empty conversation" };
	const prompt = textOf(last);
	if (prompt.startsWith(TITLE_REQUEST)) {
		return { text: titleReply(prompt) };
	}
	const question = questionOf(prompt);
	if (question !== null) {
		const url = lineValue(prompt, "URL");
		const title = lineValue(prompt, "Page title");
		const turnCount = messages.filter(
			(m) => m.role === "user" || m.role === "assistant",
		).length;
		return {
			text: `[${model}] url=${url} title=${title} question=${question.slice(0, 120)} turns=${turnCount}`,
		};
	}
	if (prompt.includes("[[write]]")) {
		return {
			text: "Writing the file now.",
			tool: {
				name: "write",
				args: JSON.stringify({
					path: "freedia-should-not-exist.txt",
					content: "written by faux",
				}),
			},
		};
	}
	if (prompt.includes("[[read]]")) {
		return { tool: { name: "ls", args: JSON.stringify({ path: "." }) } };
	}
	if (prompt.includes("[[long]]")) {
		return { text: `[${model}] ${LONG_TEXT}`, slow: true };
	}
	if (prompt.includes("[[ratelimit]]")) {
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
	if (prompt.includes("[[recall]]")) {
		const turns = messages
			.filter((m) => m.role === "user" || m.role === "assistant")
			.map(
				(m) => `${String(m.role)}:${JSON.stringify(textOf(m).slice(0, 40))}`,
			);
		return {
			text: `[${model}] I can see ${turns.length} turns: ${turns.join(", ")}`,
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
		if (reply.error) {
			return Response.json(reply.error.body, { status: reply.error.status });
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
					const encoder = new TextEncoder();
					if (sent >= chunks.length) {
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
						return;
					}
					controller.enqueue(encoder.encode(`data: ${chunks[sent]}\n\n`));
					sent += 1;
					if (reply.slow) await Bun.sleep(40);
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
