import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Helper, type HelperOptions } from "../src/helper";
import { type OmpConfig, ompConfigFromEnv } from "../src/omp";
import { type FreediaPaths, freediaPaths } from "../src/paths";
import type { OmpRpcRecord } from "../src/protocol";
import type { FakeOmpConfig } from "./fake-omp";

export const CHAT_A = "3f2a9c1e-8b4d-4e6f-a0b1-c2d3e4f5a6b7";
export const CHAT_B = "7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6";
export const CHAT_C = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";

export interface FakeLogEntry {
	pid: number;
	event: "spawn" | "stdin" | "stdout" | "eof" | "auth";
	argv?: string[];
	env?: Record<string, string>;
	cwd?: string;
	record?: OmpRpcRecord;
}
export interface Sent {
	type?: string;
	id?: string;
	chatId?: string;
	state?: string;
	rpc?: OmpRpcRecord;
	[key: string]: unknown;
}
export function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "freedia-test-"));
}

export function installFakeOmp(paths: FreediaPaths, version = "18.12.1"): void {
	mkdirSync(join(paths.ompPackage, "dist"), { recursive: true });
	writeFileSync(
		join(paths.ompPackage, "package.json"),
		JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }),
	);
	writeFileSync(
		paths.ompCli,
		`import ${JSON.stringify(join(import.meta.dir, "fake-omp.ts"))};\n`,
	);
}

export class TestHelper {
	readonly home: string;
	readonly paths: FreediaPaths;
	readonly omp: OmpConfig;
	readonly sent: Sent[] = [];
	readonly logs: string[] = [];
	readonly ompInstalls: string[] = [];
	readonly helper: Helper;

	constructor(
		options: {
			fake?: FakeOmpConfig;
			env?: Record<string, string>;
			ompVersion?: string | false;
			helper?: Partial<HelperOptions>;
			home?: string;
			onMessage?: (message: Sent, harness: TestHelper) => void;
		} = {},
	) {
		this.home = options.home ?? tempHome();
		this.paths = freediaPaths(this.home);
		mkdirSync(this.paths.fakeHome, { recursive: true });
		if (options.ompVersion !== false)
			installFakeOmp(this.paths, options.ompVersion ?? "18.12.1");
		writeFileSync(
			join(this.paths.fakeHome, "fake-omp.json"),
			JSON.stringify(options.fake ?? {}),
			{ flush: true },
		);
		this.omp = ompConfigFromEnv(
			this.paths,
			{ PATH: process.env.PATH ?? "", ...options.env },
			process.execPath,
		);
		this.helper = new Helper({
			paths: this.paths,
			omp: this.omp,
			helperVersion: "9.9.9",
			pinnedOmpVersion: "18.12.1",
			installOmp: async (version) => {
				this.ompInstalls.push(version);
				installFakeOmp(this.paths, version);
			},
			log: (line) => this.logs.push(line),
			output: {
				message: (message) => {
					const copy = structuredClone(message) as Sent;
					this.sent.push(copy);
					options.onMessage?.(copy, this);
				},
				envelopeJson: (chatId, rpcJson) =>
					this.sent.push(JSON.parse(`{"chatId":"${chatId}","rpc":${rpcJson}}`)),
			},
			...options.helper,
		});
	}
	send(message: unknown): Promise<void> {
		return this.helper.handle(message);
	}
	rpc(chatId: string, rpc: OmpRpcRecord): Promise<void> {
		return this.helper.handle({ chatId, rpc });
	}
	rpcs(chatId: string): OmpRpcRecord[] {
		return this.sent
			.filter((message) => "rpc" in message && message.chatId === chatId)
			.map((message) => message.rpc as OmpRpcRecord);
	}
	async waitFor<T>(
		find: () => T | undefined | false,
		label: string,
		timeoutMs = 8000,
	): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const found = find();
				if (found !== undefined && found !== false) return found;
			} catch {}
			await Bun.sleep(10);
		}
		throw new Error(
			`timed out waiting for ${label}; sent=${JSON.stringify(this.sent)}`,
		);
	}
	waitForRpc(
		chatId: string,
		match: (rpc: OmpRpcRecord) => boolean,
		label: string,
	) {
		return this.waitFor(() => this.rpcs(chatId).find(match), label);
	}
	async waitIdle(): Promise<void> {
		await this.helper.whenIdle();
	}
	helperSession(chatId: string): string {
		const directory = join(this.paths.chats, chatId);
		const name = readdirSync(directory).find((file) => file.endsWith(".jsonl"));
		if (name === undefined) throw new Error(`no session file for ${chatId}`);
		return join(directory, name);
	}
	fakeLog(): FakeLogEntry[] {
		const file = join(this.paths.fakeHome, "fake-omp-log.jsonl");
		if (!existsSync(file)) return [];
		return readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}
	spawns(filter: (argv: string[]) => boolean = () => true): FakeLogEntry[] {
		return this.fakeLog().filter(
			(entry) => entry.event === "spawn" && filter(entry.argv ?? []),
		);
	}
	chatSpawns(chatId: string): FakeLogEntry[] {
		return this.spawns().filter(
			(entry) => entry.record?.sessionDir === join(this.paths.chats, chatId),
		);
	}
}
