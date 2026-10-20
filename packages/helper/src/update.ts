import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Updater } from "./helper";

export const REGISTRY_URL = "https://registry.npmjs.org";
export const PACKAGE_NAME = "freedia";
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type Fetch = (url: string) => Promise<Response>;

export interface UpdaterOptions {
	currentVersion: string;
	binaryPath: string;
	statePath: string;
	fetch?: Fetch;
	platform?: string;
	arch?: string;
	now?: () => number;
	log?: (line: string) => void;
}

export function compareVersions(a: string, b: string): number {
	const parse = (version: string) =>
		version
			.split("-")[0]
			?.split(".")
			.map((part) => Number.parseInt(part, 10) || 0) ?? [];
	const left = parse(a);
	const right = parse(b);
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) {
			return Math.sign(diff);
		}
	}
	return 0;
}

export function binaryEntry(platform: string, arch: string): string {
	return `package/dist/freedia-helper-${platform}-${arch}`;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function registryTarball(url: string, version: string): URL | undefined {
	if (!VERSION_PATTERN.test(version)) {
		return undefined;
	}
	try {
		const parsed = new URL(url);
		const expected = `/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${version}.tgz`;
		const ok =
			parsed.protocol === "https:" &&
			parsed.host === "registry.npmjs.org" &&
			parsed.username === "" &&
			parsed.password === "" &&
			parsed.search === "" &&
			parsed.hash === "" &&
			parsed.pathname === expected;
		return ok ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export const VERSION_CHECK_TIMEOUT_MS = 5000;

export function reportedVersion(binary: string): string | undefined {
	try {
		const result = Bun.spawnSync([binary, "version"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: VERSION_CHECK_TIMEOUT_MS,
			env: { PATH: "/usr/bin:/bin" },
		});
		return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
	} catch {
		return undefined;
	}
}

export function matchesIntegrity(
	bytes: Uint8Array,
	integrity: string,
): boolean {
	const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity.trim());
	if (match === null) {
		return false;
	}
	const digest = new Bun.CryptoHasher("sha512").update(bytes).digest("base64");
	return digest === match[1];
}

export function isSafeEntry(name: string): boolean {
	return (
		name !== "" &&
		!name.startsWith("/") &&
		!name.startsWith("\\") &&
		!/^[A-Za-z]:/.test(name) &&
		!name.split(/[/\\]/).includes("..")
	);
}

export class SelfUpdater implements Updater {
	private readonly options: UpdaterOptions;
	private readonly fetch: Fetch;
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private checking: Promise<void> | undefined;
	private staged: string | undefined;

	constructor(options: UpdaterOptions) {
		this.options = options;
		this.fetch = options.fetch ?? ((url) => fetch(url));
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => {});
	}

	get stagedVersion(): string | undefined {
		return this.staged;
	}

	get nextPath(): string {
		return `${this.options.binaryPath}.next`;
	}

	maybeCheck(): Promise<void> {
		if (this.staged !== undefined) {
			return Promise.resolve();
		}
		this.checking ??= this.check().finally(() => {
			this.checking = undefined;
		});
		return this.checking;
	}

	get prevPath(): string {
		return `${this.options.binaryPath}.prev`;
	}

	applyIfReady(): boolean {
		const version = this.staged;
		if (version === undefined || !existsSync(this.nextPath)) {
			return false;
		}
		this.staged = undefined;
		const reported = reportedVersion(this.nextPath);
		if (reported !== version) {
			this.log(
				`update ${version}: staged binary reports ${reported ?? "nothing"}; keeping the current helper`,
			);
			rmSync(this.nextPath, { force: true });
			return false;
		}
		rmSync(this.prevPath, { force: true });
		renameSync(this.options.binaryPath, this.prevPath);
		try {
			renameSync(this.nextPath, this.options.binaryPath);
		} catch (error) {
			renameSync(this.prevPath, this.options.binaryPath);
			rmSync(this.nextPath, { force: true });
			this.log(
				`update ${version}: swap failed (${error}); kept the current helper`,
			);
			return false;
		}
		this.log(`updated helper to ${version}; previous kept at ${this.prevPath}`);
		return true;
	}

	private lastCheck(): number {
		try {
			const state = JSON.parse(readFileSync(this.options.statePath, "utf8"));
			return typeof state.lastCheck === "number" ? state.lastCheck : 0;
		} catch {
			return 0;
		}
	}

	private async check(): Promise<void> {
		if (!existsSync(this.options.binaryPath)) {
			return;
		}
		const now = this.now();
		if (now - this.lastCheck() < CHECK_INTERVAL_MS) {
			return;
		}
		mkdirSync(dirname(this.options.statePath), { recursive: true });
		writeFileSync(this.options.statePath, JSON.stringify({ lastCheck: now }));
		const latest = await this.fetch(`${REGISTRY_URL}/${PACKAGE_NAME}/latest`);
		if (!latest.ok) {
			this.log(`update check: registry answered ${latest.status}`);
			return;
		}
		const manifest = (await latest.json()) as {
			version?: unknown;
			dist?: { tarball?: unknown; integrity?: unknown };
		};
		const { version } = manifest;
		const tarball = manifest.dist?.tarball;
		const integrity = manifest.dist?.integrity;
		if (
			typeof version !== "string" ||
			compareVersions(version, this.options.currentVersion) <= 0
		) {
			return;
		}
		const tarballUrl =
			typeof tarball === "string"
				? registryTarball(tarball, version)
				: undefined;
		if (tarballUrl === undefined) {
			this.log(`update ${version}: rejected tarball URL ${String(tarball)}`);
			return;
		}
		if (typeof integrity !== "string") {
			this.log(`update ${version}: no integrity in the registry manifest`);
			return;
		}
		const download = await this.fetch(tarballUrl.href);
		if (!download.ok) {
			this.log(`update download: ${download.status}`);
			return;
		}
		const bytes = await download.bytes();
		if (!matchesIntegrity(bytes, integrity)) {
			this.log(`update ${version}: tarball failed the integrity check`);
			return;
		}
		const entries = await new Bun.Archive(bytes).files();
		const unsafe = [...entries.keys()].find((name) => !isSafeEntry(name));
		if (unsafe !== undefined) {
			this.log(`update ${version}: rejected archive entry ${unsafe}`);
			return;
		}
		const binary = entries.get(
			binaryEntry(
				this.options.platform ?? process.platform,
				this.options.arch ?? process.arch,
			),
		);
		if (binary === undefined || binary.size === 0) {
			this.log(`update ${version}: no binary for this platform`);
			return;
		}
		const staging = `${this.nextPath}.partial`;
		rmSync(staging, { force: true });
		rmSync(this.nextPath, { force: true });
		writeFileSync(staging, await binary.bytes(), { mode: 0o600 });
		chmodSync(staging, 0o755);
		renameSync(staging, this.nextPath);
		this.staged = version;
		this.log(`staged helper ${version}`);
	}
}
