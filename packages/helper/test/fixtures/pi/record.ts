import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Json = Record<string, unknown>;
type PiRecord = { type: string; id?: string; [key: string]: unknown };
type Line = {
	t: number;
	dir: "stdin" | "stdout" | "stderr" | "exit";
	record: unknown;
};

const home = homedir();
const piCli =
	process.env.FREEDIA_PI_CLI ??
	join(
		home,
		".freedia/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
	);
const fauxExtension =
	process.env.FREEDIA_FAUX_EXT ?? resolve(import.meta.dir, "faux-extension.ts");
const args = process.argv.slice(2);
const outDir =
	process.env.FREEDIA_FIXTURE_DIR ??
	(args.includes("--write-fixtures") ? resolve(import.meta.dir) : undefined);
const cwd = join(home, ".freedia");
const agentDir =
	process.env.PI_CODING_AGENT_DIR ?? join(home, ".freedia/pi-agent");
const sessionDir = mkdtempSync(join(tmpdir(), "freedia-s1-"));
const tmpRoot = tmpdir().replace(/\/$/, "");
const fixturesDir = resolve(import.meta.dir);
const results: Json = {
	runtime: process.execPath,
	bun: Bun.version,
	piCli,
	sessionDir,
};

function isPiRecord(value: unknown): value is PiRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string"
	);
}

class Pi {
	readonly lines: Line[] = [];
	readonly started = performance.now();
	readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	private waiters: {
		match: (r: PiRecord) => boolean;
		resolve: (r: PiRecord) => void;
	}[] = [];
	readonly exited: Promise<number>;

	constructor(
		args: string[],
		env: Record<string, string> = {},
		spawnCwd = cwd,
	) {
		const baseEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && !/_API_KEY$|_TOKEN$/.test(key))
				baseEnv[key] = value;
		}
		this.proc = Bun.spawn([process.execPath, piCli, "--mode", "rpc", ...args], {
			cwd: spawnCwd,
			env: {
				...baseEnv,
				BUN_BE_BUN: "1",
				PI_CODING_AGENT_DIR: agentDir,
				...env,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.pump(this.proc.stdout, "stdout");
		this.pump(this.proc.stderr, "stderr");
		this.exited = this.proc.exited.then((code) => {
			this.lines.push({ t: this.now(), dir: "exit", record: { code } });
			return code;
		});
	}

	now(): number {
		return Math.round(performance.now() - this.started);
	}

	private async pump(
		stream: ReadableStream<Uint8Array>,
		dir: "stdout" | "stderr",
	): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of stream) {
			buffer += decoder.decode(chunk, { stream: true });
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				const raw = buffer.slice(0, index).replace(/\r$/, "");
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
				if (dir === "stderr") {
					this.lines.push({ t: this.now(), dir, record: raw });
					continue;
				}
				const record: unknown = JSON.parse(raw);
				this.lines.push({ t: this.now(), dir, record });
				if (!isPiRecord(record)) continue;
				for (const waiter of [...this.waiters]) {
					if (waiter.match(record)) {
						this.waiters.splice(this.waiters.indexOf(waiter), 1);
						waiter.resolve(record);
					}
				}
			}
		}
		if (buffer && dir === "stderr")
			this.lines.push({ t: this.now(), dir, record: buffer });
	}

	send(command: Json): void {
		this.lines.push({ t: this.now(), dir: "stdin", record: command });
		this.proc.stdin.write(`${JSON.stringify(command)}\n`);
		this.proc.stdin.flush();
	}

	waitFor(
		match: (r: PiRecord) => boolean,
		timeoutMs = 20_000,
	): Promise<PiRecord> {
		for (const line of this.lines) {
			if (
				line.dir === "stdout" &&
				isPiRecord(line.record) &&
				match(line.record)
			) {
				return Promise.resolve(line.record);
			}
		}
		const { promise, resolve, reject } = Promise.withResolvers<PiRecord>();
		const timer = setTimeout(
			() => reject(new Error(`timeout waiting in ${this.proc.pid}`)),
			timeoutMs,
		);
		this.waiters.push({
			match,
			resolve: (record) => {
				clearTimeout(timer);
				resolve(record);
			},
		});
		return promise;
	}

	async request(command: Json): Promise<PiRecord> {
		const id = String(command.id);
		const pending = this.waitFor((r) => r.type === "response" && r.id === id);
		this.send(command);
		return pending;
	}

	settled(after = 0): Promise<PiRecord> {
		let seen = 0;
		return this.waitFor(
			(r) => r.type === "agent_settled" && ++seen > after,
			60_000,
		);
	}

	async close(): Promise<number> {
		this.proc.stdin.end();
		return this.exited;
	}

	save(name: string): void {
		if (!outDir) return;
		const scrubbed = this.lines.map((l) =>
			JSON.stringify(l)
				.replaceAll(sessionDir, "$TMP/freedia-s1")
				.replaceAll(`/private${tmpRoot}`, "$TMP")
				.replaceAll(tmpRoot, "$TMP")
				.replaceAll(fixturesDir, "$FIXTURES")
				.replaceAll(home, "$HOME")
				.replace(/req_[A-Za-z0-9]+/g, "req_PLACEHOLDER"),
		);
		writeFileSync(join(outDir, `${name}.jsonl`), `${scrubbed.join("\n")}\n`);
	}
}

const faux = [
	"--no-extensions",
	"-e",
	fauxExtension,
	"--offline",
	"--model",
	"faux/faux-1",
];
const readOnly = [
	"--tools",
	"read,grep,find,ls",
	"--no-skills",
	"--no-prompt-templates",
	"--no-context-files",
];
const chat = (id: string) => [
	"--session-dir",
	sessionDir,
	"--session-id",
	id,
	...faux,
	...readOnly,
];

function rssKb(pid: number): number {
	const out = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)])
		.stdout.toString()
		.trim();
	return Number(out);
}

async function streamAndState(): Promise<void> {
	const pi = new Pi(chat("c-stream-1"));
	await pi.request({ id: "r1", type: "get_state" });
	results.firstResponseMs = pi.now();
	const settled = pi.settled();
	await pi.request({ id: "r2", type: "prompt", message: "hello from freeDia" });
	await settled;
	await pi.request({ id: "r3", type: "get_messages" });
	await pi.request({ id: "r4", type: "get_available_models" });
	await pi.close();
	pi.save("stream");
}

async function toolsReadOnly(): Promise<void> {
	const target = join(cwd, "freedia-should-not-exist.txt");
	rmSync(target, { force: true });
	const pi = new Pi(chat("c-tools-1"));
	let settled = pi.settled();
	await pi.request({
		id: "r1",
		type: "prompt",
		message: "please [[write]] a file",
	});
	await settled;
	settled = pi.settled(1);
	await pi.request({
		id: "r2",
		type: "prompt",
		message: "list files [[read]]",
	});
	await settled;
	await pi.close();
	results.writeBlockedFileExists = existsSync(target);
	pi.save("tools-readonly");
}

async function bashCommand(): Promise<void> {
	const marker = join(cwd, "freedia-bash-marker.txt");
	rmSync(marker, { force: true });
	const pi = new Pi(chat("c-bash-1"));
	await pi.request({
		id: "r1",
		type: "bash",
		command: `echo bash-ran > ${marker}; echo done`,
	});
	await pi.close();
	results.rpcBashExecutedWithReadOnlyTools = existsSync(marker);
	rmSync(marker, { force: true });
	pi.save("bash-command");
}

async function abortMidReply(): Promise<void> {
	const id = "c-abort-1";
	const pi = new Pi(chat(id), { FREEDIA_FAUX_TPS: "40" });
	const firstDelta = pi.waitFor((r) => {
		const event = r.assistantMessageEvent;
		return (
			r.type === "message_update" &&
			typeof event === "object" &&
			event !== null &&
			"type" in event &&
			event.type === "text_delta"
		);
	});
	const settled = pi.settled();
	await pi.request({
		id: "r1",
		type: "prompt",
		message: "write something [[long]]",
	});
	await firstDelta;
	await Bun.sleep(400);
	results.rssWhileStreamingKb = rssKb(pi.proc.pid);
	await pi.request({ id: "r2", type: "abort" });
	await settled;
	await pi.request({ id: "r3", type: "get_messages" });
	await pi.close();
	pi.save("abort");
	const resumed = new Pi(chat(id));
	await resumed.request({ id: "r1", type: "get_messages" });
	const after = resumed.settled();
	await resumed.request({
		id: "r2",
		type: "prompt",
		message: "after abort [[recall]]",
	});
	await after;
	await resumed.close();
	resumed.save("abort-resume");
}

async function setModelMidSession(): Promise<void> {
	const pi = new Pi(chat("c-model-1"));
	let settled = pi.settled();
	await pi.request({ id: "r1", type: "prompt", message: "first on faux-1" });
	await settled;
	await pi.request({
		id: "r2",
		type: "set_model",
		provider: "faux",
		modelId: "faux-2",
	});
	await pi.request({
		id: "r3",
		type: "set_model",
		provider: "faux",
		modelId: "does-not-exist",
	});
	settled = pi.settled(1);
	await pi.request({
		id: "r4",
		type: "prompt",
		message: "second on faux-2 [[recall]]",
	});
	await settled;
	await pi.request({ id: "r5", type: "get_state" });
	await pi.close();
	pi.save("set-model");
}

async function modelOverrideOnResume(): Promise<void> {
	const id = "c-model-2";
	const resumeArgs = [
		"--session-dir",
		sessionDir,
		"--session-id",
		id,
		"--no-extensions",
		"-e",
		fauxExtension,
		"--offline",
		...readOnly,
	];
	const sessionFile = () =>
		join(
			sessionDir,
			readdirSync(sessionDir).find((f) => f.endsWith(`_${id}.jsonl`)) ?? "",
		);
	const modelChanges = async () =>
		(await Bun.file(sessionFile()).text())
			.split("\n")
			.filter((line) => line.includes('"type":"model_change"'))
			.map((line) => JSON.parse(line).modelId);
	const first = new Pi(chat(id));
	const s1 = first.settled();
	await first.request({ id: "r1", type: "prompt", message: "first on faux-1" });
	await s1;
	await first.request({
		id: "r2",
		type: "set_model",
		provider: "faux",
		modelId: "faux-2",
	});
	const modelOf = (state: PiRecord) =>
		JSON.stringify(state.data).match(/"model":\{"id":"([^"]+)"/)?.[1];
	const stateAfterSet = modelOf(
		await first.request({ id: "r3", type: "get_state" }),
	);
	await first.close();
	first.save("model-override-1-set-model");
	const afterSet = await modelChanges();
	const withFlag = new Pi(chat(id));
	const stateWithFlag = modelOf(
		await withFlag.request({ id: "r1", type: "get_state" }),
	);
	await withFlag.close();
	const afterFlagNoPrompt = await modelChanges();
	const probe = new Pi(resumeArgs);
	const stateNoFlagAfterFlagNoPrompt = modelOf(
		await probe.request({ id: "r1", type: "get_state" }),
	);
	await probe.close();
	const withFlagPrompt = new Pi(chat(id));
	await withFlagPrompt.request({ id: "r1", type: "get_state" });
	const s2 = withFlagPrompt.settled();
	await withFlagPrompt.request({
		id: "r2",
		type: "prompt",
		message: "resumed with --model [[recall]]",
	});
	await s2;
	await withFlagPrompt.close();
	withFlagPrompt.save("model-override-2-resume-with-model-flag");
	const afterFlagPrompt = await modelChanges();
	const withoutFlag = new Pi(resumeArgs);
	const stateWithoutFlag = modelOf(
		await withoutFlag.request({ id: "r1", type: "get_state" }),
	);
	const s3 = withoutFlag.settled();
	await withoutFlag.request({
		id: "r2",
		type: "prompt",
		message: "which model? [[recall]]",
	});
	await s3;
	await withoutFlag.close();
	withoutFlag.save("model-override-3-resume-without-flag");
	results.modelOverride = {
		stateAfterSet,
		stateNoFlagAfterFlagNoPrompt,
		afterSet,
		stateWithFlag,
		afterFlagNoPrompt,
		afterFlagPrompt,
		stateWithoutFlag,
		afterNoFlag: await modelChanges(),
	};
}

async function sessionIdLength(): Promise<void> {
	const outcome: Json = {};
	for (const length of [64, 224, 225, 300]) {
		const id = `c${"a".repeat(length - 1)}`;
		const pi = new Pi(chat(id));
		const state = await pi.request({ id: "r1", type: "get_state" });
		const reply = await Promise.race([
			pi.request({ id: "r2", type: "prompt", message: "hello" }),
			pi.exited.then((code) => ({ type: "exit", code })),
		]);
		await Promise.race([pi.settled(), pi.exited, Bun.sleep(3000)]);
		await pi.close().catch(() => undefined);
		const stderr = pi.lines
			.filter((l) => l.dir === "stderr")
			.map((l) => l.record);
		const errors = pi.lines
			.filter(
				(l) =>
					l.dir === "stdout" &&
					JSON.stringify(l.record).includes("ENAMETOOLONG"),
			)
			.map(
				(l) =>
					JSON.stringify(l.record).match(/.{0,120}ENAMETOOLONG.{0,80}/)?.[0],
			);
		outcome[length] = {
			stateOk: state.success,
			promptOk: "success" in reply ? reply.success : reply,
			fileWritten: readdirSync(sessionDir).some((f) =>
				f.endsWith(`_${id}.jsonl`),
			),
			stderr: stderr.filter(
				(s) =>
					typeof s === "string" && !s.startsWith("Warning: No project session"),
			),
			errors,
		};
		if (length === 300) pi.save("session-id-too-long");
	}
	results.sessionIdLength = outcome;
}

async function resumeAfterExit(): Promise<void> {
	const id = "c-resume-1";
	const first = new Pi(chat(id));
	const s1 = first.settled();
	await first.request({
		id: "r1",
		type: "prompt",
		message: "remember the word pineapple",
	});
	await s1;
	await first.close();
	first.save("resume-create");
	const second = new Pi(chat(id));
	await second.request({ id: "r1", type: "get_state" });
	const s2 = second.settled();
	await second.request({
		id: "r2",
		type: "prompt",
		message: "what word? [[recall]]",
	});
	await s2;
	await second.close();
	second.save("resume-continue");
}

async function rateLimit(): Promise<void> {
	const pi = new Pi(chat("c-ratelimit-1"));
	const settled = pi.settled();
	await pi.request({
		id: "r1",
		type: "prompt",
		message: "trigger [[ratelimit]]",
	});
	await settled;
	await pi.close();
	pi.save("rate-limit");
}

async function rateLimitAbort(): Promise<void> {
	const pi = new Pi(chat("c-ratelimit-2"));
	const retrying = pi.waitFor((r) => r.type === "auto_retry_start");
	const settled = pi.settled();
	await pi.request({
		id: "r1",
		type: "prompt",
		message: "trigger [[ratelimit]]",
	});
	await retrying;
	await pi.request({ id: "r2", type: "abort" });
	await settled;
	await pi.request({ id: "r3", type: "get_messages" });
	await pi.close();
	pi.save("rate-limit-abort");
}

async function providerRejected(): Promise<void> {
	const pi = new Pi(
		[
			"--session-dir",
			sessionDir,
			"--session-id",
			"c-badkey-1",
			"--no-extensions",
			"--model",
			"anthropic/claude-sonnet-4-5",
			...readOnly,
		],
		{ ANTHROPIC_API_KEY: "sk-ant-invalid-freedia-spike" },
	);
	const settled = pi.settled();
	await pi.request({ id: "r1", type: "prompt", message: "hello" });
	await settled;
	await pi.close();
	pi.save("provider-rejected-401");
}

async function busyPrompt(): Promise<void> {
	const pi = new Pi(chat("c-busy-1"), { FREEDIA_FAUX_TPS: "40" });
	const settled = pi.settled();
	await pi.request({ id: "r1", type: "prompt", message: "long [[long]]" });
	await pi.request({
		id: "r2",
		type: "prompt",
		message: "second while streaming",
	});
	await pi.request({ id: "r3", type: "abort" });
	await settled;
	await pi.close();
	pi.save("prompt-while-streaming");
}

async function notSignedIn(): Promise<void> {
	const noModel = new Pi([
		"--session-dir",
		sessionDir,
		"--session-id",
		"c-nosignin-1",
		"--offline",
		"--no-extensions",
		...readOnly,
	]);
	await noModel.request({ id: "r1", type: "get_state" });
	await noModel.request({ id: "r2", type: "get_available_models" });
	const s1 = noModel.waitFor(
		(r) =>
			r.type === "agent_settled" ||
			(r.type === "response" && r.id === "r3" && r.success === false),
		20_000,
	);
	noModel.send({ id: "r3", type: "prompt", message: "hello" });
	await s1;
	await noModel.close();
	noModel.save("not-signed-in-no-model");
	const explicit = new Pi([
		"--session-dir",
		sessionDir,
		"--session-id",
		"c-nosignin-2",
		"--offline",
		"--no-extensions",
		"--model",
		"anthropic/claude-sonnet-4-5",
		...readOnly,
	]);
	await explicit.request({ id: "r1", type: "get_state" });
	const s2 = explicit.waitFor(
		(r) =>
			r.type === "agent_settled" ||
			(r.type === "response" && r.id === "r2" && r.success === false),
		20_000,
	);
	explicit.send({ id: "r2", type: "prompt", message: "hello" });
	await s2;
	await explicit.close();
	explicit.save("not-signed-in-anthropic");
}

async function sessionIds(): Promise<void> {
	const candidates = [
		"c_01JABCDEF",
		"c-01JABCDEF",
		"c.01J",
		"01JABCDEFGHJKMNPQRSTVWXYZ0",
		"-lead",
		"trail-",
		"has space",
		"a/b",
		"ü-unicode",
	];
	const outcome: Json = {};
	for (const id of candidates) {
		const pi = new Pi([
			"--session-dir",
			sessionDir,
			"--session-id",
			id,
			...faux,
			...readOnly,
		]);
		const state = await Promise.race([
			pi.request({ id: "r1", type: "get_state" }),
			pi.exited.then((code) => ({ exit: code })),
		]);
		await pi.close();
		const stderr = pi.lines
			.filter((l) => l.dir === "stderr")
			.map((l) => l.record);
		const data = "data" in state ? state.data : undefined;
		outcome[id] =
			typeof data === "object" &&
			data !== null &&
			"sessionId" in data &&
			"sessionFile" in data
				? { sessionId: data.sessionId, sessionFile: data.sessionFile }
				: { ...state, stderr };
	}
	results.sessionIds = outcome;
}

async function longSessionRespawn(): Promise<void> {
	const id = "c-long-1";
	const pi = new Pi(chat(id), { FREEDIA_FAUX_TPS: "0" });
	const turns = Number(process.env.FREEDIA_LONG_TURNS ?? 200);
	for (let i = 0; i < turns; i++) {
		const settled = pi.settled(i);
		await pi.request({
			id: `p${i}`,
			type: "prompt",
			message: `turn ${i} [[long]] ${"page text ".repeat(800)}`,
		});
		await settled;
	}
	await pi.close();
	const files = readdirSync(sessionDir).filter((f) => f.includes(id));
	const size = files.length
		? Bun.file(join(sessionDir, files[0] ?? "")).size
		: 0;
	const timings: Json[] = [];
	for (let run = 0; run < 3; run++) {
		const resumed = new Pi(chat(id));
		await resumed.request({ id: "r1", type: "get_state" });
		const stateMs = resumed.now();
		await resumed.request({ id: "r2", type: "get_messages" });
		const messagesMs = resumed.now();
		const rss = rssKb(resumed.proc.pid);
		await resumed.close();
		timings.push({ stateMs, messagesMs, idleRssKb: rss });
	}
	results.longSession = { turns, fileBytes: size, timings };
}

async function emptyRespawn(): Promise<void> {
	const timings: number[] = [];
	for (let run = 0; run < 3; run++) {
		const pi = new Pi(chat(`c-empty-${run}`));
		await pi.request({ id: "r1", type: "get_state" });
		timings.push(pi.now());
		await pi.close();
	}
	results.emptyRespawnTimings = timings;
}

async function sessionName(): Promise<void> {
	const id = "c-name-1";
	const pi = new Pi(chat(id));
	const settled = pi.settled();
	await pi.request({
		id: "r1",
		type: "prompt",
		message:
			"URL: https://example.com\nTitle: Example Domain\n\nWhat is this page?",
	});
	await settled;
	await pi.request({
		id: "r2",
		type: "set_session_name",
		name: "Example Domain",
	});
	await pi.request({ id: "r3", type: "get_state" });
	await pi.close();
	pi.save("session-name");
}

async function crossCwdResume(): Promise<void> {
	const id = "c-cwd-1";
	const first = new Pi(chat(id));
	const s1 = first.settled();
	await first.request({
		id: "r1",
		type: "prompt",
		message: "created from ~/.freedia",
	});
	await s1;
	await first.close();
	const other = new Pi(chat(id), {}, tmpdir());
	await other.request({ id: "r1", type: "get_state" });
	await other.request({ id: "r2", type: "get_messages" });
	await other.close();
	other.save("resume-other-cwd");
	results.crossCwdFiles = readdirSync(sessionDir).filter((f) => f.includes(id));
}

const scenarios: Record<string, () => Promise<void>> = {
	sessionName,
	crossCwdResume,
	streamAndState,
	toolsReadOnly,
	bashCommand,
	abortMidReply,
	setModelMidSession,
	modelOverrideOnResume,
	sessionIdLength,
	resumeAfterExit,
	rateLimit,
	rateLimitAbort,
	providerRejected,
	busyPrompt,
	notSignedIn,
	sessionIds,
	emptyRespawn,
	longSessionRespawn,
};

if (outDir) mkdirSync(outDir, { recursive: true });
const only = args.filter((arg) => !arg.startsWith("--"));
try {
	for (const [name, run] of Object.entries(scenarios)) {
		if (only.length && !only.includes(name)) continue;
		const started = performance.now();
		try {
			await run();
			results[`${name}Ms`] = Math.round(performance.now() - started);
		} catch (error) {
			results[`${name}Error`] = String(error);
		}
	}
	results.sessionFiles = readdirSync(sessionDir, { recursive: true });
	results.fixturesWritten =
		outDir ?? "none (pass --write-fixtures or FREEDIA_FIXTURE_DIR)";
	console.log(JSON.stringify(results, null, 2));
} finally {
	rmSync(sessionDir, { recursive: true, force: true });
}
