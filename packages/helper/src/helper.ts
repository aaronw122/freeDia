import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
	chatSessionState,
	cutWords,
	deleteSessionFiles,
	listChats,
	messageText,
	pageTitleOf,
	questionOf,
	sessionFiles,
} from "./chats";
import { splitLines } from "./framing";
import { type FreediaPaths, pageFile } from "./paths";
import {
	authCheck,
	chatLaunchArgs,
	type PiConfig,
	type PiProcess,
	piInstalled,
	piVersion,
	runOneShot,
	spawnPi,
} from "./pi";
import {
	type Envelope,
	type ForwardedRpc,
	type ForwardedRpcType,
	type HelperError,
	type HelperErrorCode,
	type HelperToExtension,
	isEnvelope,
	isForwardedRpc,
	isHelperCommand,
	MAX_EXTENSION_MESSAGE_BYTES,
	MAX_PAGE_BYTES,
	type PiRpcRecord,
} from "./protocol";

export const DEFAULT_MAX_CONCURRENT = 3;
export const PAGE_TTL_MS = 60 * 60 * 1000;
export const INTERNAL_PREFIX = "freedia-internal-";
const TITLE_TIMEOUT_MS = 60_000;
const MODELS_TIMEOUT_MS = 30_000;
const STDERR_TAIL = 4000;
const TITLE_SLOT = "title:";
const NO_API_KEY = "No API key found";

export const FIX_TEXT: Record<HelperErrorCode, string> = {
	pi_missing:
		"Run `bunx freedia install` in Terminal to reinstall the helper and pi.",
	not_signed_in: "Run `bunx freedia login` in Terminal and sign in.",
	spawn_failed: "Run `bunx freedia doctor` in Terminal to check the install.",
};

const RPC_FIELDS: Record<
	ForwardedRpcType,
	Record<string, "string" | "array">
> = {
	prompt: { message: "string", images: "array" },
	abort: {},
	set_model: { provider: "string", modelId: "string" },
	get_available_models: {},
	get_messages: {},
	get_state: {},
};

export function sanitizeRpc(rpc: ForwardedRpc): ForwardedRpc {
	const clean: ForwardedRpc = { type: rpc.type };
	if (typeof rpc.id === "string") {
		clean.id = rpc.id;
	}
	for (const [field, kind] of Object.entries(RPC_FIELDS[rpc.type])) {
		const value = rpc[field];
		if (kind === "string" ? typeof value === "string" : Array.isArray(value)) {
			clean[field] = value;
		}
	}
	return clean;
}

export interface Output {
	message(message: HelperToExtension): void;
	envelopeJson(chatId: string, rpcJson: string): void;
}

export interface Updater {
	maybeCheck(): Promise<void>;
	applyIfReady(): boolean;
}

export interface HelperOptions {
	paths: FreediaPaths;
	pi: PiConfig;
	output: Output;
	helperVersion: string;
	pinnedPiVersion: string;
	installPi: (version: string) => Promise<void>;
	afterUpdate?: () => Promise<void>;
	updater?: Updater;
	now?: () => number;
	log?: (line: string) => void;
}

interface ChatProcess {
	chatId: string;
	proc: PiProcess;
	provider: string | undefined;
	pendingResponses: number;
	userPending: Array<string | undefined>;
	runId: string | undefined;
	runActive: boolean;
	stdinClosed: boolean;
	stderrTail: string;
	exited: Promise<void>;
}

interface QueuedPrompt {
	chatId: string;
	rpc: ForwardedRpc;
}

export class Helper {
	private readonly paths: FreediaPaths;
	private readonly pi: PiConfig;
	private readonly output: Output;
	private readonly helperVersion: string;
	private pinnedPiVersion: string | undefined;
	private readonly installPi: (version: string) => Promise<void>;
	private readonly afterUpdate: (() => Promise<void>) | undefined;
	private readonly updater: Updater | undefined;
	private readonly now: () => number;
	private readonly log: (line: string) => void;

	private maxConcurrent = DEFAULT_MAX_CONCURRENT;
	private readonly processes = new Map<string, ChatProcess>();
	private readonly slots = new Set<string>();
	private queue: QueuedPrompt[] = [];
	private readonly starting = new Map<string, ForwardedRpc | undefined>();
	private readonly chains = new Map<string, Promise<void>>();
	private readonly pendingModels = new Map<string, string>();
	private lastChosenModel: string | undefined;
	private readonly checkedProviders = new Set<string>();
	private models: Promise<PiRpcRecord | undefined> | undefined;
	private piJob: Promise<void> | undefined;
	private readonly titled = new Set<string>();
	private titleBacklog: string[] = [];
	private readonly pendingTitles = new Map<string, string>();
	private readonly jobs = new Set<Promise<void>>();
	private readonly pageUse = new Map<string, number>();
	private shuttingDown = false;
	private idleWaiters: Array<() => void> = [];

	constructor(options: HelperOptions) {
		this.paths = options.paths;
		this.pi = options.pi;
		this.output = options.output;
		this.helperVersion = options.helperVersion;
		this.pinnedPiVersion = options.pinnedPiVersion;
		this.installPi = options.installPi;
		this.afterUpdate = options.afterUpdate;
		this.updater = options.updater;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => {});
		rmSync(this.paths.pages, { recursive: true, force: true });
		mkdirSync(this.paths.pages, { recursive: true });
		this.ensurePi().catch((error) => this.log(`pi sync failed: ${error}`));
	}

	handle(message: unknown): Promise<void> {
		if (this.shuttingDown) {
			return Promise.resolve();
		}
		if (isEnvelope(message)) {
			return this.handleRpc(message);
		}
		if (!isHelperCommand(message)) {
			this.log("dropped invalid message");
			return Promise.resolve();
		}
		switch (message.type) {
			case "helper.hello":
				this.maxConcurrent = message.maxConcurrent;
				this.output.message({
					type: "helper.hello",
					id: message.id,
					helperVersion: this.helperVersion,
					piVersion: piVersion(this.paths),
				});
				if (!piInstalled(this.paths)) {
					this.output.message(this.error("pi_missing"));
				}
				this.drainQueue();
				this.updater
					?.maybeCheck()
					.then(() => this.checkIdle())
					.catch((error) => this.log(`update check failed: ${error}`));
				return Promise.resolve();
			case "chat.list":
				this.output.message({
					type: "chat.list",
					id: message.id,
					chats: listChats(this.paths),
				});
				return Promise.resolve();
			case "chat.delete": {
				const { id, chatId } = message;
				return this.inChain(chatId, async () => {
					await this.stopChat(chatId);
					deleteSessionFiles(this.paths, chatId);
					this.removePage(chatId);
					this.pendingModels.delete(chatId);
					this.pendingTitles.delete(chatId);
					this.titleBacklog = this.titleBacklog.filter((c) => c !== chatId);
					this.output.message({ type: "chat.delete", id, chatId });
				});
			}
			case "page.put": {
				const { id, chatId, markdown } = message;
				const bytes = Buffer.byteLength(markdown);
				if (bytes > MAX_PAGE_BYTES) {
					this.removePage(chatId);
					this.output.message(
						this.error("spawn_failed", {
							id,
							chatId,
							message: `The page text is ${(bytes / 1024 / 1024).toFixed(1)} MB; the helper keeps at most 5 MB as the full-page file.`,
							fix: "Nothing to do: the chat keeps working from the page excerpt, without the full-page file.",
						}),
					);
					return Promise.resolve();
				}
				mkdirSync(this.paths.pages, { recursive: true });
				writeFileSync(pageFile(this.paths, chatId), markdown);
				this.pageUse.set(chatId, this.now());
				this.output.message({ type: "page.put", id, chatId });
				return Promise.resolve();
			}
			case "page.clear":
				this.removePage(message.chatId);
				this.output.message({
					type: "page.clear",
					id: message.id,
					chatId: message.chatId,
				});
				return Promise.resolve();
		}
	}

	rejectOversized(bytes: number): void {
		this.output.message(
			this.error("spawn_failed", {
				message: `A message from the extension was ${(bytes / 1024 / 1024).toFixed(1)} MB; the helper accepts at most ${MAX_EXTENSION_MESSAGE_BYTES / 1024 / 1024} MB.`,
				fix: "Try again with a shorter selection or message.",
			}),
		);
	}

	sweepPages(): void {
		const cutoff = this.now() - PAGE_TTL_MS;
		for (const [chatId, lastUse] of this.pageUse) {
			if (this.processes.has(chatId)) {
				this.pageUse.set(chatId, this.now());
			} else if (lastUse <= cutoff) {
				this.removePage(chatId);
			}
		}
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.queue = [];
		this.titleBacklog = [];
		await this.whenIdle();
		this.updater?.applyIfReady();
	}

	async whenIdle(): Promise<void> {
		while (!this.idle()) {
			await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
		}
	}

	runningChats(): string[] {
		return [...this.processes.keys()];
	}

	private handleRpc(message: Envelope): Promise<void> {
		const { chatId } = message;
		if (!isForwardedRpc(message.rpc)) {
			this.log(`dropped blocked rpc ${JSON.stringify(message.rpc.type)}`);
			return Promise.resolve();
		}
		const id = message.rpc.id;
		if (
			(id !== undefined && typeof id !== "string") ||
			(typeof id === "string" && id.startsWith(INTERNAL_PREFIX))
		) {
			this.log(`dropped rpc with reserved or invalid id ${JSON.stringify(id)}`);
			return Promise.resolve();
		}
		const rpc = sanitizeRpc(message.rpc);
		this.pageUse.set(chatId, this.now());
		if (rpc.type === "abort") {
			const running = this.liveProcess(chatId)?.runActive === true;
			if (this.dropQueued(chatId) && !running) {
				this.checkIdle();
				this.reply(chatId, this.response(rpc, "abort"));
				return Promise.resolve();
			}
			if (!running && this.starting.has(chatId)) {
				this.starting.set(chatId, rpc);
				return Promise.resolve();
			}
		}
		if (rpc.type === "prompt") {
			this.admitPrompt(chatId, rpc);
			return this.chains.get(chatId) ?? Promise.resolve();
		}
		return this.inChain(chatId, () => this.forward(chatId, rpc));
	}

	private admitPrompt(chatId: string, rpc: ForwardedRpc): void {
		const busy =
			this.slots.has(chatId) || this.liveProcess(chatId)?.runActive === true;
		if (busy) {
			this.inChain(chatId, () => this.promptBusyChat(chatId, rpc));
			return;
		}
		if (this.isQueued(chatId) || this.slots.size >= this.maxConcurrent) {
			this.queue.push({ chatId, rpc });
			this.output.message({ type: "chat.status", chatId, state: "queued" });
			return;
		}
		this.takeSlot(chatId, rpc);
	}

	private takeSlot(chatId: string, rpc: ForwardedRpc): void {
		this.slots.add(chatId);
		this.starting.set(chatId, undefined);
		this.output.message({ type: "chat.status", chatId, state: "starting" });
		this.inChain(chatId, () => this.startPrompt(chatId, rpc));
	}

	private async promptBusyChat(
		chatId: string,
		rpc: ForwardedRpc,
	): Promise<void> {
		const live = this.liveProcess(chatId);
		if (live !== undefined) {
			this.send(live, rpc);
			return;
		}
		this.admitPrompt(chatId, rpc);
	}

	private idle(): boolean {
		return (
			this.processes.size === 0 &&
			this.slots.size === 0 &&
			this.starting.size === 0 &&
			this.jobs.size === 0 &&
			this.piJob === undefined &&
			this.queue.length === 0
		);
	}

	private track(job: Promise<void>): void {
		const tracked = job
			.catch((error) => this.log(`${error}`))
			.finally(() => {
				this.jobs.delete(tracked);
				this.checkIdle();
			});
		this.jobs.add(tracked);
	}

	private checkIdle(): void {
		if (!this.idle()) {
			return;
		}
		if (!this.shuttingDown && this.updater?.applyIfReady() === true) {
			this.pinnedPiVersion = undefined;
			if (this.afterUpdate !== undefined && this.piJob === undefined) {
				this.piJob = this.afterUpdate();
				this.ensurePi().catch((error) =>
					this.log(`pi sync after update failed: ${error}`),
				);
			}
		}
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) {
			resolve();
		}
	}

	private async ensurePi(): Promise<void> {
		if (this.piJob === undefined) {
			const installed = piVersion(this.paths);
			if (
				installed === "" ||
				this.pinnedPiVersion === undefined ||
				installed === this.pinnedPiVersion
			) {
				return;
			}
			this.log(
				`pi ${installed} installed, helper pins ${this.pinnedPiVersion}`,
			);
			const pinned = this.pinnedPiVersion;
			this.piJob = this.installPi(pinned).then(() => {
				const now = piVersion(this.paths);
				if (now !== pinned) {
					throw new Error(
						`pi is ${now || "missing"} after installing ${pinned}`,
					);
				}
			});
		}
		const job = this.piJob;
		try {
			await job;
		} finally {
			if (this.piJob === job) {
				this.piJob = undefined;
				this.checkIdle();
			}
		}
	}

	private inChain(chatId: string, task: () => Promise<void>): Promise<void> {
		const next = (this.chains.get(chatId) ?? Promise.resolve())
			.then(task)
			.catch((error) => this.log(`chat ${chatId}: ${error}`));
		this.chains.set(chatId, next);
		return next;
	}

	private error(
		code: HelperErrorCode,
		extra: {
			id?: string | undefined;
			chatId?: string;
			message?: string;
			fix?: string;
		} = {},
	): HelperError {
		const message =
			extra.message ??
			(code === "pi_missing"
				? "pi is not installed in ~/.freedia/pi."
				: code === "not_signed_in"
					? "Not signed in to the selected provider."
					: "The helper could not start pi.");
		return {
			type: "helper.error",
			...(extra.id === undefined ? {} : { id: extra.id }),
			...(extra.chatId === undefined ? {} : { chatId: extra.chatId }),
			code,
			message,
			fix: extra.fix ?? FIX_TEXT[code],
		};
	}

	private reply(chatId: string, rpc: PiRpcRecord): void {
		const envelope: Envelope = { chatId, rpc };
		this.output.message(envelope);
	}

	private response(rpc: PiRpcRecord, command: string): PiRpcRecord {
		return {
			...(rpc.id === undefined ? {} : { id: rpc.id }),
			type: "response",
			command,
			success: true,
		};
	}

	private async forward(chatId: string, rpc: ForwardedRpc): Promise<void> {
		if (!piInstalled(this.paths)) {
			this.output.message(this.error("pi_missing", { id: rpc.id, chatId }));
			return;
		}
		const live = this.liveProcess(chatId);
		if (rpc.type === "abort" && live === undefined) {
			this.reply(chatId, this.response(rpc, "abort"));
			return;
		}
		if (
			rpc.type === "get_messages" &&
			live === undefined &&
			sessionFiles(this.paths, chatId).length === 0
		) {
			this.reply(chatId, {
				...this.response(rpc, "get_messages"),
				data: { messages: [] },
			});
			return;
		}
		if (rpc.type === "get_available_models" && live === undefined) {
			await this.answerModels(chatId, rpc);
			return;
		}
		const chat = live ?? (await this.spawnOrReport(chatId, rpc));
		if (chat !== undefined) {
			this.send(chat, rpc);
		}
	}

	private endStart(chatId: string): boolean {
		const abort = this.starting.get(chatId);
		this.starting.delete(chatId);
		if (abort === undefined) {
			return false;
		}
		this.reply(chatId, this.response(abort, "abort"));
		return true;
	}

	private liveProcess(chatId: string): ChatProcess | undefined {
		const chat = this.processes.get(chatId);
		return chat === undefined || chat.stdinClosed ? undefined : chat;
	}

	private isQueued(chatId: string): boolean {
		return this.queue.some((item) => item.chatId === chatId);
	}

	private dropQueued(chatId: string): boolean {
		const before = this.queue.length;
		this.queue = this.queue.filter((item) => item.chatId !== chatId);
		return this.queue.length !== before;
	}

	private async preflight(
		chatId: string,
		rpc: ForwardedRpc,
	): Promise<HelperError | undefined> {
		if (!piInstalled(this.paths)) {
			return this.error("pi_missing", { id: rpc.id, chatId });
		}
		const provider = this.launchModel(chatId)?.split("/")[0];
		if (provider === undefined || this.checkedProviders.has(provider)) {
			return undefined;
		}
		const auth = await authCheck(this.pi, provider);
		if (auth.status === "not_ready" || auth.status === "invalid") {
			return this.error("not_signed_in", {
				id: rpc.id,
				chatId,
				message: `Not signed in to ${provider}.`,
				fix: `Run \`bunx freedia login\` in Terminal and sign in to ${provider}.`,
			});
		}
		this.checkedProviders.add(provider);
		return undefined;
	}

	private async startPrompt(chatId: string, rpc: ForwardedRpc): Promise<void> {
		let chat = this.liveProcess(chatId);
		if (chat === undefined) {
			const problem = await this.preflight(chatId, rpc);
			if (problem !== undefined) {
				if (!this.endStart(chatId)) {
					this.output.message(problem);
				}
				this.releaseSlot(chatId);
				return;
			}
			chat = await this.spawnOrReport(chatId, rpc);
		}
		if (chat !== undefined && this.starting.get(chatId) !== undefined) {
			this.closeIfIdle(chat);
			await chat.exited;
		}
		if (this.endStart(chatId) || chat === undefined) {
			this.releaseSlot(chatId);
			return;
		}
		this.send(chat, rpc);
	}

	private async spawnOrReport(
		chatId: string,
		rpc: PiRpcRecord,
	): Promise<ChatProcess | undefined> {
		try {
			return await this.spawn(chatId);
		} catch (error) {
			this.output.message(
				this.error("spawn_failed", {
					id: rpc.id,
					chatId,
					message: `The helper could not start pi: ${error instanceof Error ? error.message : error}`,
				}),
			);
			return undefined;
		}
	}

	private releaseSlot(chatId: string): void {
		if (this.slots.delete(chatId)) {
			this.drainQueue();
		} else {
			this.checkIdle();
		}
	}

	private drainQueue(): void {
		while (
			this.slots.size < this.maxConcurrent &&
			this.queue.length > 0 &&
			!this.shuttingDown
		) {
			const next = this.queue.shift() as QueuedPrompt;
			if (this.slots.has(next.chatId)) {
				this.inChain(next.chatId, () =>
					this.promptBusyChat(next.chatId, next.rpc),
				);
			} else {
				this.takeSlot(next.chatId, next.rpc);
			}
		}
		this.pumpTitles();
		this.checkIdle();
	}

	private launchModel(chatId: string): string | undefined {
		const session = chatSessionState(this.paths, chatId);
		if (session !== undefined) {
			return session.model;
		}
		return (
			this.pendingModels.get(chatId) ??
			this.lastChosenModel ??
			this.pi.defaultModel
		);
	}

	private async spawn(chatId: string): Promise<ChatProcess> {
		const previous = this.processes.get(chatId);
		if (previous !== undefined) {
			await previous.exited;
		}
		try {
			await this.ensurePi();
		} catch (error) {
			throw new Error(
				`updating pi to ${this.pinnedPiVersion ?? "the helper's version"} failed (${error instanceof Error ? error.message : error})`,
			);
		}
		const hadSession = sessionFiles(this.paths, chatId).length > 0;
		if (hadSession) {
			this.pendingModels.delete(chatId);
		}
		const model = this.launchModel(chatId);
		const proc = spawnPi(
			this.pi,
			chatLaunchArgs(this.pi, chatId, hadSession ? undefined : model),
		);
		const chat: ChatProcess = {
			chatId,
			proc,
			provider: model?.split("/")[0],
			pendingResponses: 0,
			userPending: [],
			runId: undefined,
			runActive: false,
			stdinClosed: false,
			stderrTail: "",
			exited: Promise.resolve(),
		};
		this.processes.set(chatId, chat);
		const lines = splitLines((line) => this.onPiLine(chat, line));
		const reading = (async () => {
			for await (const chunk of proc.stdout) {
				lines.push(chunk);
			}
			lines.end();
		})();
		const stderr = (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of proc.stderr) {
				chat.stderrTail = (
					chat.stderrTail + decoder.decode(chunk, { stream: true })
				).slice(-STDERR_TAIL);
			}
		})();
		chat.exited = Promise.all([proc.exited, reading, stderr]).then(([code]) =>
			this.onExit(chat, code),
		);
		const title = this.pendingTitles.get(chatId);
		if (title !== undefined) {
			this.pendingTitles.delete(chatId);
			this.send(chat, {
				id: `${INTERNAL_PREFIX}title-${crypto.randomUUID()}`,
				type: "set_session_name",
				name: title,
			});
		}
		return chat;
	}

	private send(chat: ChatProcess, rpc: PiRpcRecord): void {
		chat.pendingResponses++;
		if (!(typeof rpc.id === "string" && rpc.id.startsWith(INTERNAL_PREFIX))) {
			chat.userPending.push(rpc.id);
		}
		try {
			chat.proc.stdin.write(`${JSON.stringify(rpc)}\n`);
			chat.proc.stdin.flush();
		} catch (error) {
			this.log(`write to pi failed: ${error}`);
		}
	}

	private closeIfIdle(chat: ChatProcess): void {
		if (chat.stdinClosed || chat.pendingResponses > 0 || chat.runActive) {
			return;
		}
		chat.stdinClosed = true;
		try {
			chat.proc.stdin.end();
		} catch {}
	}

	private onPiLine(chat: ChatProcess, line: string): void {
		let record: PiRpcRecord;
		try {
			record = JSON.parse(line);
		} catch {
			this.log(`unparseable pi output for ${chat.chatId}`);
			return;
		}
		const internal =
			(typeof record.id === "string" &&
				record.id.startsWith(INTERNAL_PREFIX)) ||
			record.type === "session_info_changed";
		if (!internal) {
			this.output.envelopeJson(chat.chatId, line);
		}
		if (record.type === "response") {
			this.onResponse(chat, record, internal);
		} else if (record.type === "agent_start") {
			chat.runActive = true;
		} else if (record.type === "agent_settled") {
			chat.runActive = false;
			chat.runId = undefined;
			this.releaseSlot(chat.chatId);
			this.maybeTitle(chat.chatId);
		}
		this.closeIfIdle(chat);
	}

	private onResponse(
		chat: ChatProcess,
		record: PiRpcRecord,
		internal: boolean,
	): void {
		chat.pendingResponses = Math.max(0, chat.pendingResponses - 1);
		if (!internal) {
			const index = chat.userPending.indexOf(record.id);
			chat.userPending.splice(index >= 0 ? index : 0, 1);
		}
		if (record.command === "prompt") {
			const data = record.data as { disposition?: unknown } | undefined;
			if (
				record.success === true &&
				(data?.disposition === "started" || data?.disposition === "queued")
			) {
				chat.runActive = true;
				chat.runId ??= record.id;
			} else {
				if (
					typeof record.error === "string" &&
					record.error.startsWith(NO_API_KEY) &&
					chat.provider !== undefined
				) {
					this.checkedProviders.delete(chat.provider);
				}
				if (!chat.runActive) {
					this.releaseSlot(chat.chatId);
				}
			}
		}
		if (record.command === "set_model" && record.success === true) {
			this.rememberModel(chat, record.data);
		}
	}

	private rememberModel(chat: ChatProcess, data: unknown): void {
		if (typeof data !== "object" || data === null) {
			return;
		}
		const { provider, id } = data as { provider?: unknown; id?: unknown };
		if (typeof provider !== "string" || typeof id !== "string") {
			return;
		}
		const model = `${provider}/${id}`;
		chat.provider = provider;
		this.lastChosenModel = model;
		if (sessionFiles(this.paths, chat.chatId).length === 0) {
			this.pendingModels.set(chat.chatId, model);
		}
	}

	private onExit(chat: ChatProcess, code: number): void {
		if (this.processes.get(chat.chatId) === chat) {
			this.processes.delete(chat.chatId);
		}
		if (chat.runActive || chat.userPending.length > 0) {
			const reason = chat.stderrTail.trim();
			this.output.message(
				this.error("spawn_failed", {
					id: chat.runId ?? chat.userPending[0],
					chatId: chat.chatId,
					message: `pi stopped unexpectedly (exit code ${code}) before finishing.${reason === "" ? "" : ` ${reason}`}`,
					fix: "Send the message again. If it keeps happening, run `bunx freedia doctor` in Terminal.",
				}),
			);
		}
		this.releaseSlot(chat.chatId);
		if (this.pendingTitles.has(chat.chatId) && !this.isQueued(chat.chatId)) {
			this.track(this.inChain(chat.chatId, () => this.applyTitle(chat.chatId)));
		}
		this.checkIdle();
	}

	private async stopChat(chatId: string): Promise<void> {
		if (this.dropQueued(chatId)) {
			this.checkIdle();
		}
		const chat = this.processes.get(chatId);
		if (chat === undefined) {
			return;
		}
		if (chat.runActive && !chat.stdinClosed) {
			this.send(chat, {
				id: `${INTERNAL_PREFIX}abort-${crypto.randomUUID()}`,
				type: "abort",
			});
		} else {
			this.closeIfIdle(chat);
		}
		await chat.exited;
	}

	private removePage(chatId: string): void {
		rmSync(pageFile(this.paths, chatId), { force: true });
		this.pageUse.delete(chatId);
	}

	private async oneShot(
		model: string | undefined,
		command: PiRpcRecord,
		until: (record: PiRpcRecord) => boolean,
		timeoutMs: number,
	): Promise<PiRpcRecord[]> {
		await this.ensurePi();
		return runOneShot(this.pi, model, command, until, timeoutMs);
	}

	private async answerModels(chatId: string, rpc: PiRpcRecord): Promise<void> {
		this.models ??= this.oneShot(
			undefined,
			{ id: "models", type: "get_available_models" },
			(record) => record.type === "response",
			MODELS_TIMEOUT_MS,
		)
			.then((records) =>
				records.find(
					(record) =>
						record.type === "response" &&
						record.command === "get_available_models" &&
						record.success === true,
				),
			)
			.catch((error) => {
				this.log(`model list failed: ${error}`);
				return undefined;
			});
		const cached = await this.models;
		if (cached === undefined) {
			this.models = undefined;
			this.output.message(this.error("spawn_failed", { id: rpc.id, chatId }));
			return;
		}
		const { id: _id, ...rest } = cached;
		this.reply(chatId, {
			...(rpc.id === undefined ? {} : { id: rpc.id }),
			...rest,
			type: "response",
		});
	}

	private maybeTitle(chatId: string): void {
		if (this.titled.has(chatId)) {
			return;
		}
		const session = chatSessionState(this.paths, chatId);
		if (session === undefined || session.firstPrompt === undefined) {
			return;
		}
		if (session.name !== undefined) {
			this.titled.add(chatId);
			return;
		}
		if (session.firstReplyTurn === undefined) {
			return;
		}
		this.titled.add(chatId);
		if (session.firstReplyTurn !== session.userMessages) {
			return;
		}
		this.titleBacklog.push(chatId);
		this.pumpTitles();
	}

	private pumpTitles(): void {
		while (
			this.slots.size < this.maxConcurrent &&
			this.queue.length === 0 &&
			this.titleBacklog.length > 0 &&
			!this.shuttingDown
		) {
			const chatId = this.titleBacklog.shift() as string;
			const slot = `${TITLE_SLOT}${chatId}`;
			this.slots.add(slot);
			this.track(
				this.runTitle(chatId).finally(() => {
					this.slots.delete(slot);
					this.drainQueue();
				}),
			);
		}
	}

	private async runTitle(chatId: string): Promise<void> {
		const session = chatSessionState(this.paths, chatId);
		if (
			session === undefined ||
			session.firstPrompt === undefined ||
			session.name !== undefined
		) {
			return;
		}
		const title = await this.makeTitle(session.firstPrompt, session.model);
		if (title === undefined || sessionFiles(this.paths, chatId).length === 0) {
			return;
		}
		this.pendingTitles.set(chatId, title);
		const busy =
			this.processes.has(chatId) ||
			this.slots.has(chatId) ||
			this.isQueued(chatId);
		if (!busy) {
			await this.inChain(chatId, () => this.applyTitle(chatId));
		}
	}

	private async makeTitle(
		firstPrompt: string,
		model: string | undefined,
	): Promise<string | undefined> {
		const message = [
			"Title this chat in 8 words or fewer. Reply with the title only, no quotes or punctuation at the end.",
			"",
			`Page title: ${pageTitleOf(firstPrompt)}`,
			`Question: ${questionOf(firstPrompt)}`,
		].join("\n");
		const records = await this.oneShot(
			model,
			{ id: "title", type: "prompt", message },
			(record) =>
				record.type === "agent_settled" ||
				(record.type === "response" && record.success === false),
			TITLE_TIMEOUT_MS,
		);
		const reply = records.findLast(
			(record) =>
				record.type === "message_end" &&
				(record.message as { role?: unknown } | undefined)?.role ===
					"assistant",
		)?.message as { content?: unknown; stopReason?: unknown } | undefined;
		if (reply === undefined || reply.stopReason !== "stop") {
			return undefined;
		}
		const title = cutWords(
			(messageText(reply.content).trim().split("\n")[0] ?? "")
				.replace(/^[#*\s"'“”]+|["'“”*\s.]+$/g, "")
				.trim(),
		);
		return title === "" ? undefined : title;
	}

	private async applyTitle(chatId: string): Promise<void> {
		if (
			!this.pendingTitles.has(chatId) ||
			this.liveProcess(chatId) !== undefined ||
			sessionFiles(this.paths, chatId).length === 0
		) {
			return;
		}
		const chat = await this.spawn(chatId);
		this.closeIfIdle(chat);
	}
}
