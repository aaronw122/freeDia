import { describe, expect, test } from "bun:test";
import type { ExtensionToHelper } from "freedia/protocol";
import type { WorkerToTab } from "../lib/messages";
import { type MemoryStore, memoryStore, saveSettings } from "../lib/store";
import { type NativePort, Relay, type TabPort } from "./relay";

const CHAT_A = "11111111-1111-4111-8111-111111111111";
const CHAT_B = "22222222-2222-4222-8222-222222222222";

class FakeNative implements NativePort {
	sent: ExtensionToHelper[] = [];
	disconnected = false;
	private messageListeners: ((message: unknown) => void)[] = [];
	private disconnectListeners: ((error: string | null) => void)[] = [];
	postMessage(message: ExtensionToHelper) {
		this.sent.push(structuredClone(message));
	}
	onMessage(listener: (message: unknown) => void) {
		this.messageListeners.push(listener);
	}
	onDisconnect(listener: (error: string | null) => void) {
		this.disconnectListeners.push(listener);
	}
	disconnect() {
		this.disconnected = true;
	}
	emit(message: unknown) {
		for (const listener of this.messageListeners) {
			listener(structuredClone(message));
		}
	}
	drop(error: string | null) {
		for (const listener of this.disconnectListeners) {
			listener(error);
		}
	}
	answerHello() {
		const hello = this.sent.find(
			(m) => "type" in m && m.type === "helper.hello",
		);
		const id = hello !== undefined && "id" in hello ? hello.id : undefined;
		this.emit({
			type: "helper.hello",
			id,
			helperVersion: "0.1.0",
			piVersion: "1.3.0",
		});
	}
}

class FakeTab implements TabPort {
	received: WorkerToTab[] = [];
	private messageListeners: ((message: unknown) => void)[] = [];
	private disconnectListeners: (() => void)[] = [];
	constructor(readonly tabId: number) {}
	postMessage(message: WorkerToTab) {
		this.received.push(structuredClone(message));
	}
	onMessage(listener: (message: unknown) => void) {
		this.messageListeners.push(listener);
	}
	onDisconnect(listener: () => void) {
		this.disconnectListeners.push(listener);
	}
	send(message: unknown) {
		for (const listener of this.messageListeners) {
			listener(message);
		}
	}
	close() {
		for (const listener of this.disconnectListeners) {
			listener();
		}
	}
	helperMessages() {
		return this.received.flatMap((m) =>
			m.type === "helper" ? [m.message] : [],
		);
	}
	lastState() {
		return this.received.filter((m) => m.type === "tab.state").at(-1);
	}
}

async function flush() {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

function setup(store: MemoryStore = memoryStore()) {
	const natives: FakeNative[] = [];
	const timers: { callback: () => void; ms: number }[] = [];
	let counter = 0;
	if (!store.data.has("tabChats")) {
		store.data.set("tabChats", { "1": CHAT_A, "2": CHAT_B });
	}
	const relay = new Relay({
		connectNative: () => {
			const native = new FakeNative();
			natives.push(native);
			return native;
		},
		store,
		randomUUID: () =>
			`00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
		setTimer: (callback, ms) => {
			timers.push({ callback, ms });
		},
	});
	const native = () => {
		const last = natives.at(-1);
		if (last === undefined) {
			throw new Error("no native port");
		}
		return last;
	};
	return { relay, natives, native, timers, store };
}

async function openTab(relay: Relay, tabId: number) {
	const tab = new FakeTab(tabId);
	relay.attachTab(tab);
	tab.send({ type: "tab.hello" });
	await flush();
	return tab;
}

describe("relay", () => {
	test("hello carries the max concurrent setting and queued messages flush once answered", async () => {
		const store = memoryStore();
		await saveSettings(store, { maxConcurrent: 5 });
		const { relay, native } = setup(store);
		const tab = await openTab(relay, 1);
		expect(tab.lastState()).toMatchObject({
			chatId: CHAT_A,
			connection: "connecting",
		});
		tab.send({
			type: "helper",
			message: { chatId: CHAT_A, rpc: { type: "get_state", id: "r1" } },
		});
		await flush();
		expect(native().sent).toEqual([
			{ type: "helper.hello", id: expect.any(String), maxConcurrent: 5 },
		]);
		native().answerHello();
		expect(native().sent.at(-1)).toEqual({
			chatId: CHAT_A,
			rpc: { type: "get_state", id: "r1" },
		});
		expect(tab.lastState()).toMatchObject({ connection: "connected" });
	});

	test("routes each chat's events only to the tab showing it", async () => {
		const { relay, native } = setup();
		const tabA = await openTab(relay, 1);
		const tabB = await openTab(relay, 2);
		native().answerHello();
		tabA.send({
			type: "helper",
			message: {
				chatId: CHAT_A,
				rpc: { type: "prompt", id: "a1", message: "hi" },
			},
		});
		tabB.send({
			type: "helper",
			message: {
				chatId: CHAT_B,
				rpc: { type: "prompt", id: "b1", message: "yo" },
			},
		});
		native().emit({
			chatId: CHAT_A,
			rpc: { type: "message_update", delta: "A" },
		});
		native().emit({
			chatId: CHAT_B,
			rpc: { type: "message_update", delta: "B" },
		});
		native().emit({ type: "chat.status", chatId: CHAT_B, state: "queued" });
		native().emit({
			chatId: CHAT_A,
			rpc: { id: "a1", type: "response", command: "prompt", success: true },
		});
		expect(tabA.helperMessages()).toEqual([
			{ chatId: CHAT_A, rpc: { type: "message_update", delta: "A" } },
			{
				chatId: CHAT_A,
				rpc: { id: "a1", type: "response", command: "prompt", success: true },
			},
		]);
		expect(tabB.helperMessages()).toEqual([
			{ chatId: CHAT_B, rpc: { type: "message_update", delta: "B" } },
			{ type: "chat.status", chatId: CHAT_B, state: "queued" },
		]);
	});

	test("command replies go back to the tab that asked; pushes without a chat go to every tab", async () => {
		const { relay, native } = setup();
		const tabA = await openTab(relay, 1);
		const tabB = await openTab(relay, 2);
		native().answerHello();
		tabB.send({ type: "helper", message: { type: "chat.list", id: "list-1" } });
		native().emit({ type: "chat.list", id: "list-1", chats: [] });
		native().emit({
			type: "helper.error",
			code: "pi_missing",
			message: "pi is missing",
			fix: "Run bunx freedia install",
		});
		expect(tabA.helperMessages()).toEqual([
			{
				type: "helper.error",
				code: "pi_missing",
				message: "pi is missing",
				fix: "Run bunx freedia install",
			},
		]);
		expect(tabB.helperMessages()).toEqual([
			{ type: "chat.list", id: "list-1", chats: [] },
			{
				type: "helper.error",
				code: "pi_missing",
				message: "pi is missing",
				fix: "Run bunx freedia install",
			},
		]);
	});

	test("drops non-allowlisted rpc commands from tabs", async () => {
		const { relay, native } = setup();
		const tab = await openTab(relay, 1);
		native().answerHello();
		const before = native().sent.length;
		tab.send({
			type: "helper",
			message: { chatId: CHAT_A, rpc: { type: "bash", command: "ls" } },
		});
		tab.send({
			type: "helper",
			message: { type: "helper.hello", id: "x", maxConcurrent: 9 },
		});
		expect(native().sent).toHaveLength(before);
	});

	test("a new tab gets a UUID v4 chat and the tab → chat map survives a worker restart", async () => {
		const store = memoryStore();
		const first = setup(store);
		const tab = await openTab(first.relay, 7);
		const chatId = tab.lastState()?.chatId;
		expect(chatId).not.toBe(CHAT_A);
		expect(chatId).not.toBe(CHAT_B);
		const second = setup(store);
		const reopened = await openTab(second.relay, 7);
		expect(reopened.lastState()?.chatId).toBe(chatId);
	});

	test("new chat gives the tab a fresh UUID and clears the old chat's page file", async () => {
		const { relay, native } = setup();
		const tab = await openTab(relay, 1);
		native().answerHello();
		tab.send({ type: "tab.newChat" });
		await flush();
		const chatId = tab.lastState()?.chatId;
		expect(chatId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(chatId).not.toBe(CHAT_A);
		expect(native().sent.at(-1)).toMatchObject({
			type: "page.clear",
			chatId: CHAT_A,
		});
	});

	test("closing or navigating a tab mid-reply aborts that chat only", async () => {
		const { relay, native } = setup();
		const tabA = await openTab(relay, 1);
		const tabB = await openTab(relay, 2);
		native().answerHello();
		tabA.send({
			type: "helper",
			message: {
				chatId: CHAT_A,
				rpc: { type: "prompt", id: "a1", message: "hi" },
			},
		});
		tabB.send({
			type: "helper",
			message: {
				chatId: CHAT_B,
				rpc: { type: "prompt", id: "b1", message: "yo" },
			},
		});
		tabA.close();
		const aborts = native().sent.filter(
			(m) => "rpc" in m && m.rpc.type === "abort",
		);
		expect(aborts).toEqual([
			{ chatId: CHAT_A, rpc: { type: "abort", id: expect.any(String) } },
		]);
		expect(native().disconnected).toBe(false);
	});

	test("a finished chat is not aborted when its tab closes", async () => {
		const { relay, native } = setup();
		const tab = await openTab(relay, 1);
		native().answerHello();
		tab.send({
			type: "helper",
			message: {
				chatId: CHAT_A,
				rpc: { type: "prompt", id: "a1", message: "hi" },
			},
		});
		native().emit({
			chatId: CHAT_A,
			rpc: { type: "agent_settled", aborted: false },
		});
		tab.close();
		expect(
			native().sent.some((m) => "rpc" in m && m.rpc.type === "abort"),
		).toBe(false);
		expect(native().disconnected).toBe(true);
	});

	test("keeps the native port open while a chat runs with no tab, then closes it", async () => {
		const { relay, native } = setup();
		const tab = await openTab(relay, 1);
		native().answerHello();
		tab.send({
			type: "helper",
			message: {
				chatId: CHAT_A,
				rpc: { type: "prompt", id: "a1", message: "hi" },
			},
		});
		tab.close();
		expect(native().disconnected).toBe(false);
		native().emit({
			chatId: CHAT_A,
			rpc: { type: "agent_settled", aborted: true },
		});
		expect(native().disconnected).toBe(true);
	});

	test("a removed tab forgets its chat and clears its page file", async () => {
		const { relay, native, natives, store } = setup();
		const tab = await openTab(relay, 1);
		native().answerHello();
		await store.set(`page:${CHAT_A}`, {
			fingerprint: "x",
			sentAt: 1,
			fileKey: "k",
		});
		tab.close();
		await relay.tabRemoved(1);
		expect(await store.get("tabChats")).toEqual({ "2": CHAT_B });
		expect(await store.get(`page:${CHAT_A}`)).toBeUndefined();
		expect(natives).toHaveLength(2);
		native().answerHello();
		expect(native().sent.at(-1)).toMatchObject({
			type: "page.clear",
			chatId: CHAT_A,
		});
		expect(native().disconnected).toBe(true);
	});

	test("a missing native host reports helper_missing", async () => {
		const { relay, native } = setup();
		const tab = await openTab(relay, 1);
		native().drop("Specified native messaging host not found.");
		expect(tab.lastState()?.connection).toBe("helper_missing");
	});

	test("a dropped helper reconnects with backoff and says hello again", async () => {
		const { relay, natives, native, timers } = setup();
		const tab = await openTab(relay, 1);
		native().answerHello();
		native().drop("Native host has exited.");
		expect(tab.lastState()?.connection).toBe("connecting");
		expect(timers).toHaveLength(1);
		timers[0]?.callback();
		await flush();
		expect(natives).toHaveLength(2);
		expect(native().sent[0]).toMatchObject({ type: "helper.hello" });
		native().answerHello();
		expect(tab.lastState()?.connection).toBe("connected");
	});
});

describe("chunked helper messages", () => {
	function chunksOf(message: unknown, size: number, chatId?: string) {
		const bytes = new TextEncoder().encode(JSON.stringify(message));
		const slices: string[] = [];
		for (let i = 0; i < bytes.length; i += size) {
			slices.push(Buffer.from(bytes.subarray(i, i + size)).toString("base64"));
		}
		return slices.map((data, index) => ({
			type: "helper.chunk",
			...(chatId === undefined ? {} : { chatId }),
			chunkId: "33333333-3333-4333-8333-333333333333",
			index,
			count: slices.length,
			data,
		}));
	}

	const big = {
		chatId: CHAT_A,
		rpc: {
			id: "m1",
			type: "response",
			command: "get_messages",
			success: true,
			data: {
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "héllo 🌍 ".repeat(500) }],
					},
				],
			},
		},
	};

	test("reassemble to the identical record and route to the right tab", async () => {
		const { relay, native } = setup();
		const tabA = await openTab(relay, 1);
		const tabB = await openTab(relay, 2);
		native().answerHello();
		for (const chunk of chunksOf(big, 1000, CHAT_A)) {
			native().emit(chunk);
		}
		expect(tabA.helperMessages()).toEqual([big]);
		expect(tabB.helperMessages()).toEqual([]);
	});

	test("reassemble when chunks arrive out of order", async () => {
		const { relay, native } = setup();
		const tab = await openTab(relay, 1);
		native().answerHello();
		const chunks = chunksOf(big, 777, CHAT_A);
		expect(chunks.length).toBeGreaterThan(3);
		for (const chunk of [...chunks].reverse()) {
			native().emit(chunk);
		}
		expect(tab.helperMessages()).toEqual([big]);
	});

	test("a partial buffer is dropped when the helper disconnects", async () => {
		const { relay, native, timers } = setup();
		const tab = await openTab(relay, 1);
		native().answerHello();
		const chunks = chunksOf(big, 1000, CHAT_A);
		native().emit(chunks[0]);
		native().drop("Native host has exited.");
		timers[0]?.callback();
		await flush();
		native().answerHello();
		for (const chunk of chunks.slice(1)) {
			native().emit(chunk);
		}
		expect(tab.helperMessages()).toEqual([]);
	});
});
