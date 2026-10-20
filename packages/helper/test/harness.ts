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
import { type FreediaPaths, freediaPaths } from "../src/paths";
import { type PiConfig, piConfigFromEnv } from "../src/pi";
import type { PiRpcRecord } from "../src/protocol";
import type { FakePiConfig } from "./fake-pi";

export const CHAT_A = "3f2a9c1e-8b4d-4e6f-a0b1-c2d3e4f5a6b7";
export const CHAT_B = "7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6";
export const CHAT_C = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";

export interface FakeLogEntry {
	pid: number;
	event: "spawn" | "stdin" | "stdout" | "eof" | "auth";
	argv?: string[];
	env?: Record<string, string>;
	cwd?: string;
	record?: PiRpcRecord;
}

export interface Sent {
	type?: string;
	id?: string;
	chatId?: string;
	state?: string;
	rpc?: PiRpcRecord;
	[key: string]: unknown;
}

export function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "freedia-test-"));
}

export function installFakePi(paths: FreediaPaths, version = "1.3.0"): void {
	mkdirSync(join(paths.piPackage, "dist", "bundle"), { recursive: true });
	writeFileSync(
		join(paths.piPackage, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }),
	);
	writeFileSync(
		paths.piCli,
		`import ${JSON.stringify(join(import.meta.dir, "fake-pi.ts"))};\n`,
	);
}

export class TestHelper {
	readonly home: string;
	readonly paths: FreediaPaths;
	readonly pi: PiConfig;
	readonly sent: Sent[] = [];
	readonly logs: string[] = [];
	readonly piInstalls: string[] = [];
	readonly helper: Helper;

	constructor(
		options: {
			fake?: FakePiConfig;
			env?: Record<string, string>;
			piVersion?: string | false;
			helper?: Partial<HelperOptions>;
			home?: string;
			onMessage?: (message: Sent, harness: TestHelper) => void;
		} = {},
	) {
		this.home = options.home ?? tempHome();
		this.paths = freediaPaths(this.home);
		if (options.piVersion !== false) {
			installFakePi(this.paths, options.piVersion ?? "1.3.0");
		}
		writeFileSync(
			join(this.home, "fake-pi.json"),
			JSON.stringify(options.fake ?? {}),
		);
		this.pi = piConfigFromEnv(
			this.paths,
			{ PATH: process.env.PATH ?? "", ...options.env },
			process.execPath,
		);
		this.helper = new Helper({
			paths: this.paths,
			pi: this.pi,
			helperVersion: "9.9.9",
			pinnedPiVersion: "1.3.0",
			installPi: async (version) => {
				this.piInstalls.push(version);
				installFakePi(this.paths, version);
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

	rpc(chatId: string, rpc: PiRpcRecord): Promise<void> {
		return this.helper.handle({ chatId, rpc });
	}

	rpcs(chatId: string): PiRpcRecord[] {
		return this.sent
			.filter((message) => "rpc" in message && message.chatId === chatId)
			.map((message) => message.rpc as PiRpcRecord);
	}

	async waitFor<T>(
		find: () => T | undefined | false,
		label: string,
		timeoutMs = 8000,
	): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const found = find();
			if (found !== undefined && found !== false) {
				return found;
			}
			await Bun.sleep(10);
		}
		throw new Error(
			`timed out waiting for ${label}; sent=${JSON.stringify(this.sent.map((m) => ("rpc" in m ? m.rpc?.type : m.type)))} logs=${this.logs.join(" | ")}`,
		);
	}

	waitForRpc(
		chatId: string,
		match: (rpc: PiRpcRecord) => boolean,
		label: string,
	) {
		return this.waitFor(() => this.rpcs(chatId).find(match), label);
	}

	async waitIdle(): Promise<void> {
		await this.helper.whenIdle();
	}

	helperSession(chatId: string): string {
		const name = readdirSync(this.paths.chats).find((file) =>
			file.endsWith(`_${chatId}.jsonl`),
		);
		if (name === undefined) {
			throw new Error(`no session file for ${chatId}`);
		}
		return join(this.paths.chats, name);
	}

	fakeLog(): FakeLogEntry[] {
		const file = join(this.home, "fake-pi-log.jsonl");
		if (!existsSync(file)) {
			return [];
		}
		return readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	}

	spawns(filter: (argv: string[]) => boolean = () => true): FakeLogEntry[] {
		return this.fakeLog().filter(
			(entry) => entry.event === "spawn" && filter(entry.argv ?? []),
		);
	}

	chatSpawns(chatId: string): FakeLogEntry[] {
		return this.spawns((argv) => argv.includes(chatId));
	}
}
