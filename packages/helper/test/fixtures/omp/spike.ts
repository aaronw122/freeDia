// omp RPC spike: S1-equivalent for the pi -> omp swap.
// Drives omp --mode rpc through fresh session, resume, abort, read-only tools,
// unauthenticated errors, and captures JSONL fixtures.

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROBE = "/tmp/omp-npm-probe2";
const CLI = `${PROBE}/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`;
const SPIKE = "/tmp/omp-spike";
const OUT = `${SPIKE}/out`;
for (const dir of [
	`${SPIKE}/agent`,
	`${SPIKE}/home`,
	`${SPIKE}/cwd`,
	`${SPIKE}/chats`,
	`${SPIKE}/chats2`,
	OUT,
]) {
	mkdirSync(dir, { recursive: true });
}

type Frame = Record<string, unknown>;

function asFrame(value: unknown): Frame | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Frame)
		: undefined;
}

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

interface LogEntry {
	t: number;
	dir: string;
	record: unknown;
}

class Rpc {
	private readonly proc: ChildProcessWithoutNullStreams;
	private readonly log: LogEntry[] = [];
	private readonly pending: Frame[] = [];
	private readonly stderr: string[] = [];
	private readonly name: string;

	constructor(name: string, extraArgs: string[], chatDirOverride?: string) {
		this.name = name;
		this.proc = spawn(
			process.execPath,
			[
				CLI,
				"--mode",
				"rpc",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--no-lsp",
				"--no-title",
				"--cwd",
				`${SPIKE}/cwd`,
				...(chatDirOverride ? ["--session-dir", chatDirOverride] : []),
				...extraArgs,
			],
			{
				env: {
					HOME: `${SPIKE}/home`,
					PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
					TMPDIR: "/tmp",
					PI_CODING_AGENT_DIR: `${SPIKE}/agent`,
					BUN_BE_BUN: "1",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		) as ChildProcessWithoutNullStreams;
		this.proc.stdout.setEncoding("utf8");
		this.proc.stderr.setEncoding("utf8");
		let buf = "";
		this.proc.stdout.on("data", (chunk: string) => {
			buf += chunk;
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.trim()) {
					const parsed: unknown = JSON.parse(line);
					this.push(asFrame(parsed));
				}
				nl = buf.indexOf("\n");
			}
		});
		this.proc.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
	}

	private push(frame: Frame | undefined): void {
		if (!frame) return;
		this.log.push({ t: Date.now(), dir: "stdout", record: frame });
		this.pending.push(frame);
	}

	send(command: Frame): void {
		this.log.push({ t: Date.now(), dir: "stdin", record: command });
		this.proc.stdin.write(`${JSON.stringify(command)}\n`);
	}

	async next(timeoutMs: number): Promise<Frame | undefined> {
		const deadline = Date.now() + timeoutMs;
		while (
			this.pending.length === 0 &&
			this.proc.exitCode === null &&
			Date.now() < deadline
		) {
			await delay(20);
		}
		return this.pending.shift();
	}

	async until(
		pred: (frame: Frame) => boolean,
		timeoutMs: number,
	): Promise<Frame | undefined> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const frame = await this.next(deadline - Date.now());
			if (!frame) return undefined;
			if (pred(frame)) return frame;
		}
	}

	async close(timeoutMs = 15000): Promise<number | null> {
		this.proc.stdin.end();
		const deadline = Date.now() + timeoutMs;
		while (this.proc.exitCode === null && Date.now() < deadline) {
			await delay(50);
		}
		if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
		this.flush();
		return this.proc.exitCode;
	}

	tail(type: string, field?: string): unknown {
		for (let i = this.log.length - 1; i >= 0; i -= 1) {
			const frame = asFrame(this.log[i].record);
			if (frame?.type === type) return field ? frame[field] : frame;
		}
		return undefined;
	}

	framesOf(type: string): Frame[] {
		return this.log
			.map((entry) => asFrame(entry.record))
			.filter((frame): frame is Frame => frame?.type === type);
	}

	flush(): void {
		writeFileSync(
			join(OUT, `${this.name}.jsonl`),
			`${this.log.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
	}
}

const isResponse = (id: string) => (frame: Frame) =>
	frame.type === "response" && frame.id === id;

function summarize(label: string, value: unknown): void {
	console.log(`### ${label}: ${JSON.stringify(value).slice(0, 500)}`);
}

function firstText(message: unknown): unknown {
	const content = asFrame(message)?.content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		const frame = asFrame(block);
		if (frame?.type === "text" && typeof frame.text === "string")
			return frame.text;
	}
	return undefined;
}

// ---------- S-A: fresh session, stream, messages, models, bash probe ----------
const CHAT = randomUUID();
const chatDir = `${SPIKE}/chats/${CHAT}`;
{
	const rpc = new Rpc("A-fresh", ["--tools", "read,grep,glob"]);
	summarize("ready", await rpc.next(30000));
	rpc.send({ id: "neg", type: "negotiate_protocol", protocolVersion: 2 });
	summarize("negotiate", await rpc.until(isResponse("neg"), 10000));
	rpc.send({ id: "open", type: "open_session", sessionDir: chatDir });
	summarize("open_session(fresh)", await rpc.until(isResponse("open"), 30000));
	rpc.send({
		id: "sm",
		type: "set_model",
		provider: "faux",
		modelId: "faux-1",
	});
	summarize("set_model", await rpc.until(isResponse("sm"), 30000));
	rpc.send({
		id: "p1",
		type: "prompt",
		message: "## Question\n\nWhat is 2+2? Reply with just the answer.",
	});
	summarize("prompt-ack", await rpc.until(isResponse("p1"), 60000));
	summarize(
		"session_settled",
		await rpc.until((f) => f.type === "session_settled", 60000),
	);
	summarize(
		"prompt_result",
		rpc.framesOf("prompt_result").map((f) => ({
			status: f.status,
			agentInvoked: f.agentInvoked,
			sessionSettled: f.sessionSettled,
		})),
	);
	rpc.send({ id: "gm", type: "get_messages" });
	const gm = await rpc.until(isResponse("gm"), 30000);
	const gmData = asFrame(gm?.data);
	const messages = Array.isArray(gmData?.messages) ? gmData.messages : [];
	summarize("get_messages", {
		count: messages.length,
		lastText: firstText(messages[messages.length - 1]),
	});
	rpc.send({ id: "ga", type: "get_available_models" });
	const ga = await rpc.until(isResponse("ga"), 60000);
	const gaData = asFrame(ga?.data);
	const models = Array.isArray(gaData?.models) ? gaData.models : [];
	const faux = models
		.filter((m) => asFrame(m)?.provider === "faux")
		.map((m) => asFrame(m)?.id);
	summarize("models", {
		count: models.length,
		first: asFrame(models[0])?.id,
		faux,
	});
	// RPC bash probe: does it exist / execute even with restricted tools?
	rpc.send({ id: "bash1", type: "bash", command: "echo SPIKE_PWNED" });
	summarize("bash-probe", await rpc.until(isResponse("bash1"), 30000));
	rpc.send({ id: "st", type: "get_state" });
	const st = asFrame((await rpc.until(isResponse("st"), 30000))?.data);
	summarize("get_state", {
		model: st?.model,
		sessionFile: st?.sessionFile,
		sessionName: st?.sessionName,
		isStreaming: st?.isStreaming,
		isSettled: st?.isSettled,
		contextUsage: st?.contextUsage,
	});
	summarize("exit-code", await rpc.close());
}

// ---------- S-B: resume same dir, model restored, context kept ----------
{
	const rpc = new Rpc("B-resume", ["--tools", "read,grep,glob"]);
	rpc.send({ id: "open", type: "open_session", sessionDir: chatDir });
	const open = await rpc.until(isResponse("open"), 30000);
	summarize("open_session(resume)", {
		resumed: asFrame(open?.data)?.resumed,
		sessionId: asFrame(open?.data)?.sessionId,
		sessionFile: asFrame(open?.data)?.sessionFile,
	});
	rpc.send({ id: "st", type: "get_state" });
	const st = asFrame((await rpc.until(isResponse("st"), 30000))?.data);
	summarize("resumed-model", st?.model);
	rpc.send({ id: "p2", type: "prompt", message: "[[recall]]" });
	await rpc.until(isResponse("p2"), 60000);
	await rpc.until((f) => f.type === "session_settled", 60000);
	const last = rpc.framesOf("message_end").pop();
	summarize(
		"recall-reply",
		firstText(
			asFrame(last?.message)?.content === undefined
				? asFrame(last?.message)
				: (asFrame(last?.message)?.message ?? last?.message),
		),
	);
	rpc.send({ id: "sn", type: "set_session_name", name: "Spike resume chat" });
	summarize("set_session_name", await rpc.until(isResponse("sn"), 30000));
	summarize("exit-code", await rpc.close());
}

// ---------- S-C: abort mid-reply, partial retention ----------
{
	const rpc = new Rpc("C-abort", ["--tools", "read,grep,glob"]);
	rpc.send({ id: "open", type: "open_session", sessionDir: chatDir });
	await rpc.until(isResponse("open"), 30000);
	rpc.send({ id: "p3", type: "prompt", message: "[[long]]" });
	await rpc.until(isResponse("p3"), 60000);
	const firstDelta = await rpc.until((frame) => {
		const event = asFrame(frame.assistantMessageEvent);
		return frame.type === "message_update" && event?.type === "text_delta";
	}, 60000);
	summarize("first-delta", asFrame(firstDelta?.assistantMessageEvent));
	rpc.send({ id: "ab", type: "abort" });
	summarize("abort-response", await rpc.until(isResponse("ab"), 30000));
	const pr = await rpc.until((f) => f.type === "prompt_result", 60000);
	summarize("abort-prompt_result", pr);
	summarize(
		"abort-settled",
		await rpc.until((f) => f.type === "session_settled", 60000),
	);
	rpc.send({ id: "gm", type: "get_messages" });
	const gm = asFrame((await rpc.until(isResponse("gm"), 30000))?.data);
	const messages = Array.isArray(gm?.messages) ? gm.messages : [];
	const lastMsg = asFrame(messages[messages.length - 1]);
	summarize("partial-kept", {
		count: messages.length,
		lastRole: lastMsg?.role,
		lastStopReason: lastMsg?.stopReason,
		lastText:
			typeof firstText(lastMsg) === "string"
				? (firstText(lastMsg) as string).slice(0, 120)
				: firstText(lastMsg),
	});
	summarize("exit-code", await rpc.close());
}

// ---------- S-D: unauthenticated error shapes ----------
{
	const rpc = new Rpc(
		"D-unauth",
		["--tools", "read,grep,glob"],
		`${SPIKE}/chats2`,
	);
	rpc.send({
		id: "open",
		type: "open_session",
		sessionDir: `${SPIKE}/chats2/${randomUUID()}`,
	});
	summarize("open_session(unauth)", await rpc.until(isResponse("open"), 30000));
	rpc.send({
		id: "sm",
		type: "set_model",
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
	});
	summarize("set_model(unauth)", await rpc.until(isResponse("sm"), 30000));
	rpc.send({ id: "p4", type: "prompt", message: "Say hi" });
	const ack = await rpc.until(isResponse("p4"), 30000);
	summarize("prompt-ack(unauth)", ack);
	const pr = await rpc.until((f) => f.type === "prompt_result", 90000);
	summarize("prompt_result(unauth)", pr);
	rpc.send({ id: "lp", type: "get_login_providers" });
	const lp = asFrame((await rpc.until(isResponse("lp"), 30000))?.data);
	summarize("login-providers", lp);
	summarize("exit-code", await rpc.close());
}

// ---------- S-E: read-only write-tool probe + disk layout ----------
{
	const rpc = new Rpc("E-readonly", ["--tools", "read,grep,glob"]);
	rpc.send({
		id: "open",
		type: "open_session",
		sessionDir: `${SPIKE}/chats2/${randomUUID()}`,
	});
	await rpc.until(isResponse("open"), 30000);
	rpc.send({
		id: "sm",
		type: "set_model",
		provider: "faux",
		modelId: "faux-1",
	});
	await rpc.until(isResponse("sm"), 30000);
	rpc.send({ id: "p5", type: "prompt", message: "[[write]] then [[read]]" });
	await rpc.until(isResponse("p5"), 60000);
	await rpc.until((f) => f.type === "session_settled", 120000);
	const toolEnds = rpc
		.framesOf("tool_execution_end")
		.map((f) => ({ tool: f.toolName, isError: f.isError }));
	summarize("tool-results", toolEnds);
	const exists = statSync(`${SPIKE}/cwd`, { throwIfNoEntry: false });
	summarize("cwd-intact", exists !== null);
	summarize("exit-code", await rpc.close());
}
{
	const walk = (dir: string): string[] => {
		const out: string[] = [];
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) out.push(...walk(path));
			else out.push(`${path} (${statSync(path).size}B)`);
		}
		return out;
	};
	console.log("### chats layout:");
	for (const file of walk(`${SPIKE}/chats`)) console.log(`  ${file}`);
	console.log("### agent dir (top):");
	console.log(`  ${readdirSync(`${SPIKE}/agent`).join(", ")}`);
}
console.log("SPIKE DONE");
