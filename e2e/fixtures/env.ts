import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
export const FAUX_SERVER = join(
	REPO,
	"packages",
	"helper",
	"test",
	"fixtures",
	"omp",
	"faux-server.ts",
);
export const FAUX_PORT = 8791;
export const EXTENSION_ID = "hnjcpmkohkooncneepdhfodblhhgimnh";
export const NATIVE_HOST = "com.freedia.helper";
export const FAUX_CONTEXT_WINDOW = 20_000;
const E2E_INSTALLER = join(REPO, "packages", "helper", "src", "install-e2e.ts");

export function buildAll(): void {
	execFileSync("bun", ["run", "build"], { cwd: REPO, stdio: "inherit" });
}

export async function startFauxServer(): Promise<ChildProcess> {
	const child = spawn("bun", [FAUX_SERVER], {
		env: {
			...strippedEnv(),
			FAUX_PORT: String(FAUX_PORT),
			FREEDIA_FAUX_TPS: "60",
			FREEDIA_FAUX_LATENCY_MS: "800",
		},
		stdio: "ignore",
	});
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const response = await fetch(`http://127.0.0.1:${FAUX_PORT}/v1/models`);
			if (response.ok) return child;
		} catch {}
		await sleep(50);
	}
	child.kill();
	throw new Error("faux provider did not start");
}

export interface FreediaHome {
	home: string;
	root: string;
	chats: string;
	pages: string;
	launcher: string;
	log: string;
}

export async function createHome(
	extraEnv: Record<string, string> = {},
): Promise<FreediaHome> {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "freedia-e2e-home-")));
	const root = join(home, ".freedia");
	const ompAgent = join(root, "omp-agent");
	const fakeHome = join(root, "home");
	mkdirSync(ompAgent, { recursive: true });
	mkdirSync(fakeHome, { recursive: true });
	writeFileSync(
		join(ompAgent, "models.yml"),
		`providers:\n  faux:\n    baseUrl: http://127.0.0.1:${FAUX_PORT}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: faux-1\n        name: Faux One\n        contextWindow: ${FAUX_CONTEXT_WINDOW}\n        maxTokens: 8192\n      - id: faux-2\n        name: Faux Two\n        contextWindow: ${FAUX_CONTEXT_WINDOW}\n        maxTokens: 8192\n`,
	);
	execFileSync("bun", [E2E_INSTALLER, home]);
	const launcher = join(home, "freedia-helper-launcher.sh");
	const log = join(home, "helper.log");
	const env = {
		HOME: home,
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		FREEDIA_FAUX_CONTEXT: String(FAUX_CONTEXT_WINDOW),
		FREEDIA_OMP_EXTRA_ARGS: "--model faux/faux-1",
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
	if (!existsSync(home.chats)) return [];
	return readdirSync(home.chats).flatMap((chatId) => {
		const chatDir = join(home.chats, chatId);
		return readdirSync(chatDir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => join(chatId, name));
	});
}

export interface SessionEntry {
	type: string;
	id?: string;
	name?: string;
	model?: string;
	modelId?: string;
	title?: string;
	message?: {
		role: string;
		content: unknown;
		stopReason?: string;
		provider?: string;
		model?: string;
	};
	[key: string]: unknown;
}

export function chatIds(home: FreediaHome): string[] {
	const ids = Array.from(
		new Set(sessionFiles(home).map((name) => name.split("/")[0] ?? "")),
	);
	return ids.filter((chatId) =>
		sessionEntries(home, chatId).some(
			(entry) => entry.type === "message" && entry.message?.role === "user",
		),
	);
}

export function chatTitle(home: FreediaHome, chatId: string): string | null {
	for (const file of sessionFiles(home).filter(
		(name) => name.split("/")[0] === chatId,
	)) {
		const entries = readFileSync(join(home.chats, file), "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as SessionEntry);
		const title = entries.findLast(
			(entry) => entry.type === "session_info" || entry.type === "title",
		);
		const value = title?.name ?? title?.title;
		if (typeof value === "string" && value !== "") return value;
	}
	return null;
}
export function sessionEntries(
	home: FreediaHome,
	chatId: string,
): SessionEntry[] {
	const file = sessionFiles(home)
		.filter((name) => name.split("/")[0] === chatId)
		.sort(
			(a, b) =>
				statSync(join(home.chats, b)).size - statSync(join(home.chats, a)).size,
		)
		.at(0);
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

export function ompProcesses(home: FreediaHome): string[] {
	const out = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
		encoding: "utf8",
	});
	return out
		.split("\n")
		.filter(
			(line) =>
				line.includes(join(home.root, "omp", "node_modules")) &&
				line.includes("--mode rpc"),
		);
}

export function chatProcesses(home: FreediaHome): string[] {
	return ompProcesses(home);
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
					traffic.push(`${stamp()} ← ${text.slice(0, 300)}`);
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

export async function waitForNoOmp(
	home: FreediaHome,
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (ompProcesses(home).length > 0) {
		if (Date.now() > deadline) {
			throw new Error(
				`omp still running:\n${ompProcesses(home).join("\n")}\n${readLog(home)}`,
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
