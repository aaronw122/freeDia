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
	type HelperError,
	type HelperErrorCode,
	type HelperToExtension,
	isEnvelope,
	isForwardedRpc,
	isHelperCommand,
	type PiRpcRecord,
} from "./protocol";

export const DEFAULT_MAX_CONCURRENT = 3;
export const PAGE_TTL_MS = 60 * 60 * 1000;
const TITLE_TIMEOUT_MS = 60_000;
const MODELS_TIMEOUT_MS = 30_000;
const STDERR_TAIL = 4000;
const INTERNAL_PREFIX = "freedia-internal-";

export const FIX_TEXT: Record<HelperErrorCode, string> = {
	pi_missing:
		"Run `bunx freedia install` in Terminal to reinstall the helper and pi.",
	not_signed_in: "Run `bunx freedia login` in Terminal and sign in.",
	spawn_failed: "Run `bunx freedia doctor` in Terminal to check the install.",
};

export interface Output {
	message(message: HelperToExtension): void;
	envelopeJson(chatId: string, rpcJson: string): void;
}

export interface Updater {
	maybeCheck(): Promise<void>;
	applyIfReady(): void;
}

export interface HelperOptions {
	paths: FreediaPaths;
	pi: PiConfig;
	output: Output;
	helperVersion: string;
	updater?: Updater;
	now?: () => number;
	log?: (line: string) => void;
}

interface ChatProcess {
	chatId: string;
	proc: PiProcess;
	pendingResponses: number;
	runActive: boolean;
	stdinClosed: boolean;
	stderrTail: string;
	firstCommandId: string | undefined;
	exited: Promise<void>;
}

interface QueuedPrompt {
	chatId: string;
	rpc: PiRpcRecord;
}

export class Helper {
	private readonly paths: FreediaPaths;
	private readonly pi: PiConfig;
	private readonly output: Output;
	private readonly helperVersion: string;
	private readonly updater: Updater | undefined;
	private readonly now: () => number;
	private readonly log: (line: string) => void;

	private maxConcurrent = DEFAULT_MAX_CONCURRENT;
	private readonly processes = new Map<string, ChatProcess>();
	private readonly slots = new Set<string>();
	private queue: QueuedPrompt[] = [];
	private readonly chains = new Map<string, Promise<void>>();
	private readonly pendingModels = new Map<string, string>();
	private lastChosenModel: string | undefined;
	private readonly readyProviders = new Set<string>();
	private models: Promise<PiRpcRecord | undefined> | undefined;
	private readonly titled = new Set<string>();
	private readonly pendingTitles = new Map<string, string>();
	private readonly jobs = new Set<Promise<void>>();
	private readonly starting = new Map<string, PiRpcRecord | undefined>();
	private readonly pageUse = new Map<string, number>();
	private shuttingDown = false;
	private idleWaiters: Array<() => void> = [];

	constructor(options: HelperOptions) {
		this.paths = options.paths;
		this.pi = options.pi;
		this.output = options.output;
		this.helperVersion = options.helperVersion;
		this.updater = options.updater;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => {});
		rmSync(this.paths.pages, { recursive: true, force: true });
		mkdirSync(this.paths.pages, { recursive: true });
	}

	handle(message: unknown): Promise<void> {
		if (this.shuttingDown) {
			return Promise.resolve();
		}
		if (isEnvelope(message)) {
			if (!isForwardedRpc(message.rpc)) {
				this.log(`dropped blocked rpc ${JSON.stringify(message.rpc.type)}`);
				return Promise.resolve();
			}
			const { chatId, rpc } = message;
			if (rpc.type === "abort") {
				if (this.dropQueued(chatId)) {
					this.checkIdle();
					this.reply(chatId, this.response(rpc, "abort", true));
					return Promise.resolve();
				}
				if (this.starting.has(chatId)) {
					this.starting.set(chatId, rpc);
					return Promise.resolve();
				}
			}
			if (
				rpc.type === "prompt" &&
				this.liveProcess(chatId)?.runActive !== true &&
				!this.starting.has(chatId)
			) {
				this.starting.set(chatId, undefined);
			}
			return this.inChain(chatId, () => this.forward(chatId, rpc));
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
					this.output.message({ type: "chat.delete", id, chatId });
				});
			}
			case "page.put":
				mkdirSync(this.paths.pages, { recursive: true });
				writeFileSync(pageFile(this.paths, message.chatId), message.markdown);
				this.pageUse.set(message.chatId, this.now());
				this.output.message({
					type: "page.put",
					id: message.id,
					chatId: message.chatId,
				});
				return Promise.resolve();
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

	private idle(): boolean {
		return (
			this.processes.size === 0 &&
			this.slots.size === 0 &&
			this.starting.size === 0 &&
			this.jobs.size === 0 &&
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
		if (!this.shuttingDown) {
			this.updater?.applyIfReady();
		}
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) {
			resolve();
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

	private async forward(chatId: string, rpc: PiRpcRecord): Promise<void> {
		this.pageUse.set(chatId, this.now());
		if (!piInstalled(this.paths)) {
			if (rpc.type === "prompt") {
				this.endStart(chatId);
			}
			this.output.message(this.error("pi_missing", { id: rpc.id, chatId }));
			return;
		}
		const live = this.liveProcess(chatId);
		switch (rpc.type) {
			case "abort":
				if (live === undefined) {
					this.reply(chatId, this.response(rpc, "abort", true));
					return;
				}
				this.send(live, rpc);
				return;
			case "get_available_models":
				if (live === undefined) {
					await this.answerModels(chatId, rpc);
					return;
				}
				this.send(live, rpc);
				return;
			case "prompt":
				await this.prompt(chatId, rpc);
				return;
			default: {
				const chat = live ?? (await this.spawnOrReport(chatId, rpc));
				if (chat !== undefined) {
					this.send(chat, rpc);
				}
			}
		}
	}

	private endStart(chatId: string): boolean {
		const abort = this.starting.get(chatId);
		this.starting.delete(chatId);
		if (abort === undefined) {
			return false;
		}
		this.reply(chatId, this.response(abort, "abort", true));
		return true;
	}

	private response(
		rpc: PiRpcRecord,
		command: string,
		success: boolean,
	): PiRpcRecord {
		return {
			...(rpc.id === undefined ? {} : { id: rpc.id }),
			type: "response",
			command,
			success,
		};
	}

	private liveProcess(chatId: string): ChatProcess | undefined {
		const chat = this.processes.get(chatId);
		return chat === undefined || chat.stdinClosed ? undefined : chat;
	}

	private dropQueued(chatId: string): boolean {
		const before = this.queue.length;
		this.queue = this.queue.filter((item) => item.chatId !== chatId);
		return this.queue.length !== before;
	}

	private async prompt(chatId: string, rpc: PiRpcRecord): Promise<void> {
		const live = this.liveProcess(chatId);
		if (live !== undefined && (live.runActive || this.slots.has(chatId))) {
			this.starting.delete(chatId);
			this.send(live, rpc);
			return;
		}
		if (live === undefined) {
			const provider = this.launchModel(chatId)?.split("/")[0];
			if (provider !== undefined && !this.readyProviders.has(provider)) {
				const auth = await authCheck(this.pi, provider);
				if (auth.status === "ready") {
					this.readyProviders.add(provider);
				} else if (auth.status === "not_ready" || auth.status === "invalid") {
					if (this.endStart(chatId)) {
						return;
					}
					this.output.message(
						this.error("not_signed_in", {
							id: rpc.id,
							chatId,
							message: `Not signed in to ${provider}.`,
							fix: `Run \`bunx freedia login\` in Terminal and sign in to ${provider}.`,
						}),
					);
					return;
				}
			}
		}
		if (this.starting.get(chatId) !== undefined) {
			this.endStart(chatId);
			return;
		}
		if (this.slots.size >= this.maxConcurrent) {
			this.starting.delete(chatId);
			this.queue.push({ chatId, rpc });
			this.output.message({ type: "chat.status", chatId, state: "queued" });
			return;
		}
		this.slots.add(chatId);
		await this.startPrompt(chatId, rpc);
	}

	private async startPrompt(chatId: string, rpc: PiRpcRecord): Promise<void> {
		let chat = this.liveProcess(chatId);
		if (chat === undefined) {
			this.output.message({ type: "chat.status", chatId, state: "starting" });
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
					message: `The helper could not start pi: ${error}`,
				}),
			);
			return undefined;
		}
	}

	private releaseSlot(chatId: string): void {
		if (this.slots.delete(chatId)) {
			this.drainQueue();
		}
	}

	private drainQueue(): void {
		while (this.slots.size < this.maxConcurrent && this.queue.length > 0) {
			const next = this.queue.shift() as QueuedPrompt;
			this.slots.add(next.chatId);
			this.starting.set(next.chatId, undefined);
			this.inChain(next.chatId, () => this.startPrompt(next.chatId, next.rpc));
		}
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
		const hadSession = sessionFiles(this.paths, chatId).length > 0;
		if (hadSession) {
			this.pendingModels.delete(chatId);
		}
		const model = hadSession ? undefined : this.launchModel(chatId);
		const proc = spawnPi(this.pi, chatLaunchArgs(this.pi, chatId, model));
		const chat: ChatProcess = {
			chatId,
			proc,
			pendingResponses: 0,
			runActive: false,
			stdinClosed: false,
			stderrTail: "",
			firstCommandId: undefined,
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
		chat.firstCommandId ??= rpc.id;
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
			typeof record.id === "string" && record.id.startsWith(INTERNAL_PREFIX);
		if (!internal) {
			this.output.envelopeJson(chat.chatId, line);
		}
		if (record.type === "response") {
			chat.pendingResponses = Math.max(0, chat.pendingResponses - 1);
			if (record.command === "prompt") {
				const data = record.data as { disposition?: unknown } | undefined;
				if (
					record.success === true &&
					(data?.disposition === "started" || data?.disposition === "queued")
				) {
					chat.runActive = true;
				} else if (!chat.runActive) {
					this.releaseSlot(chat.chatId);
				}
			}
			if (record.command === "set_model" && record.success === true) {
				this.rememberModel(chat.chatId, record.data);
			}
		} else if (record.type === "agent_start") {
			chat.runActive = true;
		} else if (record.type === "agent_settled") {
			chat.runActive = false;
			this.releaseSlot(chat.chatId);
			this.maybeTitle(chat.chatId);
		}
		this.closeIfIdle(chat);
	}

	private rememberModel(chatId: string, data: unknown): void {
		if (typeof data !== "object" || data === null) {
			return;
		}
		const { provider, id } = data as { provider?: unknown; id?: unknown };
		if (typeof provider !== "string" || typeof id !== "string") {
			return;
		}
		const model = `${provider}/${id}`;
		this.lastChosenModel = model;
		if (sessionFiles(this.paths, chatId).length === 0) {
			this.pendingModels.set(chatId, model);
		}
	}

	private onExit(chat: ChatProcess, code: number): void {
		if (this.processes.get(chat.chatId) === chat) {
			this.processes.delete(chat.chatId);
		}
		if (code !== 0 && (chat.pendingResponses > 0 || chat.runActive)) {
			this.output.message(
				this.error("spawn_failed", {
					id: chat.firstCommandId,
					chatId: chat.chatId,
					message:
						`pi exited with code ${code}. ${chat.stderrTail.trim()}`.trim(),
				}),
			);
		}
		this.releaseSlot(chat.chatId);
		const title = this.pendingTitles.get(chat.chatId);
		if (
			title !== undefined &&
			!this.queue.some((item) => item.chatId === chat.chatId)
		) {
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

	private async answerModels(chatId: string, rpc: PiRpcRecord): Promise<void> {
		this.models ??= runOneShot(
			this.pi,
			undefined,
			{ id: "models", type: "get_available_models" },
			(record) => record.type === "response",
			MODELS_TIMEOUT_MS,
		).then((records) =>
			records.find(
				(record) =>
					record.type === "response" &&
					record.command === "get_available_models" &&
					record.success === true,
			),
		);
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
		this.titled.add(chatId);
		if (session.name !== undefined || session.userMessages !== 1) {
			return;
		}
		this.track(this.makeTitle(chatId, session.firstPrompt, session.model));
	}

	private async makeTitle(
		chatId: string,
		firstPrompt: string,
		model: string | undefined,
	): Promise<void> {
		const pageTitle = pageTitleOf(firstPrompt);
		const message = [
			"Title this chat in 8 words or fewer. Reply with the title only, no quotes or punctuation at the end.",
			"",
			`Page title: ${pageTitle}`,
			`Question: ${questionOf(firstPrompt)}`,
		].join("\n");
		const records = await runOneShot(
			this.pi,
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
			return;
		}
		const title = cutWords(
			(messageText(reply.content).trim().split("\n")[0] ?? "")
				.replace(/^[#*\s"'“”]+|["'“”*\s.]+$/g, "")
				.trim(),
		);
		if (title === "" || sessionFiles(this.paths, chatId).length === 0) {
			return;
		}
		this.pendingTitles.set(chatId, title);
		const busy =
			this.processes.has(chatId) ||
			this.queue.some((item) => item.chatId === chatId);
		if (!busy) {
			await this.inChain(chatId, () => this.applyTitle(chatId));
		}
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
