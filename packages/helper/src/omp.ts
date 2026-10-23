import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitLines } from "./framing";
import { type FreediaPaths, pageFile } from "./paths";
import type { OmpRpcRecord } from "./protocol";

export const READ_ONLY_TOOLS = "read,grep,glob";
export const ISOLATION_FLAGS = [
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-lsp",
];

export interface OmpConfig {
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

export function ompConfigFromEnv(
	paths: FreediaPaths,
	env: Record<string, string | undefined>,
	execPath: string,
): OmpConfig {
	const passEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (key.startsWith("FREEDIA_FAUX_") && value !== undefined) {
			passEnv[key] = value;
		}
	}
	if (env.PATH !== undefined) passEnv.PATH = env.PATH;
	return {
		paths,
		execPath,
		passEnv,
		...parseExtraArgs(env.FREEDIA_OMP_EXTRA_ARGS),
	};
}

export function ompEnv(config: OmpConfig): Record<string, string> {
	return {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		...config.passEnv,
		HOME: config.paths.fakeHome,
		PI_CODING_AGENT_DIR: config.paths.ompAgent,
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
	config: OmpConfig,
	chatId: string,
	model: string | undefined,
): string[] {
	return [
		config.execPath,
		config.paths.ompCli,
		"--mode",
		"rpc",
		"--no-ui",
		"--cwd",
		config.paths.root,
		...(model === undefined ? [] : ["--model", model]),
		"--tools",
		READ_ONLY_TOOLS,
		...ISOLATION_FLAGS,
		"--append-system-prompt",
		systemRules(config.paths, chatId),
		...config.extraArgs,
	];
}

export function rpcOneShotArgs(config: OmpConfig): string[] {
	return [
		config.execPath,
		config.paths.ompCli,
		"--mode",
		"rpc",
		"--no-ui",
		"--cwd",
		config.paths.root,
		"--no-session",
		...ISOLATION_FLAGS,
		...config.extraArgs,
	];
}

export function titleArgs(
	config: OmpConfig,
	model: string | undefined,
	prompt: string,
): string[] {
	return [
		config.execPath,
		config.paths.ompCli,
		"-p",
		"--no-session",
		"--no-title",
		"--no-tools",
		...ISOLATION_FLAGS,
		...(model === undefined ? [] : ["--model", model]),
		prompt,
	];
}

export function ompInstalled(paths: FreediaPaths): boolean {
	return existsSync(paths.ompCli);
}

export function ompVersion(paths: FreediaPaths): string {
	try {
		const pkg = JSON.parse(
			readFileSync(join(paths.ompPackage, "package.json"), "utf8"),
		);
		return typeof pkg.version === "string" ? pkg.version : "";
	} catch {
		return "";
	}
}

export type OmpProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

export function spawnOmp(config: OmpConfig, cmd: string[]): OmpProcess {
	mkdirSync(config.paths.root, { recursive: true });
	mkdirSync(config.paths.fakeHome, { recursive: true });
	return Bun.spawn(cmd, {
		cwd: config.paths.root,
		env: ompEnv(config),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
}

export async function runOneShot(
	config: OmpConfig,
	command: OmpRpcRecord,
	until: (record: OmpRpcRecord) => boolean,
	timeoutMs: number,
): Promise<OmpRpcRecord[]> {
	const proc = spawnOmp(config, rpcOneShotArgs(config));
	const records: OmpRpcRecord[] = [];
	let finish: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const lines = splitLines((line) => {
		try {
			const record = JSON.parse(line) as OmpRpcRecord;
			records.push(record);
			if (until(record)) finish();
		} catch {}
	});
	const reading = (async () => {
		for await (const chunk of proc.stdout) lines.push(chunk);
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

export async function runTitle(
	config: OmpConfig,
	model: string | undefined,
	prompt: string,
	timeoutMs: number,
): Promise<string | undefined> {
	const proc = spawnOmp(config, titleArgs(config, model, prompt));
	const timer = setTimeout(() => proc.kill(), timeoutMs);
	const [stdout, , code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return code === 0 ? stdout.trim() : undefined;
}
