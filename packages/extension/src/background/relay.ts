import {
	type ExtensionToHelper,
	type HelperToExtension,
	isChatId,
	isEnvelope,
	isForwardedRpc,
	isHelperChunk,
	isHelperCommand,
} from "freedia/protocol";
import type { ConnectionState } from "../client/types";
import type { TabToWorker, WorkerToTab } from "../lib/messages";
import {
	type KeyValueStore,
	loadSettings,
	loadTabChats,
	removePageRecord,
	saveTabChats,
} from "../lib/store";
import { ChunkAssembler } from "./chunks";

export interface NativePort {
	postMessage(message: ExtensionToHelper): void;
	onMessage(listener: (message: unknown) => void): void;
	onDisconnect(listener: (error: string | null) => void): void;
	disconnect(): void;
}

export interface TabPort {
	tabId: number;
	postMessage(message: WorkerToTab): void;
	onMessage(listener: (message: unknown) => void): void;
	onDisconnect(listener: () => void): void;
}

export interface RelayDeps {
	connectNative(): NativePort;
	store: KeyValueStore;
	randomUUID(): string;
	setTimer(callback: () => void, ms: number): void;
}

const MISSING_HOST_ERROR = /not found|forbidden/i;
const MAX_EARLY_FAILURES = 3;
const MISSING_RETRY_MS = 5_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

interface TabEntry {
	port: TabPort;
	chatId: string;
}

export class Relay {
	private native: NativePort | null = null;
	private state: ConnectionState = "connecting";
	private connectionId = "";
	private helloId = "";
	private failures = 0;
	private retryPending = false;
	private readonly outbox: ExtensionToHelper[] = [];
	private readonly tabs = new Set<TabEntry>();
	private readonly requests = new Map<string, TabEntry>();
	private readonly running = new Set<string>();
	private readonly pendingPrompts = new Map<string, string>();
	private readonly chunks = new ChunkAssembler();
	private readonly connectionErrors: HelperToExtension[] = [];
	private readonly tabChats: Promise<Record<string, string>>;

	constructor(private readonly deps: RelayDeps) {
		this.tabChats = loadTabChats(deps.store);
	}

	attachTab(port: TabPort): void {
		const entry: TabEntry = { port, chatId: "" };
		port.onMessage((message) => {
			void this.fromTab(entry, message);
		});
		port.onDisconnect(() => {
			this.detachTab(entry);
		});
	}

	async tabRemoved(tabId: number): Promise<void> {
		const map = await this.tabChats;
		const chatId = map[String(tabId)];
		if (chatId === undefined) {
			return;
		}
		delete map[String(tabId)];
		await saveTabChats(this.deps.store, map);
		await this.releaseChat(chatId);
	}

	async browserStarted(): Promise<void> {
		const map = await this.tabChats;
		const attached = new Set(
			[...this.tabs].map((tab) => String(tab.port.tabId)),
		);
		for (const tabId of Object.keys(map)) {
			if (!attached.has(tabId)) {
				delete map[tabId];
			}
		}
		await saveTabChats(this.deps.store, map);
	}

	async settingsChanged(): Promise<void> {
		if (this.state === "connected") {
			await this.sendHello();
		}
	}

	private async fromTab(entry: TabEntry, raw: unknown): Promise<void> {
		if (typeof raw !== "object" || raw === null) {
			return;
		}
		const message = raw as TabToWorker;
		switch (message.type) {
			case "tab.hello":
				await this.hello(entry);
				return;
			case "tab.newChat":
				await this.assignChat(entry, this.deps.randomUUID());
				return;
			case "tab.openChat":
				if (isChatId(message.chatId)) {
					await this.assignChat(entry, message.chatId);
				}
				return;
			case "helper":
				this.forward(entry, message.message);
				return;
		}
	}

	private async hello(entry: TabEntry): Promise<void> {
		const map = await this.tabChats;
		const key = String(entry.port.tabId);
		let chatId = map[key];
		if (chatId === undefined) {
			chatId = this.deps.randomUUID();
			map[key] = chatId;
			await saveTabChats(this.deps.store, map);
		}
		entry.chatId = chatId;
		this.tabs.add(entry);
		this.postState(entry);
		for (const error of this.connectionErrors) {
			entry.port.postMessage({ type: "helper", message: error });
		}
		if (this.native === null && !this.retryPending) {
			this.connect();
		}
	}

	private async assignChat(entry: TabEntry, chatId: string): Promise<void> {
		const previous = entry.chatId;
		const map = await this.tabChats;
		map[String(entry.port.tabId)] = chatId;
		await saveTabChats(this.deps.store, map);
		entry.chatId = chatId;
		this.postState(entry);
		if (previous !== "" && previous !== chatId) {
			await this.releaseChat(previous);
		}
	}

	private async releaseChat(chatId: string): Promise<void> {
		const map = await this.tabChats;
		if (Object.values(map).includes(chatId)) {
			return;
		}
		this.abortIfRunning(chatId);
		this.send({ type: "page.clear", id: this.deps.randomUUID(), chatId });
		await removePageRecord(this.deps.store, chatId);
		this.closeIfIdle();
	}

	private abortIfRunning(chatId: string): void {
		const pending = [...this.pendingPrompts.values()].includes(chatId);
		if (!this.running.has(chatId) && !pending) {
			return;
		}
		this.send({ chatId, rpc: { type: "abort", id: this.deps.randomUUID() } });
	}

	private detachTab(entry: TabEntry): void {
		this.tabs.delete(entry);
		for (const [id, owner] of this.requests) {
			if (owner === entry) {
				this.requests.delete(id);
			}
		}
		const stillShown = [...this.tabs].some(
			(tab) => tab.chatId === entry.chatId,
		);
		if (!stillShown) {
			this.abortIfRunning(entry.chatId);
		}
		this.closeIfIdle();
	}

	private forward(entry: TabEntry, message: unknown): void {
		if (isEnvelope(message)) {
			if (!isForwardedRpc(message.rpc)) {
				return;
			}
			const id = typeof message.rpc.id === "string" ? message.rpc.id : null;
			if (message.chatId !== entry.chatId) {
				this.reject(entry, id, message.chatId);
				return;
			}
			if (id !== null) {
				this.requests.set(id, entry);
			}
			if (message.rpc.type === "prompt" && id !== null) {
				this.pendingPrompts.set(id, message.chatId);
			}
			this.send({ chatId: message.chatId, rpc: message.rpc });
			return;
		}
		if (!isHelperCommand(message) || message.type === "helper.hello") {
			return;
		}
		const ownChatOnly =
			message.type === "page.put" || message.type === "page.clear";
		if (ownChatOnly && message.chatId !== entry.chatId) {
			this.reject(entry, message.id, message.chatId);
			return;
		}
		this.requests.set(message.id, entry);
		this.send(message);
	}

	private reject(entry: TabEntry, id: string | null, chatId: string): void {
		if (id !== null) {
			entry.port.postMessage({
				type: "tab.rejected",
				id,
				reason: `This tab is not showing chat ${chatId}.`,
			});
		}
	}

	private send(message: ExtensionToHelper): void {
		if (this.native !== null && this.state === "connected") {
			this.native.postMessage(message);
			return;
		}
		if (this.state === "helper_missing") {
			return;
		}
		this.outbox.push(message);
		if (this.native === null && !this.retryPending) {
			this.connect();
		}
	}

	private connect(): void {
		this.connectionId = this.deps.randomUUID();
		this.connectionErrors.length = 0;
		if (this.state !== "helper_missing") {
			this.setState("connecting");
		}
		let port: NativePort;
		try {
			port = this.deps.connectNative();
		} catch (error) {
			this.handleDisconnect(String(error), false);
			return;
		}
		this.native = port;
		let ready = false;
		port.onMessage((message) => {
			if (this.native !== port) {
				return;
			}
			if (!ready) {
				const isHello =
					typeof message === "object" &&
					message !== null &&
					"type" in message &&
					message.type === "helper.hello" &&
					"id" in message &&
					message.id === this.helloId;
				if (!isHello) {
					return;
				}
				ready = true;
				this.failures = 0;
				this.setState("connected");
				for (const queued of this.outbox.splice(0)) {
					port.postMessage(queued);
				}
				this.closeIfIdle();
				return;
			}
			this.fromHelper(message);
		});
		port.onDisconnect((error) => {
			if (this.native !== port) {
				return;
			}
			this.native = null;
			this.handleDisconnect(error, ready);
		});
		void this.sendHello();
	}

	private async sendHello(): Promise<void> {
		const port = this.native;
		if (port === null) {
			return;
		}
		const { maxConcurrent } = await loadSettings(this.deps.store);
		this.helloId = this.deps.randomUUID();
		port.postMessage({ type: "helper.hello", id: this.helloId, maxConcurrent });
	}

	private handleDisconnect(error: string | null, wasReady: boolean): void {
		this.chunks.clear();
		this.requests.clear();
		this.running.clear();
		this.pendingPrompts.clear();
		this.failures = wasReady ? 1 : this.failures + 1;
		const missing =
			!wasReady &&
			((error !== null && MISSING_HOST_ERROR.test(error)) ||
				this.failures >= MAX_EARLY_FAILURES);
		if (missing) {
			this.outbox.length = 0;
		}
		this.setState(missing ? "helper_missing" : "connecting");
		if (this.tabs.size === 0) {
			this.outbox.length = 0;
			return;
		}
		this.retryPending = true;
		const delay = missing
			? MISSING_RETRY_MS
			: Math.min(
					RECONNECT_MAX_MS,
					RECONNECT_BASE_MS * 2 ** (this.failures - 1),
				);
		this.deps.setTimer(() => {
			this.retryPending = false;
			if (this.native === null && this.tabs.size > 0) {
				this.connect();
			}
		}, delay);
	}

	private closeIfIdle(): void {
		if (
			this.tabs.size > 0 ||
			this.running.size > 0 ||
			this.pendingPrompts.size > 0 ||
			this.outbox.length > 0 ||
			this.native === null
		) {
			return;
		}
		const port = this.native;
		this.native = null;
		this.chunks.clear();
		this.requests.clear();
		this.state = "connecting";
		port.disconnect();
	}

	private fromHelper(raw: unknown): void {
		const parsed = isHelperChunk(raw) ? this.chunks.accept(raw) : raw;
		if (typeof parsed !== "object" || parsed === null) {
			return;
		}
		const message = parsed as HelperToExtension;
		if (isEnvelope(message)) {
			this.trackRun(message.chatId, message.rpc);
			const owner =
				message.rpc.type === "response"
					? this.takeOwner(message.rpc.id)
					: undefined;
			this.deliver(message, message.chatId, owner);
			return;
		}
		if (message.type === "helper.hello") {
			return;
		}
		const owner = this.takeOwner("id" in message ? message.id : undefined);
		const chatId = "chatId" in message ? message.chatId : undefined;
		if (message.type === "helper.error" && message.id !== undefined) {
			this.pendingPrompts.delete(message.id);
		}
		if (message.type === "helper.error" && chatId !== undefined) {
			this.running.delete(chatId);
			for (const [id, pendingChat] of this.pendingPrompts) {
				if (pendingChat === chatId) {
					this.pendingPrompts.delete(id);
				}
			}
			this.closeIfIdle();
		}
		if (message.type === "chat.status" && chatId !== undefined) {
			this.running.add(chatId);
		}
		if (chatId !== undefined) {
			this.deliver(message, chatId, owner);
			return;
		}
		if (owner !== undefined) {
			owner.port.postMessage({ type: "helper", message });
			return;
		}
		if (message.type === "helper.error") {
			this.connectionErrors.push(message);
		}
		for (const tab of this.tabs) {
			tab.port.postMessage({ type: "helper", message });
		}
	}

	private takeOwner(id: string | undefined): TabEntry | undefined {
		if (id === undefined) {
			return undefined;
		}
		const owner = this.requests.get(id);
		this.requests.delete(id);
		return owner;
	}

	private trackRun(chatId: string, rpc: Record<string, unknown>): void {
		const id = typeof rpc.id === "string" ? rpc.id : null;
		if (rpc.type === "response" && rpc.command === "prompt" && id !== null) {
			const pending = this.pendingPrompts.get(id);
			this.pendingPrompts.delete(id);
			if (rpc.success === true) {
				if (pending !== undefined) {
					this.running.add(chatId);
				}
			} else {
				this.running.delete(chatId);
			}
			this.closeIfIdle();
			return;
		}
		const aborted =
			rpc.type === "response" &&
			rpc.command === "abort" &&
			rpc.success === true;
		if (rpc.type === "agent_settled" || aborted) {
			this.running.delete(chatId);
			this.closeIfIdle();
		}
	}

	private deliver(
		message: HelperToExtension,
		chatId: string,
		owner: TabEntry | undefined,
	): void {
		for (const tab of this.tabs) {
			if (tab === owner || tab.chatId === chatId) {
				tab.port.postMessage({ type: "helper", message });
			}
		}
	}

	private setState(state: ConnectionState): void {
		this.state = state;
		for (const tab of this.tabs) {
			this.postState(tab);
		}
	}

	private postState(entry: TabEntry): void {
		entry.port.postMessage({
			type: "tab.state",
			chatId: entry.chatId,
			connection: this.state,
			connectionId: this.connectionId,
		});
	}
}
