import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";

interface FixtureLine {
	dir: "stdin" | "stdout" | "stderr" | "exit";
	record: Record<string, unknown> & { type?: string; id?: string };
}

export interface FakeOmpConfig {
	scripts?: Record<string, string[]>;
	defaultScript?: string;
	abortResponseDelayMs?: number;
	auth?: Record<string, string>;
	realTiming?: boolean;
	title?: string | null;
	exitAfterStdout?: number;
}

const home = process.env.HOME as string;
const fixtures = join(import.meta.dir, "fixtures", "pi");
const logFile = join(home, "fake-omp-log.jsonl");
const config: FakeOmpConfig = existsSync(join(home, "fake-omp.json"))
	? JSON.parse(readFileSync(join(home, "fake-omp.json"), "utf8"))
	: {};
const argv = process.argv.slice(2);

function log(entry: Record<string, unknown>): void {
	appendFileSync(
		logFile,
		`${JSON.stringify({ pid: process.pid, ...entry })}\n`,
	);
}

function flag(name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

let stdoutCount = 0;

function out(record: Record<string, unknown>): void {
	log({ event: "stdout", record });
	process.stdout.write(`${JSON.stringify(record)}\n`);
	stdoutCount++;
	if (
		config.exitAfterStdout !== undefined &&
		argv.includes("--mode") &&
		stdoutCount >= config.exitAfterStdout
	) {
		log({ event: "eof" });
		process.exit(0);
	}
}

if (argv[0] === "--version") {
	console.log("omp/18.12.1");
	process.exit(0);
}

if (argv.includes("-p")) {
	log({ event: "spawn", argv, env: { ...process.env }, cwd: process.cwd() });
	console.log(config.title ?? "Faux Title");
	process.exit(config.title === null ? 1 : 0);
}

log({
	event: "spawn",
	argv,
	env: { ...process.env },
	cwd: process.cwd(),
});

const sessionId = crypto.randomUUID();
let sessionDir: string | undefined;
const modelFlag = flag("--model");

function sessionFile(): string | undefined {
	if (sessionDir === undefined || !existsSync(sessionDir)) {
		return undefined;
	}
	const name = readdirSync(sessionDir).find((file) => file.endsWith(".jsonl"));
	return name === undefined ? undefined : join(sessionDir, name);
}

function appendEntry(entry: Record<string, unknown>): void {
	if (sessionDir === undefined) {
		return;
	}
	mkdirSync(sessionDir, { recursive: true });
	let file = sessionFile();
	const timestamp = new Date().toISOString();
	if (file === undefined) {
		file = join(
			sessionDir,
			`${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
		);
		appendFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd: process.cwd() })}\n`,
		);
		if (modelFlag !== undefined) {
			const [provider, modelId] = modelFlag.split("/");
			appendFileSync(
				file,
				`${JSON.stringify({ type: "model_change", timestamp, provider, modelId })}\n`,
			);
		}
	}
	appendFileSync(file, `${JSON.stringify({ timestamp, ...entry })}\n`);
}

function currentModel(): string {
	if (modelFlag !== undefined) {
		return modelFlag;
	}
	const file = sessionFile();
	let model = "unknown/unknown";
	if (file !== undefined) {
		for (const line of readFileSync(file, "utf8").trim().split("\n")) {
			const entry = JSON.parse(line);
			if (entry.type === "model_change") {
				model = `${entry.provider}/${entry.modelId}`;
			}
			if (entry.type === "message" && entry.message?.role === "assistant") {
				model = `${entry.message.provider}/${entry.message.model}`;
			}
		}
	}
	return model;
}

function loadScript(): FixtureLine[] {
	const chatId = sessionDir?.split("/").at(-1);
	const spawnsBefore = existsSync(logFile)
		? readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.filter(
					(entry) =>
						entry.event === "stdin" &&
						entry.record?.type === "open_session" &&
						entry.record?.sessionDir === sessionDir,
				).length
		: 0;
	const name =
		chatId === undefined
			? "stream"
			: (config.scripts?.[chatId]?.[Math.max(0, spawnsBefore - 1)] ??
				config.defaultScript ??
				"stream");
	return readFileSync(join(fixtures, `${name}.jsonl`), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

let script: FixtureLine[] = [];
let cursor = 0;

let lastPrompt: string | undefined;
let lastT: number | undefined;

async function emit(line: FixtureLine, id: string | undefined) {
	const t = (line as { t?: number }).t ?? 0;
	if (config.realTiming && lastT !== undefined && t > lastT) {
		await Bun.sleep(t - lastT);
	}
	lastT = t;
	let record = line.record;
	if (record.type === "agent_settled")
		record = { ...record, type: "session_settled" };
	const message = record.message;
	const role =
		message && typeof message === "object" && "role" in message
			? message.role
			: undefined;
	if (record.type === "response") {
		if (record.command === "abort" && config.abortResponseDelayMs) {
			await Bun.sleep(config.abortResponseDelayMs);
		}
		out({ ...record, ...(id === undefined ? {} : { id }) });
		return;
	}
	if (
		role === "user" &&
		lastPrompt !== undefined &&
		message &&
		typeof message === "object"
	) {
		record = {
			...record,
			message: { ...message, content: [{ type: "text", text: lastPrompt }] },
		};
	}
	if (
		record.type === "message_end" &&
		(role === "user" || role === "assistant")
	) {
		appendEntry({ type: "message", message: record.message });
	}
	out(record);
}

async function handle(command: FixtureLine["record"]): Promise<void> {
	if (command.type === "negotiate_protocol") {
		out({
			id: command.id,
			type: "response",
			command: "negotiate_protocol",
			success: true,
			data: { protocolVersion: 2 },
		});
		return;
	}
	if (
		command.type === "open_session" &&
		typeof command.sessionDir === "string"
	) {
		sessionDir = command.sessionDir;
		mkdirSync(sessionDir, { recursive: true });
		script = loadScript();
		log({
			event: "spawn",
			argv,
			env: { ...process.env },
			cwd: process.cwd(),
			record: command,
		});
		out({
			id: command.id,
			type: "response",
			command: "open_session",
			success: true,
			data: { resumed: sessionFile() !== undefined, sessionId },
		});
		return;
	}
	if (command.type === "get_login_providers") {
		const configured = config.auth ?? { faux: "ready" };
		out({
			id: command.id,
			type: "response",
			command: "get_login_providers",
			success: true,
			data: {
				providers: Object.entries(configured).map(([id, status]) => ({
					id,
					authenticated: status === "ready",
				})),
			},
		});
		return;
	}
	if (command.type === "get_available_models") {
		out({
			id: command.id,
			type: "response",
			command: "get_available_models",
			success: true,
			data: {
				models: [
					{ provider: "faux", id: "faux-1" },
					{ provider: "faux", id: "faux-2" },
				],
			},
		});
		return;
	}
	if (command.type === "prompt" && typeof command.message === "string") {
		lastPrompt = command.message;
		appendEntry({
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: command.message }],
			},
		});
	}
	if (command.type === "get_state") {
		const [provider, id] = (selectedModel ?? currentModel()).split("/");
		out({
			id: command.id,
			type: "response",
			command: "get_state",
			success: true,
			data: { model: { provider, id }, sessionId, isStreaming: false },
		});
		return;
	}
	if (command.type === "set_session_name") {
		appendEntry({ type: "session_info", name: command.name });
		out({ type: "session_info_changed", name: command.name });
		out({
			id: command.id,
			type: "response",
			command: "set_session_name",
			success: true,
		});
		return;
	}
	if (command.type === "set_model") {
		selectedModel = `${command.provider}/${command.modelId}`;
		if (sessionFile() !== undefined) {
			appendEntry({
				type: "model_change",
				provider: command.provider,
				modelId: command.modelId,
			});
		}
		out({
			id: command.id,
			type: "response",
			command: "set_model",
			success: true,
			data: { provider: command.provider, id: command.modelId },
		});
		return;
	}
	const start = script.findIndex(
		(line, index) =>
			index >= cursor &&
			line.dir === "stdin" &&
			line.record.type === command.type,
	);
	if (start < 0) {
		out({
			id: command.id,
			type: "response",
			command: command.type,
			success: true,
		});
		return;
	}
	cursor = start + 1;
	while (cursor < script.length && script[cursor]?.dir !== "stdin") {
		const line = script[cursor] as FixtureLine;
		cursor++;
		if (line.dir === "stdout") {
			await emit(line, command.id);
		}
	}
}

let selectedModel: string | undefined;
let rest = "";
let chain = Promise.resolve();
const decoder = new TextDecoder();
out({ type: "ready" });
for await (const chunk of process.stdin) {
	rest += decoder.decode(chunk, { stream: true });
	let index = rest.indexOf("\n");
	while (index >= 0) {
		const command = JSON.parse(rest.slice(0, index));
		rest = rest.slice(index + 1);
		log({ event: "stdin", record: command });
		chain = chain.then(() => handle(command));
		index = rest.indexOf("\n");
	}
}
log({ event: "eof" });
await chain;
process.exit(0);
