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
	registry?: string;
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

export function binaryNames(platform: string, arch: string): string[] {
	return [
		`package/dist/freedia-helper-${platform}-${arch}`,
		"package/dist/freedia-helper",
	];
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

	applyIfReady(): void {
		if (this.staged === undefined || !existsSync(this.nextPath)) {
			return;
		}
		renameSync(this.nextPath, this.options.binaryPath);
		this.log(`updated helper to ${this.staged}`);
		this.staged = undefined;
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
		const registry = this.options.registry ?? REGISTRY_URL;
		const latest = await this.fetch(`${registry}/${PACKAGE_NAME}/latest`);
		if (!latest.ok) {
			this.log(`update check: registry answered ${latest.status}`);
			return;
		}
		const manifest = (await latest.json()) as {
			version?: unknown;
			dist?: { tarball?: unknown };
		};
		const version = manifest.version;
		const tarball = manifest.dist?.tarball;
		if (
			typeof version !== "string" ||
			typeof tarball !== "string" ||
			compareVersions(version, this.options.currentVersion) <= 0
		) {
			return;
		}
		const download = await this.fetch(tarball);
		if (!download.ok) {
			this.log(`update download: ${download.status}`);
			return;
		}
		const files = await new Bun.Archive(await download.bytes()).files();
		const binary = binaryNames(
			this.options.platform ?? process.platform,
			this.options.arch ?? process.arch,
		)
			.map((name) => files.get(name))
			.find((file) => file !== undefined);
		if (binary === undefined) {
			this.log(`update ${version}: no binary for this platform`);
			return;
		}
		rmSync(this.nextPath, { force: true });
		writeFileSync(this.nextPath, await binary.bytes());
		chmodSync(this.nextPath, 0o755);
		this.staged = version;
		this.log(`staged helper ${version}`);
	}
}
