import type { ChatState, ChatSummary, PiRpcRecord } from "freedia/protocol";
import type {
	ChatClient,
	ClientEvent,
	ClientListener,
	ConnectionState,
	ModelInfo,
	ModelRef,
	PageReadability,
	Quote,
} from "../../client/types";
import { asRecord, messageRole } from "../records";
import {
	type FixtureName,
	promptRun,
	responseData,
	type TimedRecord,
} from "./fixtures";

export interface MockReply {
	status: ChatState[];
	run: TimedRecord[];
}

export interface MockClientOptions {
	chatId?: string;
	models?: ModelInfo[];
	model?: ModelRef | null;
	chats?: ChatSummary[];
	messages?: Record<string, PiRpcRecord[]>;
	readability?: PageReadability;
	connection?: ConnectionState;
	reply?: (question: string) => MockReply | null;
	statusDelayMs?: number;
}

export interface MockCall {
	method: string;
	args: unknown[];
}

export function fixtureModels(): ModelInfo[] {
	const models = responseData("stream", "get_available_models").models;
	if (!Array.isArray(models)) return [];
	return models.flatMap((value) => {
		const model = asRecord(value);
		if (!model) return [];
		return [
			{
				provider: String(model.provider),
				modelId: String(model.id),
				name: String(model.name),
				contextWindow: Number(model.contextWindow),
			},
		];
	});
}

export function fixtureMessages(): PiRpcRecord[] {
	const messages = responseData("stream", "get_messages").messages;
	if (!Array.isArray(messages)) return [];
	return messages.flatMap((value) => {
		const message = asRecord(value);
		return message ? [{ ...message, type: "message" }] : [];
	});
}

export function fixtureReply(name: FixtureName): MockReply {
	return { status: ["starting"], run: promptRun(name) };
}

export class MockChatClient implements ChatClient {
	readonly calls: MockCall[] = [];
	private listeners = new Set<ClientListener>();
	private timers = new Set<ReturnType<typeof setTimeout>>();
	private chatId: string;
	private quoteList: Quote[] = [];
	private quoteCount = 0;
	private readabilityState: PageReadability;
	private connectionState: ConnectionState;
	private models: ModelInfo[];
	private model: ModelRef | null;
	private chats: ChatSummary[];
	private messages: Record<string, PiRpcRecord[]>;
	private reply: (question: string) => MockReply | null;
	private statusDelayMs: number;
	private stage: "idle" | "waiting" | "running" = "idle";
	private runCount = 0;
	private wake: (() => void) | null = null;
	private firstSubscriber = Promise.withResolvers<void>();

	constructor(options: MockClientOptions = {}) {
		this.chatId = options.chatId ?? crypto.randomUUID();
		this.models = options.models ?? fixtureModels();
		this.model =
			options.model === undefined ? (this.models[0] ?? null) : options.model;
		this.chats = options.chats ?? [];
		this.messages = options.messages ?? {};
		this.readabilityState = options.readability ?? "readable";
		this.connectionState = options.connection ?? "connected";
		this.reply = options.reply ?? (() => null);
		this.statusDelayMs = options.statusDelayMs ?? 400;
	}

	callsTo(method: string): unknown[][] {
		return this.calls
			.filter((call) => call.method === method)
			.map((call) => call.args);
	}

	emit(event: ClientEvent) {
		for (const listener of [...this.listeners]) listener(event);
	}

	emitRpc(rpc: PiRpcRecord, chatId = this.chatId) {
		this.emit({ type: "rpc", chatId, rpc });
	}

	play(run: TimedRecord[], chatId = this.chatId) {
		for (const { record } of run) this.emitRpc(record, chatId);
	}

	setReadability(readability: PageReadability) {
		this.readabilityState = readability;
		this.emit({ type: "page", readability });
	}

	setConnection(state: ConnectionState) {
		this.connectionState = state;
		this.emit({ type: "connection", state });
	}

	currentChatId() {
		return this.chatId;
	}

	quotes() {
		return this.quoteList;
	}

	pageReadability() {
		return this.readabilityState;
	}

	connection() {
		return this.connectionState;
	}

	private schedule(ms: number, fn: () => void) {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			fn();
		}, ms);
		this.timers.add(timer);
	}

	private delay(ms: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.schedule(ms, resolve);
		this.wake = resolve;
		return promise;
	}

	private cancelTimers() {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		this.stage = "idle";
		this.wake?.();
		this.wake = null;
	}

	async send(question: string) {
		this.calls.push({ method: "send", args: [question] });
		const reply = this.reply(question);
		if (!reply) {
			this.setQuotes([]);
			return;
		}
		const chatId = this.chatId;
		const run = ++this.runCount;
		this.stage = "waiting";
		for (const state of reply.status) {
			this.emit({ type: "status", chatId, state });
			await this.delay(this.statusDelayMs);
			if (run !== this.runCount || this.stage !== "waiting") return;
		}
		const response = reply.run.find(
			(entry) => entry.record.type === "response",
		);
		const start = response?.t ?? 0;
		if (response) this.emitRpc(response.record, chatId);
		if (response?.record.success === false) {
			this.stage = "idle";
			throw new Error(String(response.record.error));
		}
		this.stage = "running";
		const settled = reply.run.findLast(
			(entry) => entry.record.type === "agent_settled",
		);
		for (const entry of reply.run) {
			if (entry === response) continue;
			this.schedule(entry.t - start, () => {
				if (entry === settled) this.stage = "idle";
				this.emitRpc(entry.record, chatId);
			});
		}
		this.setQuotes([]);
	}

	async abort() {
		this.calls.push({ method: "abort", args: [] });
		const stage = this.stage;
		this.stage = "idle";
		this.cancelTimers();
		if (stage === "idle") return;
		if (stage === "running") {
			const end = promptRun("abort").find(
				(entry) =>
					entry.record.type === "message_end" &&
					messageRole(entry.record) === "assistant",
			);
			if (end) {
				this.emitRpc({
					...end.record,
					message: { ...asRecord(end.record.message), content: [] },
				});
			}
			this.emitRpc({ type: "agent_settled", aborted: true });
		}
		this.emitRpc({
			id: `abort-${this.runCount}`,
			type: "response",
			command: "abort",
			success: true,
		});
	}

	private setQuotes(quotes: Quote[]) {
		this.quoteList = quotes;
		this.emit({ type: "quotes_changed", quotes });
	}

	async newChat() {
		this.calls.push({ method: "newChat", args: [] });
		this.cancelTimers();
		this.chatId = crypto.randomUUID();
		this.emit({ type: "chat_changed", chatId: this.chatId });
		this.setQuotes([]);
		return this.chatId;
	}

	addQuote(text: string): Quote {
		this.quoteCount += 1;
		const quote = { id: `q${this.quoteCount}`, text };
		this.setQuotes([...this.quoteList, quote]);
		return quote;
	}

	removeQuote(id: string) {
		this.calls.push({ method: "removeQuote", args: [id] });
		this.setQuotes(this.quoteList.filter((quote) => quote.id !== id));
	}

	async listModels() {
		return this.models;
	}

	async currentModel() {
		return this.model;
	}

	async setModel(model: ModelRef) {
		this.calls.push({ method: "setModel", args: [model] });
		this.model = model;
	}

	async listChats() {
		this.calls.push({ method: "listChats", args: [] });
		return this.chats;
	}

	async openChat(chatId: string) {
		this.calls.push({ method: "openChat", args: [chatId] });
		this.cancelTimers();
		this.chatId = chatId;
		this.emit({ type: "chat_changed", chatId });
		return this.messages[chatId] ?? [];
	}

	async deleteChat(chatId: string) {
		this.calls.push({ method: "deleteChat", args: [chatId] });
		this.chats = this.chats.filter((chat) => chat.chatId !== chatId);
		if (chatId === this.chatId) {
			this.chatId = crypto.randomUUID();
			this.emit({ type: "chat_changed", chatId: this.chatId });
		}
	}

	subscribed(): Promise<void> {
		return this.firstSubscriber.promise;
	}

	subscribe(listener: ClientListener) {
		this.listeners.add(listener);
		this.firstSubscriber.resolve();
		return () => {
			this.listeners.delete(listener);
		};
	}
}
