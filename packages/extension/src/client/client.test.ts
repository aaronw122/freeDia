import { describe, expect, test } from "bun:test";
import type { ExtensionToHelper, HelperToExtension } from "freedia/protocol";
import type { TabToWorker, WorkerToTab } from "../lib/messages";
import { memoryStore } from "../lib/store";
import { QUIET_MS } from "../page/context";
import type { PageSnapshot } from "../page/extract";
import { RealChatClient, type WorkerPort } from "./client";
import type { ClientEvent } from "./types";

const CHAT_A = "11111111-1111-4111-8111-111111111111";
const CHAT_B = "22222222-2222-4222-8222-222222222222";

type Rpc = { id: string; type: string; [key: string]: unknown };

class FakeWorker implements WorkerPort {
	sent: TabToWorker[] = [];
	connectionId = "conn-1";
	chatId = CHAT_A;
	models = [
		{
			id: "faux-1",
			name: "Faux One",
			provider: "faux",
			contextWindow: 128_000,
		},
	];
	private listeners: ((message: WorkerToTab) => void)[] = [];
	onPrompt: (rpc: Rpc) => void = (rpc) => this.reply(rpc, true);

	postMessage(message: TabToWorker) {
		this.sent.push(structuredClone(message));
		if (message.type === "tab.hello") {
			this.state();
		} else if (message.type === "tab.newChat") {
			this.chatId = CHAT_B;
			this.state();
		} else if (message.type === "tab.openChat") {
			this.chatId = message.chatId;
			this.state();
		} else {
			queueMicrotask(() => this.answer(message.message));
		}
	}
	onMessage(listener: (message: WorkerToTab) => void) {
		this.listeners.push(listener);
	}
	onDisconnect() {}

	state() {
		this.push({
			type: "tab.state",
			chatId: this.chatId,
			connection: "connected",
			connectionId: this.connectionId,
		});
	}
	push(message: WorkerToTab) {
		for (const listener of this.listeners) {
			listener(structuredClone(message));
		}
	}
	helper(message: HelperToExtension) {
		this.push({ type: "helper", message });
	}
	reply(rpc: Rpc, success: boolean, data?: unknown, error?: string) {
		this.helper({
			chatId: this.chatId,
			rpc: {
				id: rpc.id,
				type: "response",
				command: rpc.type,
				success,
				...(data === undefined ? {} : { data }),
				...(error === undefined ? {} : { error }),
			},
		});
	}
	answer(message: ExtensionToHelper) {
		if ("rpc" in message) {
			const rpc = message.rpc as Rpc;
			switch (rpc.type) {
				case "get_state":
					this.reply(rpc, true, { model: this.models[0] });
					return;
				case "get_available_models":
					this.reply(rpc, true, { models: this.models });
					return;
				case "get_messages":
					this.reply(rpc, true, {
						messages: [{ role: "user", content: "hi" }],
					});
					return;
				case "prompt":
					this.onPrompt(rpc);
					return;
				default:
					this.reply(
						rpc,
						true,
						rpc.type === "set_model"
							? { ...this.models[0], id: rpc.modelId }
							: undefined,
					);
					return;
			}
		}
		if (message.type === "chat.list") {
			this.helper({
				type: "chat.list",
				id: message.id,
				chats: [
					{ chatId: CHAT_A, title: "t", updatedAt: "2026-10-20T00:00:00.000Z" },
				],
			});
		} else if (
			message.type === "page.put" ||
			message.type === "page.clear" ||
			message.type === "chat.delete"
		) {
			this.helper({
				type: message.type,
				id: message.id,
				chatId: message.chatId,
			});
		}
	}
	helperSent(): ExtensionToHelper[] {
		return this.sent.flatMap((m) => (m.type === "helper" ? [m.message] : []));
	}
	prompts(): string[] {
		return this.helperSent().flatMap((m) =>
			"rpc" in m && m.rpc.type === "prompt" ? [String(m.rpc.message)] : [],
		);
	}
	pagePuts(): number {
		return this.helperSent().filter((m) => "type" in m && m.type === "page.put")
			.length;
	}
}

const LONG_PAGE = Array.from(
	{ length: 400 },
	(_, i) => `Paragraph ${i} ${"word ".repeat(38)}`,
).join("\n\n");

function setup(page: Partial<PageSnapshot> = {}) {
	const worker = new FakeWorker();
	const store = memoryStore();
	let now = 1_000_000;
	let current: PageSnapshot = {
		url: "https://example.com/a",
		title: "A",
		readability: "readable",
		markdown: LONG_PAGE,
		...page,
	};
	let ids = 0;
	const client = new RealChatClient({
		connect: () => worker,
		store,
		readPage: () => current,
		now: () => now,
		randomUUID: () => `id-${++ids}`,
		setTimer: () => {},
	});
	const events: ClientEvent[] = [];
	client.subscribe((event) => events.push(event));
	return {
		client,
		worker,
		store,
		events,
		advance: (ms: number) => {
			now += ms;
		},
		setPage: (patch: Partial<PageSnapshot>) => {
			current = { ...current, ...patch };
		},
	};
}

describe("chat client send", () => {
	test("first message sends the full excerpt and puts the page file", async () => {
		const { client, worker } = setup();
		await client.send("What is this?");
		expect(worker.pagePuts()).toBe(1);
		const [prompt] = worker.prompts();
		expect(prompt).toStartWith(
			"URL: https://example.com/a\nTitle: A\n\n## Page excerpt\n\nParagraph 0 ",
		);
		expect(prompt).toContain("Paragraph 399 ");
		expect(prompt).toEndWith("## Question\n\nWhat is this?");
	});

	test("the excerpt is sized to 10% of the model's context window", async () => {
		const { client, worker } = setup();
		await client.send("Q");
		const [prompt] = worker.prompts();
		const excerpt =
			prompt?.split("## Page excerpt\n\n")[1]?.split("\n\n## Question")[0] ??
			"";
		expect(excerpt.length).toBeGreaterThan(51_200 * 0.95);
		expect(excerpt.length).toBeLessThan(51_200 + 100);
	});

	test("a follow-up on the same page sends no excerpt and no file", async () => {
		const { client, worker } = setup();
		await client.send("one");
		await client.send("two");
		expect(worker.pagePuts()).toBe(1);
		expect(worker.prompts()[1]).toBe(
			"URL: https://example.com/a\nTitle: A\n\n## Question\n\ntwo",
		);
	});

	test("a new highlight on the same page sends the quote and only the window around it", async () => {
		const { client, worker, events } = setup();
		await client.send("one");
		client.addQuote("Paragraph 200 word");
		await client.send("two");
		const prompt = worker.prompts()[1] ?? "";
		expect(prompt).toContain("## Selected text\n\n> Paragraph 200 word");
		expect(prompt).toContain("## Page excerpt around the selected text\n\n[…");
		expect(prompt).not.toContain("Paragraph 0 ");
		expect(worker.pagePuts()).toBe(1);
		expect(client.quotes()).toEqual([]);
		expect(events.at(-1)).toEqual({ type: "quotes_changed", quotes: [] });
	});

	test("a changed page sends a full excerpt and a new file", async () => {
		const { client, worker, setPage } = setup();
		await client.send("one");
		setPage({
			url: "https://example.com/b",
			title: "B",
			markdown: "Totally different page.",
		});
		await client.send("two");
		expect(worker.pagePuts()).toBe(2);
		expect(worker.prompts()[1]).toContain(
			"## Page excerpt\n\nTotally different page.",
		);
	});

	test("after 30 quiet minutes the same page re-sends only the file", async () => {
		const { client, worker, advance } = setup();
		await client.send("one");
		advance(QUIET_MS);
		await client.send("two");
		expect(worker.pagePuts()).toBe(2);
		expect(worker.prompts()[1]).not.toContain("## Page excerpt");
	});

	test("after the helper reconnects the same page re-sends only the file", async () => {
		const { client, worker } = setup();
		await client.send("one");
		worker.connectionId = "conn-2";
		worker.state();
		await client.send("two");
		expect(worker.pagePuts()).toBe(2);
		expect(worker.prompts()[1]).not.toContain("## Page excerpt");
	});

	test("the page fingerprint is kept per chat in storage, surviving a new client", async () => {
		const first = setup();
		await first.client.send("one");
		const stored = await first.store.get(`page:${CHAT_A}`);
		expect(stored).toMatchObject({
			fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
			fileKey: "conn-1",
		});
	});

	test("an unreadable page sends no excerpt and no file, and emits a page event", async () => {
		const { client, worker, events, setPage } = setup();
		setPage({ readability: "unreadable", markdown: "" });
		client.addQuote("still quotable");
		await client.send("Q");
		expect(worker.pagePuts()).toBe(0);
		expect(worker.prompts()[0]).toBe(
			"URL: https://example.com/a\nTitle: A\n\n## Selected text\n\n> still quotable\n\nNo page text is available for this page.\n\n## Question\n\nQ",
		);
		expect(events).toContainEqual({ type: "page", readability: "unreadable" });
	});

	test("a rejected prompt rejects send with pi's error and keeps the quotes", async () => {
		const { client, worker } = setup();
		worker.onPrompt = (rpc) =>
			worker.reply(rpc, false, undefined, "Agent is already processing.");
		client.addQuote("keep me");
		await expect(client.send("Q")).rejects.toThrow(
			"Agent is already processing.",
		);
		expect(client.quotes().map((q) => q.text)).toEqual(["keep me"]);
	});
});

describe("chat client commands", () => {
	test("newChat switches to the worker's new chat and clears quotes", async () => {
		const { client, events } = setup();
		await client.listModels();
		client.addQuote("x");
		expect(await client.newChat()).toBe(CHAT_B);
		expect(client.currentChatId()).toBe(CHAT_B);
		expect(client.quotes()).toEqual([]);
		expect(events).toContainEqual({ type: "chat_changed", chatId: CHAT_B });
	});

	test("openChat switches chats and returns the session messages", async () => {
		const { client } = setup();
		const messages: unknown = await client.openChat(CHAT_B);
		expect(messages).toEqual([{ role: "user", content: "hi" }]);
		expect(client.currentChatId()).toBe(CHAT_B);
	});

	test("models come from pi with their context windows", async () => {
		const { client } = setup();
		expect(await client.listModels()).toEqual([
			{
				provider: "faux",
				modelId: "faux-1",
				name: "Faux One",
				contextWindow: 128_000,
			},
		]);
		expect(await client.currentModel()).toEqual({
			provider: "faux",
			modelId: "faux-1",
		});
	});

	test("listChats and deleteChat use the helper commands", async () => {
		const { client, worker } = setup();
		expect(await client.listChats()).toEqual([
			{ chatId: CHAT_A, title: "t", updatedAt: "2026-10-20T00:00:00.000Z" },
		]);
		await client.deleteChat(CHAT_A);
		expect(worker.helperSent()).toContainEqual({
			type: "chat.delete",
			id: expect.any(String),
			chatId: CHAT_A,
		});
		expect(client.currentChatId()).toBe(CHAT_B);
	});

	test("pi events and helper pushes are forwarded as client events", async () => {
		const { client, worker, events } = setup();
		await client.listModels();
		worker.helper({ chatId: CHAT_A, rpc: { type: "agent_start" } });
		worker.helper({ type: "chat.status", chatId: CHAT_A, state: "starting" });
		worker.helper({
			type: "helper.error",
			code: "pi_missing",
			message: "m",
			fix: "f",
		});
		expect(events).toContainEqual({
			type: "rpc",
			chatId: CHAT_A,
			rpc: { type: "agent_start" },
		});
		expect(events).toContainEqual({
			type: "status",
			chatId: CHAT_A,
			state: "starting",
		});
		expect(events).toContainEqual({
			type: "helper_error",
			error: {
				type: "helper.error",
				code: "pi_missing",
				message: "m",
				fix: "f",
			},
		});
	});

	test("helper_missing is reported and requests fail fast", async () => {
		const { client, worker, events } = setup();
		worker.push({
			type: "tab.state",
			chatId: CHAT_A,
			connection: "helper_missing",
			connectionId: "c",
		});
		expect(client.connection()).toBe("helper_missing");
		expect(events).toContainEqual({
			type: "connection",
			state: "helper_missing",
		});
		await expect(client.listChats()).rejects.toThrow("not installed");
	});
});
