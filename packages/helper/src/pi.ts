import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitLines } from "./framing";
import { type FreediaPaths, pageFile } from "./paths";
import type { PiRpcRecord } from "./protocol";

export const READ_ONLY_TOOLS = "read,grep,find,ls";

export const ISOLATION_FLAGS = [
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-context-files",
	"--no-mcp",
	"--no-themes",
];

export interface PiConfig {
	paths: FreediaPaths;
	execPath: string;
	extraArgs: string[];
	defaultModel: string | undefined;
	passEnv: Record<string, string>;
}

export function parseExtraArgs(raw: string | undefined): {
	extraArgs: string[];
	defaultModel: string | undefined;
} {
	const tokens = (raw ?? "").split(/\s+/).filter((token) => token !== "");
	const extraArgs: string[] = [];
	let defaultModel: string | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as string;
		if (token === "--model" && index + 1 < tokens.length) {
			defaultModel = tokens[index + 1];
			index++;
		} else {
			extraArgs.push(token);
		}
	}
	return { extraArgs, defaultModel };
}

export function piConfigFromEnv(
	paths: FreediaPaths,
	env: Record<string, string | undefined>,
	execPath: string,
): PiConfig {
	const passEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (key.startsWith("FREEDIA_FAUX_") && value !== undefined) {
			passEnv[key] = value;
		}
	}
	if (env.PATH !== undefined) {
		passEnv.PATH = env.PATH;
	}
	return {
		paths,
		execPath,
		passEnv,
		...parseExtraArgs(env.FREEDIA_PI_EXTRA_ARGS),
	};
}

export function piEnv(config: PiConfig): Record<string, string> {
	return {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		...config.passEnv,
		HOME: config.paths.home,
		PI_CODING_AGENT_DIR: config.paths.piAgent,
		BUN_BE_BUN: "1",
	};
}

export function systemRules(paths: FreediaPaths, chatId: string): string {
	return [
		"You are freeDia, a read-only assistant answering questions about the web page the user is looking at.",
		"Each message carries the page URL, title, any text the user highlighted, and usually an excerpt of the page, followed by the question under a `## Question` heading.",
		`The full page text, when available, is at ${pageFile(paths, chatId)}. Read it with read or grep when the excerpt is not enough to answer.`,
		"You are read-only: never try to write, edit or delete files or run commands.",
		`Only read ${paths.chats} when the user explicitly asks about their previous chats.`,
	].join("\n");
}

export function chatLaunchArgs(
	config: PiConfig,
	chatId: string,
	model: string | undefined,
): string[] {
	return [
		config.execPath,
		config.paths.piCli,
		"--mode",
		"rpc",
		"--session-dir",
		config.paths.chats,
		"--session-id",
		chatId,
		...(model === undefined ? [] : ["--model", model]),
		"--tools",
		READ_ONLY_TOOLS,
		...ISOLATION_FLAGS,
		"--append-system-prompt",
		systemRules(config.paths, chatId),
		...config.extraArgs,
	];
}

export function oneShotArgs(
	config: PiConfig,
	model: string | undefined,
): string[] {
	return [
		config.execPath,
		config.paths.piCli,
		"--mode",
		"rpc",
		"--no-session",
		...(model === undefined ? [] : ["--model", model]),
		"--no-tools",
		...ISOLATION_FLAGS,
		...config.extraArgs,
	];
}

export function piInstalled(paths: FreediaPaths): boolean {
	return existsSync(paths.piCli);
}

export function piVersion(paths: FreediaPaths): string {
	try {
		const pkg = JSON.parse(
			readFileSync(join(paths.piPackage, "package.json"), "utf8"),
		);
		return typeof pkg.version === "string" ? pkg.version : "";
	} catch {
		return "";
	}
}

export type PiProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

export function spawnPi(config: PiConfig, cmd: string[]): PiProcess {
	mkdirSync(config.paths.root, { recursive: true });
	return Bun.spawn(cmd, {
		cwd: config.paths.root,
		env: piEnv(config),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
}

export async function runOneShot(
	config: PiConfig,
	model: string | undefined,
	command: PiRpcRecord,
	until: (record: PiRpcRecord) => boolean,
	timeoutMs: number,
): Promise<PiRpcRecord[]> {
	const proc = spawnPi(config, oneShotArgs(config, model));
	const records: PiRpcRecord[] = [];
	let finish: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const lines = splitLines((line) => {
		try {
			const record = JSON.parse(line) as PiRpcRecord;
			records.push(record);
			if (until(record)) {
				finish();
			}
		} catch {}
	});
	const reading = (async () => {
		for await (const chunk of proc.stdout) {
			lines.push(chunk);
		}
		lines.end();
		finish();
	})();
	const draining = new Response(proc.stderr).text();
	proc.stdin.write(`${JSON.stringify(command)}\n`);
	proc.stdin.flush();
	const timer = setTimeout(finish, timeoutMs);
	await done;
	clearTimeout(timer);
	proc.stdin.end();
	const killer = setTimeout(() => proc.kill(), 5000);
	await proc.exited;
	clearTimeout(killer);
	await reading;
	await draining;
	return records;
}

export type AuthStatus = "ready" | "not_ready" | "invalid" | "unknown";

export async function authCheck(
	config: PiConfig,
	provider: string,
): Promise<{ status: AuthStatus; reason: string }> {
	const proc = Bun.spawn(
		[
			config.execPath,
			config.paths.piCli,
			"auth",
			"check",
			"--provider",
			provider,
			"--json",
		],
		{
			cwd: config.paths.root,
			env: piEnv(config),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [out] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	try {
		const result = JSON.parse(out.trim());
		const reason = typeof result.reason === "string" ? result.reason : "";
		if (reason === "provider_not_found") {
			return { status: "unknown", reason };
		}
		if (
			result.status === "ready" ||
			result.status === "not_ready" ||
			result.status === "invalid"
		) {
			return { status: result.status, reason };
		}
	} catch {}
	return { status: "unknown", reason: "" };
}
