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
	DEV_EXTENSION_ID,
	doctor,
	extensionIdsFrom,
	type InstallContext,
	install,
	PI_VERSION,
	uninstall,
} from "../src/install";
import { freediaPaths } from "../src/paths";
import { piConfigFromEnv } from "../src/pi";
import { installFakePi, tempHome } from "./harness";

const STORE_ID = "abcdefghijklmnopabcdefghijklmnop";
const homes: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0)) {
		rmSync(home, { recursive: true, force: true });
	}
});

function context(overrides: Partial<InstallContext> = {}) {
	const home = tempHome();
	homes.push(home);
	const paths = freediaPaths(home);
	const source = join(home, "source-helper");
	writeFileSync(source, "#!/bin/sh\necho helper\n");
	writeFileSync(
		join(home, "fake-pi.json"),
		JSON.stringify({ auth: { anthropic: "ready" } }),
	);
	const lines: string[] = [];
	const installs: string[] = [];
	const ctx: InstallContext = {
		paths,
		pi: piConfigFromEnv(
			paths,
			{ PATH: process.env.PATH ?? "" },
			process.execPath,
		),
		extensionIds: [DEV_EXTENSION_ID],
		storeExtensionId: undefined,
		sourceBinary: source,
		print: (line) => lines.push(line),
		installPi: async (target, version) => {
			installs.push(version);
			installFakePi(target, version);
		},
		signIn: undefined,
		openUrl: undefined,
		...overrides,
	};
	return { ctx, paths, lines, installs, home };
}

describe("freedia install", () => {
	test("writes the binary, pi and ONE native host manifest in Chrome's folder, creating it", async () => {
		const { ctx, paths, installs, home } = context();
		expect(existsSync(join(home, "Library"))).toBe(false);
		await install(ctx);
		expect(paths.nativeHostManifest).toBe(
			join(
				home,
				"Library",
				"Application Support",
				"Google",
				"Chrome",
				"NativeMessagingHosts",
				"com.freedia.helper.json",
			),
		);
		expect(JSON.parse(readFileSync(paths.nativeHostManifest, "utf8"))).toEqual({
			name: "com.freedia.helper",
			description: "freeDia helper",
			path: join(home, ".freedia", "bin", "freedia-helper"),
			type: "stdio",
			allowed_origins: [`chrome-extension://${DEV_EXTENSION_ID}/`],
		});
		expect(readFileSync(paths.binary, "utf8")).toBe("#!/bin/sh\necho helper\n");
		expect(statSync(paths.binary).mode & 0o111).toBe(0o111);
		expect(installs).toEqual([PI_VERSION]);
		expect(PI_VERSION).toBe("1.3.0");
		expect(
			existsSync(join(home, "Library", "Application Support", "Dia")),
		).toBe(false);
	});

	test("skips the pi install when the pinned version is present and is idempotent", async () => {
		const { ctx, installs, paths } = context();
		await install(ctx);
		await install(ctx);
		expect(installs).toEqual([PI_VERSION]);
		expect(
			JSON.parse(readFileSync(paths.nativeHostManifest, "utf8"))
				.allowed_origins,
		).toHaveLength(1);
	});

	test("a Store ID joins allowed_origins, gets an External Extensions file and opens the Store", async () => {
		const opened: string[] = [];
		const { ctx, paths } = context({
			storeExtensionId: STORE_ID,
			extensionIds: extensionIdsFrom(undefined, STORE_ID),
			openUrl: async (url) => {
				opened.push(url);
			},
		});
		await install(ctx);
		expect(
			JSON.parse(readFileSync(paths.nativeHostManifest, "utf8"))
				.allowed_origins,
		).toEqual([
			`chrome-extension://${DEV_EXTENSION_ID}/`,
			`chrome-extension://${STORE_ID}/`,
		]);
		expect(
			JSON.parse(
				readFileSync(
					join(paths.externalExtensionsDir, `${STORE_ID}.json`),
					"utf8",
				),
			),
		).toEqual({
			external_update_url: "https://clients2.google.com/service/update2/crx",
		});
		expect(opened).toEqual([
			`https://chromewebstore.google.com/detail/${STORE_ID}`,
		]);
	});

	test("runs sign-in only when no provider is ready", async () => {
		let signedIn = 0;
		const ready = context({ signIn: async () => void signedIn++ });
		await install(ready.ctx);
		expect(signedIn).toBe(0);
		expect(ready.lines).toContain("Signed in: anthropic");
		const fresh = context({ signIn: async () => void signedIn++ });
		writeFileSync(join(fresh.home, "fake-pi.json"), "{}");
		await install(fresh.ctx);
		expect(signedIn).toBe(1);
	});

	test("extension IDs: invalid ones are ignored, duplicates merged", () => {
		expect(
			extensionIdsFrom(`${DEV_EXTENSION_ID}, nope ,${STORE_ID}`, STORE_ID),
		).toEqual([DEV_EXTENSION_ID, STORE_ID]);
	});
});

describe("freedia doctor and uninstall", () => {
	test("doctor fails before install and passes after", async () => {
		const { ctx, paths } = context();
		const before = await doctor(paths, ctx.pi, ctx.extensionIds);
		expect(
			before.filter((check) => !check.ok).map((check) => check.name),
		).toEqual(["helper binary", "native host manifest", "pi"]);
		await install(ctx);
		const after = await doctor(paths, ctx.pi, ctx.extensionIds);
		expect(after.map((check) => [check.name, check.ok])).toEqual([
			["helper binary", true],
			["native host manifest", true],
			["pi", true],
			["pi runs", true],
			["signed in", true],
		]);
	});

	test("doctor flags a manifest missing an extension origin", async () => {
		const { ctx, paths } = context();
		await install(ctx);
		const checks = await doctor(paths, ctx.pi, [DEV_EXTENSION_ID, STORE_ID]);
		expect(
			checks.find((check) => check.name === "native host manifest"),
		).toEqual({
			name: "native host manifest",
			ok: false,
			detail: `missing origins: chrome-extension://${STORE_ID}/`,
		});
	});

	test("uninstall removes the helper, manifest and pi but keeps chats and sign-ins", async () => {
		const { ctx, paths } = context();
		await install(ctx);
		writeFileSync(join(paths.chats, "x.jsonl"), "{}");
		uninstall(ctx, false);
		expect(existsSync(paths.nativeHostManifest)).toBe(false);
		expect(existsSync(paths.binary)).toBe(false);
		expect(existsSync(paths.piDir)).toBe(false);
		expect(existsSync(join(paths.chats, "x.jsonl"))).toBe(true);
		expect(existsSync(paths.piAgent)).toBe(true);
		uninstall(ctx, true);
		expect(existsSync(paths.root)).toBe(false);
	});
});
