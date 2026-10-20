import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	CHECK_INTERVAL_MS,
	compareVersions,
	type Fetch,
	isRegistryTarball,
	SelfUpdater,
} from "../src/update";
import { CHAT_A, TestHelper, tempHome } from "./harness";

const LATEST = "https://registry.npmjs.org/freedia/latest";
const TARBALL = "https://registry.npmjs.org/freedia/-/freedia-1.2.0.tgz";
const ENTRY = "package/dist/freedia-helper-darwin-arm64";
const homes: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0)) {
		rmSync(home, { recursive: true, force: true });
	}
});

function sri(bytes: Uint8Array): string {
	return `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
}

async function setup(
	options: {
		latest?: string;
		files?: Record<string, string>;
		tarballUrl?: string;
		integrity?: (bytes: Uint8Array) => string;
	} = {},
) {
	const home = tempHome();
	homes.push(home);
	const binaryPath = join(home, "freedia-helper");
	writeFileSync(binaryPath, "old binary");
	const tarball = await new Bun.Archive(
		options.files ?? { [ENTRY]: "new arm64 binary" },
		{ compress: "gzip" },
	).bytes();
	const tarballUrl = options.tarballUrl ?? TARBALL;
	const requests: string[] = [];
	const fetch: Fetch = async (url) => {
		requests.push(url);
		if (url === LATEST) {
			return Response.json({
				version: options.latest ?? "1.2.0",
				dist: {
					tarball: tarballUrl,
					integrity: (options.integrity ?? sri)(tarball),
				},
			});
		}
		if (url === tarballUrl) {
			return new Response(tarball);
		}
		return new Response("not found", { status: 404 });
	};
	let now = 10 * CHECK_INTERVAL_MS;
	const logs: string[] = [];
	const updater = new SelfUpdater({
		currentVersion: "1.1.0",
		binaryPath,
		statePath: join(home, "update.json"),
		fetch,
		platform: "darwin",
		arch: "arm64",
		now: () => now,
		log: (line) => logs.push(line),
	});
	return {
		home,
		binaryPath,
		requests,
		updater,
		logs,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

function expectUntouched(s: {
	binaryPath: string;
	updater: SelfUpdater;
}): void {
	expect(readFileSync(s.binaryPath, "utf8")).toBe("old binary");
	expect(existsSync(`${s.binaryPath}.next`)).toBe(false);
	expect(existsSync(`${s.binaryPath}.next.partial`)).toBe(false);
	expect(s.updater.stagedVersion).toBeUndefined();
	expect(s.updater.applyIfReady()).toBe(false);
	expect(readFileSync(s.binaryPath, "utf8")).toBe("old binary");
}

describe("self-update", () => {
	test("compares semver numerically", () => {
		expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
		expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
		expect(compareVersions("0.9.0", "1.0.0")).toBe(-1);
	});

	test("accepts only https tarballs of freedia on registry.npmjs.org", () => {
		expect(isRegistryTarball(TARBALL)).toBe(true);
		for (const url of [
			"http://registry.npmjs.org/freedia/-/freedia-1.2.0.tgz",
			"https://evil.example/freedia/-/freedia-1.2.0.tgz",
			"https://registry.npmjs.org.evil.example/freedia/-/freedia-1.2.0.tgz",
			"https://user@registry.npmjs.org/freedia/-/freedia-1.2.0.tgz",
			"https://registry.npmjs.org/other/-/other-1.2.0.tgz",
			"https://registry.npmjs.org:8443/freedia/-/freedia-1.2.0.tgz",
			"not a url",
		]) {
			expect(isRegistryTarball(url)).toBe(false);
		}
	});

	test("downloads, verifies and stages the platform binary, then swaps it on apply", async () => {
		const s = await setup({
			files: {
				[ENTRY]: "new arm64 binary",
				"package/dist/freedia-helper-darwin-x64": "new x64 binary",
			},
		});
		await s.updater.maybeCheck();
		expect(s.requests).toEqual([LATEST, TARBALL]);
		expect(readFileSync(s.binaryPath, "utf8")).toBe("old binary");
		expect(readFileSync(`${s.binaryPath}.next`, "utf8")).toBe(
			"new arm64 binary",
		);
		expect(statSync(`${s.binaryPath}.next`).mode & 0o777).toBe(0o755);
		expect(s.updater.stagedVersion).toBe("1.2.0");
		expect(s.updater.applyIfReady()).toBe(true);
		expect(readFileSync(s.binaryPath, "utf8")).toBe("new arm64 binary");
		expect(existsSync(`${s.binaryPath}.next`)).toBe(false);
	});

	test.each([
		["another host", "https://evil.example/freedia/-/freedia-1.2.0.tgz"],
		["plain http", "http://registry.npmjs.org/freedia/-/freedia-1.2.0.tgz"],
	])("rejects a tarball on %s without downloading it", async (_name, url) => {
		const s = await setup({ tarballUrl: url });
		await s.updater.maybeCheck();
		expect(s.requests).toEqual([LATEST]);
		expectUntouched(s);
	});

	test("rejects a tarball whose sha512 does not match dist.integrity", async () => {
		const s = await setup({
			integrity: (bytes) => sri(new Uint8Array([...bytes, 0])),
		});
		await s.updater.maybeCheck();
		expect(s.requests).toEqual([LATEST, TARBALL]);
		expect(s.logs.at(-1)).toContain("integrity");
		expectUntouched(s);
	});

	test.each([
		["a missing integrity", () => ""],
		["a sha1 integrity", () => "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA="],
	])("rejects %s", async (_name, integrity) => {
		const s = await setup({ integrity });
		await s.updater.maybeCheck();
		expectUntouched(s);
	});

	test.each([
		["a parent-directory entry", "package/../../freedia-helper"],
		["an absolute entry", "/tmp/freedia-helper"],
	])("rejects an archive with %s", async (_name, entry) => {
		const s = await setup({
			files: { [ENTRY]: "new arm64 binary", [entry]: "evil" },
		});
		await s.updater.maybeCheck();
		expect(s.logs.at(-1)).toContain("rejected archive entry");
		expectUntouched(s);
	});

	test("ignores a generic binary name: only this platform's entry is used", async () => {
		const s = await setup({
			files: { "package/dist/freedia-helper": "generic" },
		});
		await s.updater.maybeCheck();
		expectUntouched(s);
	});

	test("checks at most once a day; same or older versions download nothing", async () => {
		const s = await setup({ latest: "1.1.0" });
		await s.updater.maybeCheck();
		await s.updater.maybeCheck();
		s.advance(CHECK_INTERVAL_MS - 1);
		await s.updater.maybeCheck();
		expect(s.requests).toEqual([LATEST]);
		s.advance(1);
		await s.updater.maybeCheck();
		expect(s.requests).toEqual([LATEST, LATEST]);
		expectUntouched(s);
	});

	test("the helper swaps only after in-flight chats finish, then syncs pi before the next spawn", async () => {
		const s = await setup();
		let release: () => void = () => {};
		const synced = new Promise<void>((resolve) => {
			release = resolve;
		});
		const syncCalls: number[] = [];
		const h = new TestHelper({
			home: s.home,
			env: { FREEDIA_PI_EXTRA_ARGS: "--offline --model faux/faux-1" },
			fake: { defaultScript: "abort", title: null },
			helper: {
				updater: s.updater,
				afterUpdate: () => {
					syncCalls.push(Date.now());
					return synced;
				},
			},
		});
		await h.rpc(CHAT_A, {
			id: "r1",
			type: "prompt",
			message: "URL: x\nTitle: y\n\n## Question\nlong [[long]]",
		});
		await h.waitForRpc(CHAT_A, (rpc) => rpc.id === "r1", "running");
		await h.send({ type: "helper.hello", id: "h1", maxConcurrent: 3 });
		await h.waitFor(() => s.updater.stagedVersion === "1.2.0", "staged");
		expect(readFileSync(s.binaryPath, "utf8")).toBe("old binary");
		await h.rpc(CHAT_A, { id: "r2", type: "abort" });
		await h.waitFor(() => syncCalls.length === 1, "pi sync after swap");
		expect(readFileSync(s.binaryPath, "utf8")).toBe("new arm64 binary");
		const next = h.rpc(CHAT_A, { id: "g1", type: "get_messages" });
		expect(h.chatSpawns(CHAT_A)).toHaveLength(1);
		release();
		await next;
		await h.waitForRpc(CHAT_A, (rpc) => rpc.id === "g1", "after sync");
		expect(h.chatSpawns(CHAT_A)).toHaveLength(2);
		await h.waitIdle();
	});
});
