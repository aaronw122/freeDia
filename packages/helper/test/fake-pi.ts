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

export interface FakePiConfig {
	scripts?: Record<string, string[]>;
	defaultScript?: string;
	abortResponseDelayMs?: number;
	auth?: Record<string, string>;
	realTiming?: boolean;
	title?: string | null;
}

const home = process.env.HOME as string;
const fixtures = join(import.meta.dir, "fixtures", "pi");
const logFile = join(home, "fake-pi-log.jsonl");
const config: FakePiConfig = existsSync(join(home, "fake-pi.json"))
	? JSON.parse(readFileSync(join(home, "fake-pi.json"), "utf8"))
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

function out(record: Record<string, unknown>): void {
	log({ event: "stdout", record });
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

if (argv[0] === "--version") {
	console.log("1.3.0");
	process.exit(0);
}

if (argv[0] === "auth") {
	const provider = flag("--provider") ?? "";
	const status = config.auth?.[provider];
	console.log(
		JSON.stringify(
			status === undefined
				? { status: "not_ready", provider, reason: "provider_not_found" }
				: { status, provider },
		),
	);
	process.exit(status === "ready" ? 0 : 1);
}

log({
	event: "spawn",
	argv,
	env: { ...process.env },
	cwd: process.cwd(),
});

const sessionId = flag("--session-id");
const sessionDir = flag("--session-dir");
const modelFlag = flag("--model");

function sessionFile(): string | undefined {
	if (
		sessionId === undefined ||
		sessionDir === undefined ||
		!existsSync(sessionDir)
	) {
		return undefined;
	}
	const name = readdirSync(sessionDir).find((file) =>
		file.endsWith(`_${sessionId}.jsonl`),
	);
	return name === undefined ? undefined : join(sessionDir, name);
}

function appendEntry(entry: Record<string, unknown>): void {
	if (sessionId === undefined || sessionDir === undefined) {
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
	const spawnsBefore = existsSync(logFile)
		? readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.filter(
					(entry) =>
						entry.event === "spawn" &&
						entry.pid !== process.pid &&
						entry.argv.includes(sessionId ?? "--no-session"),
				).length
		: 0;
	const name =
		sessionId === undefined
			? "stream"
			: (config.scripts?.[sessionId]?.[spawnsBefore] ??
				config.defaultScript ??
				"stream");
	return readFileSync(join(fixtures, `${name}.jsonl`), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

const script = loadScript();
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
	const message = record.message as { role?: string } | undefined;
	if (record.type === "response") {
		if (record.command === "abort" && config.abortResponseDelayMs) {
			await Bun.sleep(config.abortResponseDelayMs);
		}
		out({ ...record, ...(id === undefined ? {} : { id }) });
		return;
	}
	if (message?.role === "user" && lastPrompt !== undefined) {
		record = {
			...record,
			message: { ...message, content: [{ type: "text", text: lastPrompt }] },
		};
	}
	if (
		record.type === "message_end" &&
		(message?.role === "user" || message?.role === "assistant")
	) {
		appendEntry({ type: "message", message: record.message });
	}
	out(record);
}

async function oneShot(command: FixtureLine["record"]): Promise<void> {
	if (command.type === "prompt") {
		out({
			id: command.id,
			type: "response",
			command: "prompt",
			success: true,
			data: { disposition: "started" },
		});
		out({ type: "agent_start" });
		const [provider, model] = currentModel().split("/");
		const failed = config.title === null;
		const message = {
			role: "assistant",
			content: failed
				? []
				: [{ type: "text", text: config.title ?? "Faux Title" }],
			provider,
			model,
			stopReason: failed ? "error" : "stop",
			...(failed ? { errorMessage: "429 rate limited" } : {}),
		};
		out({ type: "message_end", message });
		out({ type: "agent_end", messages: [message], willRetry: false });
		out({ type: "agent_settled", aborted: false });
		return;
	}
	await handle(command);
}

async function handle(command: FixtureLine["record"]): Promise<void> {
	if (command.type === "prompt" && typeof command.message === "string") {
		lastPrompt = command.message;
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
for await (const chunk of process.stdin) {
	rest += decoder.decode(chunk, { stream: true });
	let index = rest.indexOf("\n");
	while (index >= 0) {
		const command = JSON.parse(rest.slice(0, index));
		rest = rest.slice(index + 1);
		log({ event: "stdin", record: command });
		chain = chain.then(() =>
			sessionId === undefined ? oneShot(command) : handle(command),
		);
		index = rest.indexOf("\n");
	}
}
log({ event: "eof" });
await chain;
process.exit(0);
