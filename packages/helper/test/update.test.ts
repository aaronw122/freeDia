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
	SelfUpdater,
} from "../src/update";
import { CHAT_A, TestHelper, tempHome } from "./harness";

const REGISTRY = "https://registry.test";
const TARBALL = `${REGISTRY}/freedia/-/freedia-1.2.0.tgz`;
const homes: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0)) {
		rmSync(home, { recursive: true, force: true });
	}
});

async function tarball(files: Record<string, string>): Promise<Uint8Array> {
	return new Bun.Archive(files, { compress: "gzip" }).bytes();
}

function setup(latest: string, files: Record<string, string>) {
	const home = tempHome();
	homes.push(home);
	const binaryPath = join(home, "freedia-helper");
	writeFileSync(binaryPath, "old binary");
	const requests: string[] = [];
	const fetch: Fetch = async (url) => {
		requests.push(url);
		if (url === `${REGISTRY}/freedia/latest`) {
			return Response.json({ version: latest, dist: { tarball: TARBALL } });
		}
		if (url === TARBALL) {
			return new Response(await tarball(files));
		}
		return new Response("not found", { status: 404 });
	};
	let now = 10 * CHECK_INTERVAL_MS;
	const updater = new SelfUpdater({
		currentVersion: "1.1.0",
		binaryPath,
		statePath: join(home, "update.json"),
		fetch,
		registry: REGISTRY,
		platform: "darwin",
		arch: "arm64",
		now: () => now,
	});
	return {
		home,
		binaryPath,
		requests,
		updater,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("self-update", () => {
	test("compares semver numerically", () => {
		expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
		expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
		expect(compareVersions("0.9.0", "1.0.0")).toBe(-1);
	});

	test("downloads a newer platform binary next to the old one and swaps it on apply", async () => {
		const s = setup("1.2.0", {
			"package/dist/freedia-helper-darwin-arm64": "new arm64 binary",
			"package/dist/freedia-helper-darwin-x64": "new x64 binary",
		});
		await s.updater.maybeCheck();
		expect(s.requests).toEqual([`${REGISTRY}/freedia/latest`, TARBALL]);
		expect(readFileSync(s.binaryPath, "utf8")).toBe("old binary");
		expect(readFileSync(`${s.binaryPath}.next`, "utf8")).toBe(
			"new arm64 binary",
		);
		expect(statSync(`${s.binaryPath}.next`).mode & 0o111).toBe(0o111);
		expect(s.updater.stagedVersion).toBe("1.2.0");
		s.updater.applyIfReady();
		expect(readFileSync(s.binaryPath, "utf8")).toBe("new arm64 binary");
		expect(existsSync(`${s.binaryPath}.next`)).toBe(false);
	});

	test("checks at most once a day", async () => {
		const s = setup("1.1.0", {});
		await s.updater.maybeCheck();
		await s.updater.maybeCheck();
		s.advance(CHECK_INTERVAL_MS - 1);
		await s.updater.maybeCheck();
		expect(s.requests).toHaveLength(1);
		s.advance(1);
		await s.updater.maybeCheck();
		expect(s.requests).toHaveLength(2);
	});

	test("same or older version downloads nothing", async () => {
		const s = setup("1.0.5", { "package/dist/freedia-helper": "x" });
		await s.updater.maybeCheck();
		expect(s.requests).toEqual([`${REGISTRY}/freedia/latest`]);
		s.updater.applyIfReady();
		expect(readFileSync(s.binaryPath, "utf8")).toBe("old binary");
	});

	test("a tarball without a binary for this platform stages nothing", async () => {
		const s = setup("1.2.0", { "package/dist/freedia-helper-linux-x64": "x" });
		await s.updater.maybeCheck();
		expect(existsSync(`${s.binaryPath}.next`)).toBe(false);
		expect(s.updater.stagedVersion).toBeUndefined();
	});

	test("the helper swaps only after in-flight chats finish", async () => {
		const s = setup("1.2.0", {
			"package/dist/freedia-helper-darwin-arm64": "new",
		});
		const h = new TestHelper({
			home: s.home,
			env: { FREEDIA_PI_EXTRA_ARGS: "--offline --model faux/faux-1" },
			fake: { defaultScript: "abort", title: null },
			helper: { updater: s.updater },
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
		await h.waitIdle();
		expect(readFileSync(s.binaryPath, "utf8")).toBe("new");
	});
});
