import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type BrowserContext,
	chromium,
	type Page,
	type Worker,
} from "@playwright/test";

export const REPO = resolve(import.meta.dirname, "..", "..");
export const EXTENSION_DIR = join(
	REPO,
	"packages",
	"extension",
	".output",
	"chrome-mv3",
);
export const HELPER_BINARY = join(
	REPO,
	"packages",
	"helper",
	"dist",
	"freedia-helper",
);
export const FAUX_EXTENSION = join(
	REPO,
	"packages",
	"helper",
	"test",
	"fixtures",
	"pi",
	"faux-extension.ts",
);
export const EXTENSION_ID = "hnjcpmkohkooncneepdhfodblhhgimnh";
export const NATIVE_HOST = "com.freedia.helper";
export const FAUX_CONTEXT_WINDOW = 20_000;

const PI_PACKAGE = realpathSync(
	join(
		REPO,
		"packages",
		"helper",
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
	),
);

export function buildAll(): void {
	execFileSync("bun", ["run", "build"], { cwd: REPO, stdio: "inherit" });
}

export interface FreediaHome {
	home: string;
	root: string;
	chats: string;
	pages: string;
	launcher: string;
	log: string;
}

export function createHome(extraEnv: Record<string, string> = {}): FreediaHome {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "freedia-e2e-home-")));
	const root = join(home, ".freedia");
	const piLink = join(
		root,
		"pi",
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
	);
	mkdirSync(dirname(piLink), { recursive: true });
	symlinkSync(PI_PACKAGE, piLink);
	const launcher = join(home, "freedia-helper-launcher.sh");
	const log = join(home, "helper.log");
	const env = {
		HOME: home,
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		FREEDIA_PI_EXTRA_ARGS: `-e ${FAUX_EXTENSION} --offline --model faux/faux-1`,
		FREEDIA_FAUX_CONTEXT: String(FAUX_CONTEXT_WINDOW),
		FREEDIA_FAUX_TPS: "150",
		FREEDIA_FAUX_LATENCY_MS: "600",
		...extraEnv,
	};
	const assignments = Object.entries(env)
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join(" ");
	writeFileSync(
		launcher,
		`#!/bin/sh\nexec /usr/bin/env -i ${assignments} ${JSON.stringify(HELPER_BINARY)} "$@" 2>>${JSON.stringify(log)}\n`,
	);
	chmodSync(launcher, 0o755);
	return {
		home,
		root,
		chats: join(root, "chats"),
		pages: join(root, "pages"),
		launcher,
		log,
	};
}

export function sessionFiles(home: FreediaHome): string[] {
	return existsSync(home.chats)
		? readdirSync(home.chats).filter((name) => name.endsWith(".jsonl"))
		: [];
}

export interface SessionEntry {
	type: string;
	id?: string;
	name?: string;
	message?: { role: string; content: unknown; stopReason?: string };
	[key: string]: unknown;
}

export function chatIds(home: FreediaHome): string[] {
	return sessionFiles(home).map((name) => name.replace(/^.*_|\.jsonl$/g, ""));
}

export function chatTitle(home: FreediaHome, chatId: string): string | null {
	const info = sessionEntries(home, chatId).findLast(
		(entry) => entry.type === "session_info",
	);
	return typeof info?.name === "string" ? info.name : null;
}
export function sessionEntries(
	home: FreediaHome,
	chatId: string,
): SessionEntry[] {
	const file = sessionFiles(home).find((name) =>
		name.endsWith(`_${chatId}.jsonl`),
	);
	if (file === undefined) return [];
	return readFileSync(join(home.chats, file), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as SessionEntry);
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: { type?: string; text?: string }) =>
			block.type === "text" ? (block.text ?? "") : "",
		)
		.join("");
}

export function userMessages(home: FreediaHome, chatId: string): string[] {
	return sessionEntries(home, chatId)
		.filter((entry) => entry.message?.role === "user")
		.map((entry) => contentText(entry.message?.content));
}

export function piProcesses(home: FreediaHome): string[] {
	const out = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
		encoding: "utf8",
	});
	return out
		.split("\n")
		.filter(
			(line) =>
				line.includes(join(home.root, "pi", "node_modules")) &&
				line.includes("--mode rpc"),
		);
}

export function chatProcesses(home: FreediaHome): string[] {
	return piProcesses(home).filter((line) => line.includes("--session-id "));
}

export function helperPids(): string[] {
	const out = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
		encoding: "utf8",
	});
	return out
		.split("\n")
		.filter(
			(line) =>
				line.includes(HELPER_BINARY) && line.includes("chrome-extension://"),
		)
		.map((line) => line.trim().split(/\s+/)[0] ?? "");
}

export function processEnv(pid: string): string {
	return execFileSync("ps", ["eww", "-o", "command=", "-p", pid], {
		encoding: "utf8",
	});
}

export interface BrowserOptions {
	nativeHost?: boolean;
}

export class FreediaBrowser {
	readonly userDataDir: string;
	context: BrowserContext | null = null;
	onboarding: Page | null = null;
	private launches = 0;

	constructor(
		readonly home: FreediaHome,
		options: BrowserOptions = {},
	) {
		this.userDataDir = realpathSync(
			mkdtempSync(join(tmpdir(), "freedia-e2e-profile-")),
		);
		if (options.nativeHost !== false) {
			const hostDir = join(this.userDataDir, "NativeMessagingHosts");
			mkdirSync(hostDir, { recursive: true });
			writeFileSync(
				join(hostDir, `${NATIVE_HOST}.json`),
				JSON.stringify(
					{
						name: NATIVE_HOST,
						description: "freeDia helper (e2e)",
						path: home.launcher,
						type: "stdio",
						allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
					},
					null,
					2,
				),
			);
		}
	}

	async launch(): Promise<BrowserContext> {
		const firstRun = this.launches === 0;
		this.launches++;
		const context = await chromium.launchPersistentContext(this.userDataDir, {
			channel: "chromium",
			headless: true,
			viewport: { width: 1280, height: 860 },
			env: strippedEnv(),
			args: [
				`--disable-extensions-except=${EXTENSION_DIR}`,
				`--load-extension=${EXTENSION_DIR}`,
			],
		});
		this.context = context;
		const isOptions = (page: Page) =>
			page.url().startsWith(`chrome-extension://${EXTENSION_ID}/options.html`);
		this.onboarding = null;
		for (let tries = 0; firstRun && tries < 100; tries++) {
			this.onboarding = context.pages().find(isOptions) ?? null;
			if (this.onboarding !== null) break;
			await sleep(100);
		}
		await this.recordTraffic();
		return context;
	}

	async recordTraffic(): Promise<void> {
		const worker = await this.serviceWorker();
		await worker.evaluate(() => {
			const scope = globalThis as typeof globalThis & {
				__freediaTraffic?: string[];
			};
			if (scope.__freediaTraffic !== undefined) return;
			const traffic: string[] = [];
			scope.__freediaTraffic = traffic;
			const connect = chrome.runtime.connectNative.bind(chrome.runtime);
			chrome.runtime.connectNative = (name: string) => {
				const port = connect(name);
				const post = port.postMessage.bind(port);
				const stamp = () => new Date().toISOString().slice(11, 23);
				port.postMessage = (message: unknown) => {
					traffic.push(`${stamp()} → ${JSON.stringify(message).slice(0, 300)}`);
					post(message);
				};
				port.onMessage.addListener((message: unknown) => {
					const text = JSON.stringify(message);
					if (!text.includes('"message_update"')) {
						traffic.push(`${stamp()} ← ${text.slice(0, 300)}`);
					}
				});
				port.onDisconnect.addListener(() => {
					traffic.push(
						`${stamp()} ✕ ${chrome.runtime.lastError?.message ?? "disconnected"}`,
					);
				});
				return port;
			};
		});
	}

	async traffic(): Promise<string> {
		if (this.context === null) return "";
		const worker = await this.serviceWorker();
		return worker.evaluate(() =>
			(
				(globalThis as typeof globalThis & { __freediaTraffic?: string[] })
					.__freediaTraffic ?? []
			).join("\n"),
		);
	}

	async serviceWorker(): Promise<Worker> {
		const context = this.requireContext();
		const existing = context
			.serviceWorkers()
			.find((worker) => worker.url().includes(EXTENSION_ID));
		return (
			existing ??
			(await context.waitForEvent("serviceworker", {
				predicate: (worker) => worker.url().includes(EXTENSION_ID),
			}))
		);
	}

	async close(): Promise<void> {
		const context = this.context;
		this.context = null;
		await context?.close();
	}

	async dispose(): Promise<void> {
		await this.close();
		rmSync(this.userDataDir, { recursive: true, force: true });
	}

	requireContext(): BrowserContext {
		if (this.context === null) throw new Error("browser is not running");
		return this.context;
	}
}

export function strippedEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (/(_API_KEY|_TOKEN|_SECRET)$|^(ANTHROPIC|OPENAI|GEMINI|GROQ)_/.test(key))
			continue;
		env[key] = value;
	}
	return env;
}

export async function waitForNoPi(
	home: FreediaHome,
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (piProcesses(home).length > 0) {
		if (Date.now() > deadline) {
			throw new Error(
				`pi still running:\n${piProcesses(home).join("\n")}\n${readLog(home)}`,
			);
		}
		await sleep(200);
	}
}

export function readLog(home: FreediaHome): string {
	return existsSync(home.log) ? readFileSync(home.log, "utf8") : "";
}

export function removeHome(home: FreediaHome): void {
	rmSync(home.home, { recursive: true, force: true });
}
