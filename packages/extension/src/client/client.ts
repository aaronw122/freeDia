import type {
	ChatSummary,
	ExtensionToHelper,
	ForwardedRpcType,
	HelperToExtension,
	OmpRpcRecord,
} from "freedia/protocol";
import { MAX_PAGE_BYTES } from "freedia/protocol";
import type { TabToWorker, WorkerToTab } from "../lib/messages";
import {
	type KeyValueStore,
	loadPageRecord,
	removePageRecord,
	savePageRecord,
} from "../lib/store";
import { buildPrompt, planSend } from "../page/context";
import { excerptBudgetChars } from "../page/excerpt";
import { fingerprint, type PageSnapshot } from "../page/extract";
import type {
	ChatClient,
	ClientEvent,
	ClientListener,
	ConnectionState,
	ModelInfo,
	ModelRef,
	PageReadability,
	Quote,
} from "./types";

export interface WorkerPort {
	postMessage(message: TabToWorker): void;
	onMessage(listener: (message: WorkerToTab) => void): void;
	onDisconnect(listener: () => void): void;
}

export interface ClientDeps {
	connect(): WorkerPort;
	store: KeyValueStore;
	readPage(): PageSnapshot;
	now(): number;
	randomUUID(): string;
	setTimer(callback: () => void, ms: number): void;
}

const RECONNECT_MS = 1_000;

interface Pending {
	resolve(value: Record<string, unknown>): void;
	reject(error: Error): void;
}

interface OmpModel {
	id: string;
	name: string;
	provider: string;
	contextWindow: number;
}

function toModelInfo(model: OmpModel): ModelInfo {
	return {
		provider: model.provider,
		modelId: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
	};
}

export class RealChatClient implements ChatClient {
	private port: WorkerPort;
	private chatId = "";
	private connectionState: ConnectionState = "connecting";
	private connectionId = "";
	private quoteList: Quote[] = [];
	private readability: PageReadability;
	private model: ModelInfo | null = null;
	private modelChange: Promise<void> = Promise.resolve();
	private readonly preparing = new Set<{
		chatId: string;
		cancelled: boolean;
	}>();
	private readonly listeners = new Set<ClientListener>();
	private readonly pending = new Map<string, Pending>();
	private readonly chatWaiters: ((chatId: string) => void)[] = [];
	private readonly ready: Promise<void>;
	private readonly markReady: () => void;

	constructor(private readonly deps: ClientDeps) {
		this.readability = deps.readPage().readability;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.ready = promise;
		this.markReady = resolve;
		this.port = this.open();
	}

	currentChatId(): string {
		return this.chatId;
	}

	quotes(): Quote[] {
		return [...this.quoteList];
	}

	pageReadability(): PageReadability {
		return this.readability;
	}

	connection(): ConnectionState {
		return this.connectionState;
	}

	whenReady(): Promise<void> {
		return this.ready;
	}

	async send(question: string): Promise<void> {
		await this.ready;
		const preparing = { chatId: this.chatId, cancelled: false };
		this.preparing.add(preparing);
		try {
			await this.modelChange;
			await this.sendPrepared(preparing, question);
		} finally {
			this.preparing.delete(preparing);
		}
	}

	private async sendPrepared(
		preparing: { chatId: string; cancelled: boolean },
		question: string,
	): Promise<void> {
		const { chatId } = preparing;
		const page = this.deps.readPage();
		this.setReadability(page.readability);
		const quotes = this.quoteList.map((quote) => quote.text);
		const print =
			page.readability === "readable" ? await fingerprint(page.markdown) : null;
		const record = await loadPageRecord(this.deps.store, chatId);
		const plan = planSend({
			record,
			fingerprint: print,
			hasQuotes: quotes.length > 0,
			now: this.deps.now(),
			fileKey: this.connectionId,
		});
		const model = this.model ?? (await this.loadCurrentModel());
		const budget = excerptBudgetChars(model?.contextWindow ?? null);
		const putFile =
			plan.putFile &&
			new TextEncoder().encode(page.markdown).length <= MAX_PAGE_BYTES;
		if (putFile && !preparing.cancelled) {
			await this.command({
				type: "page.put",
				id: this.deps.randomUUID(),
				chatId,
				markdown: page.markdown,
			});
		}
		if (preparing.cancelled) {
			return;
		}
		const message = buildPrompt({
			page,
			quotes,
			question,
			excerpt: plan.excerpt,
			budget,
		});
		await this.rpc(chatId, { type: "prompt", message });
		await savePageRecord(this.deps.store, chatId, {
			fingerprint: print,
			sentAt: this.deps.now(),
			fileKey: putFile ? this.connectionId : (record?.fileKey ?? ""),
		});
		if (this.chatId === chatId) {
			this.setQuotes([]);
		}
	}

	async abort(): Promise<void> {
		await this.ready;
		for (const preparing of this.preparing) {
			if (preparing.chatId === this.chatId) {
				preparing.cancelled = true;
			}
		}
		await this.rpc(this.chatId, { type: "abort" });
	}

	async newChat(): Promise<string> {
		await this.ready;
		const chatId = await this.switchChat({ type: "tab.newChat" });
		this.setQuotes([]);
		return chatId;
	}

	addQuote(text: string): Quote {
		const quote = { id: this.deps.randomUUID(), text };
		this.setQuotes([...this.quoteList, quote]);
		return quote;
	}

	removeQuote(id: string): void {
		this.setQuotes(this.quoteList.filter((quote) => quote.id !== id));
	}

	async listModels(): Promise<ModelInfo[]> {
		await this.ready;
		const data = await this.rpc(this.chatId, { type: "get_available_models" });
		const models = (data.models ?? []) as OmpModel[];
		return models.map(toModelInfo);
	}

	async currentModel(): Promise<ModelRef | null> {
		await this.ready;
		const model = await this.loadCurrentModel();
		return model === null
			? null
			: { provider: model.provider, modelId: model.modelId };
	}

	setModel(model: ModelRef): Promise<void> {
		const change = this.modelChange.then(async () => {
			await this.ready;
			const data = await this.rpc(this.chatId, {
				type: "set_model",
				provider: model.provider,
				modelId: model.modelId,
			});
			this.model = toModelInfo(data as unknown as OmpModel);
		});
		this.modelChange = change.catch(() => undefined);
		return change;
	}

	async listChats(): Promise<ChatSummary[]> {
		await this.ready;
		const reply = await this.command({
			type: "chat.list",
			id: this.deps.randomUUID(),
		});
		return reply.chats as ChatSummary[];
	}

	async openChat(chatId: string): Promise<OmpRpcRecord[]> {
		await this.ready;
		if (chatId !== this.chatId) {
			await this.switchChat({ type: "tab.openChat", chatId });
		}
		const data = await this.rpc(chatId, { type: "get_messages" });
		return (data.messages ?? []) as OmpRpcRecord[];
	}

	async deleteChat(chatId: string): Promise<void> {
		await this.ready;
		await this.command({
			type: "chat.delete",
			id: this.deps.randomUUID(),
			chatId,
		});
		await removePageRecord(this.deps.store, chatId);
		if (chatId === this.chatId) {
			await this.newChat();
		}
	}

	subscribe(listener: ClientListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private open(): WorkerPort {
		const port = this.deps.connect();
		this.port = port;
		port.onMessage((message) => {
			if (this.port === port) {
				this.fromWorker(message);
			}
		});
		port.onDisconnect(() => {
			if (this.port !== port) {
				return;
			}
			this.failPending("freeDia lost its connection to the browser.");
			this.setConnection("connecting");
			this.deps.setTimer(() => {
				this.port = this.open();
			}, RECONNECT_MS);
		});
		port.postMessage({ type: "tab.hello" });
		return port;
	}

	private fromWorker(message: WorkerToTab): void {
		if (message.type === "tab.rejected") {
			this.settle(message.id, (pending) => {
				pending.reject(new Error(message.reason));
			});
			return;
		}
		if (message.type === "tab.state") {
			const chatChanged = message.chatId !== this.chatId;
			if (
				message.connectionId !== this.connectionId ||
				message.connection === "helper_missing"
			) {
				this.failPending(
					message.connection === "helper_missing"
						? "The freeDia helper is not installed."
						: "The freeDia helper disconnected.",
				);
			}
			this.chatId = message.chatId;
			this.connectionId = message.connectionId;
			if (chatChanged) {
				this.model = null;
				for (const waiter of this.chatWaiters.splice(0)) {
					waiter(message.chatId);
				}
				this.emit({ type: "chat_changed", chatId: message.chatId });
			}
			this.setConnection(message.connection);
			this.markReady();
			return;
		}
		this.fromHelper(message.message);
	}

	private fromHelper(message: HelperToExtension): void {
		if ("rpc" in message) {
			const rpc = message.rpc;
			if (rpc.type === "response" && typeof rpc.id === "string") {
				this.settle(rpc.id, (pending) => {
					if (rpc.success === false) {
						pending.reject(new Error(String(rpc.error ?? "Request failed")));
					} else {
						pending.resolve((rpc.data ?? {}) as Record<string, unknown>);
					}
				});
			}
			this.emit({ type: "rpc", chatId: message.chatId, rpc });
			return;
		}
		switch (message.type) {
			case "chat.status":
				this.emit({
					type: "status",
					chatId: message.chatId,
					state: message.state,
				});
				return;
			case "helper.error":
				if (message.id !== undefined) {
					this.settle(message.id, (pending) => {
						pending.reject(new Error(message.message));
					});
				}
				this.emit({ type: "helper_error", error: message });
				return;
			case "helper.chunk":
				return;
			default:
				this.settle(message.id, (pending) => {
					pending.resolve(message as unknown as Record<string, unknown>);
				});
		}
	}

	private settle(id: string, action: (pending: Pending) => void): void {
		const pending = this.pending.get(id);
		if (pending !== undefined) {
			this.pending.delete(id);
			action(pending);
		}
	}

	private failPending(reason: string): void {
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const entry of pending) {
			entry.reject(new Error(reason));
		}
	}

	private request(
		message: ExtensionToHelper,
		id: string,
	): Promise<Record<string, unknown>> {
		if (this.connectionState === "helper_missing") {
			return Promise.reject(new Error("The freeDia helper is not installed."));
		}
		const { promise, resolve, reject } =
			Promise.withResolvers<Record<string, unknown>>();
		this.pending.set(id, { resolve, reject });
		this.port.postMessage({ type: "helper", message });
		return promise;
	}

	private command(
		message: Exclude<ExtensionToHelper, { rpc: unknown }>,
	): Promise<Record<string, unknown>> {
		return this.request(message, message.id);
	}

	private rpc(
		chatId: string,
		rpc: { type: ForwardedRpcType; [key: string]: unknown },
	): Promise<Record<string, unknown>> {
		const id = this.deps.randomUUID();
		return this.request({ chatId, rpc: { ...rpc, id } }, id);
	}

	private async loadCurrentModel(): Promise<ModelInfo | null> {
		const chatId = this.chatId;
		const data = await this.rpc(chatId, { type: "get_state" });
		const model = data.model as OmpModel | undefined;
		if (model === undefined) {
			return null;
		}
		const info = toModelInfo(model);
		if (this.chatId === chatId) {
			this.model = info;
		}
		return info;
	}

	private switchChat(message: TabToWorker): Promise<string> {
		const { promise, resolve } = Promise.withResolvers<string>();
		this.chatWaiters.push(resolve);
		this.port.postMessage(message);
		return promise;
	}

	private setQuotes(quotes: Quote[]): void {
		this.quoteList = quotes;
		this.emit({ type: "quotes_changed", quotes: [...quotes] });
	}

	private setReadability(readability: PageReadability): void {
		if (readability !== this.readability) {
			this.readability = readability;
			this.emit({ type: "page", readability });
		}
	}

	private setConnection(state: ConnectionState): void {
		if (state !== this.connectionState) {
			this.connectionState = state;
			this.emit({ type: "connection", state });
		}
	}

	private emit(event: ClientEvent): void {
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}
}
