import { memoryWindowStore } from "../layout";
import { promptRun, retextRun, type TimedRecord } from "../mock/fixtures";
import { fixtureReply, MockChatClient } from "../mock/mockClient";
import { mountChatWithStore } from "../mount";
import { asRecord } from "../records";

const SELECTION =
	"Example Domain. This domain is for use in illustrative examples in documents.";

const CODE_REPLY = `This page is the IANA **example domain**. You can fetch it like this:

\`\`\`ts
const response = await fetch("https://example.com/");
const html = await response.text();
console.log(html.includes("Example Domain"));
\`\`\`

It is reserved by RFC 2606, so it never points at a real site and is safe to use in`;

const CHATS = [
	{
		chatId: "3f2a9c1e-8b4d-4e6f-a0b1-c2d3e4f5a6b7",
		title: "What is the example domain for",
		updatedAt: new Date().toISOString(),
	},
	{
		chatId: "6a1f0c2d-4b3e-4d5f-9a8b-7c6d5e4f3a2b",
		title: "Summarize the pricing table",
		updatedAt: "2026-10-18T15:20:00.000Z",
	},
	{
		chatId: "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
		title: "Explain the RFC 2606 reserved names",
		updatedAt: "2026-10-12T09:05:00.000Z",
	},
];

function untilFirstDelta(run: TimedRecord[]): TimedRecord[] {
	const index = run.findIndex(
		(entry) =>
			asRecord(entry.record.assistantMessageEvent)?.type === "text_delta",
	);
	return run.slice(0, index);
}

function streamingPrefix(run: TimedRecord[], deltas: number): TimedRecord[] {
	let seen = 0;
	const result: TimedRecord[] = [];
	for (const entry of run) {
		if (asRecord(entry.record.assistantMessageEvent)?.type === "text_delta") {
			seen += 1;
			if (seen > deltas) break;
		}
		result.push(entry);
	}
	return result;
}

function frame(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	requestAnimationFrame(() => resolve());
	return promise;
}

type Scene = (client: MockChatClient, root: ShadowRoot) => Promise<void>;

async function ask(root: ShadowRoot, text: string) {
	const input = root.querySelector("textarea");
	if (!input) return;
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	setter?.call(input, text);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await frame();
	root.querySelector<HTMLButtonElement>("button[aria-label=Send]")?.click();
}

const scenes: Record<string, Scene> = {
	async chip() {},
	async streaming(client) {
		const run = retextRun(
			promptRun("stream"),
			"What is this page, and how would I fetch it?",
			CODE_REPLY,
			{ chunkSize: 12, stepMs: 0 },
		);
		client.play(streamingPrefix(run, 24));
	},
	async thinking(client) {
		client.play(
			untilFirstDelta(
				retextRun(promptRun("stream"), "What does this paragraph mean?", ""),
			),
		);
	},
	async error(client) {
		client.play(
			retextRun(promptRun("provider-rejected-401"), "Summarize this page", ""),
		);
	},
	async ratelimit(client) {
		const run = retextRun(promptRun("rate-limit"), "Summarize this page", "");
		const index = run.findIndex(
			(entry) => entry.record.type === "auto_retry_start",
		);
		client.play(run.slice(0, index + 1));
	},
	async signin(_client, root) {
		await ask(root, "Summarize this page");
	},
	async history(_client, root) {
		root
			.querySelector<HTMLButtonElement>("button[aria-label=History]")
			?.click();
	},
	async tool(client) {
		const run = promptRun("tools-readonly", 1);
		const index = run.findIndex(
			(entry) => entry.record.type === "tool_execution_end",
		);
		client.play(run.slice(0, index));
	},
	async live() {},
};

async function main() {
	const params = new URLSearchParams(location.search);
	const sceneName = params.get("scene") ?? "live";
	const host = document.createElement("freedia-chat");
	host.style.cssText =
		"position:fixed;inset:0;pointer-events:none;z-index:2147483647";
	document.documentElement.append(host);
	const root = host.attachShadow({ mode: "open" });
	const client = new MockChatClient({
		chats: CHATS,
		readability:
			params.get("page") === "unreadable" ? "unreadable" : "readable",
		connection:
			params.get("helper") === "missing" ? "helper_missing" : "connected",
		statusDelayMs: sceneName === "signin" ? 0 : 400,
		reply: (question) =>
			sceneName === "signin"
				? fixtureReply("not-signed-in-anthropic")
				: {
						status: ["starting"],
						run: retextRun(promptRun("stream"), question, CODE_REPLY),
					},
	});
	if (sceneName === "chip" || sceneName === "live") client.addQuote(SELECTION);
	mountChatWithStore(root, client, memoryWindowStore());
	await client.subscribed();
	await frame();
	await (scenes[sceneName] ?? scenes.live)?.(client, root);
	await frame();
	await frame();
	document.documentElement.dataset.ready = sceneName;
}

void main();
