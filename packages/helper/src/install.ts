import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import type { FreediaPaths } from "./paths";
import {
	authCheck,
	ISOLATION_FLAGS,
	type PiConfig,
	piEnv,
	piVersion,
} from "./pi";
import { NATIVE_HOST_NAME } from "./protocol";

export const DEV_EXTENSION_ID = "hnjcpmkohkooncneepdhfodblhhgimnh";
export const PI_VERSION = pkg.dependencies["@earendil-works/pi-coding-agent"];
export const STORE_UPDATE_URL =
	"https://clients2.google.com/service/update2/crx";
export const SIGN_IN_PROVIDERS = [
	"anthropic",
	"openai-codex",
	"openai",
	"google",
	"github-copilot",
	"openrouter",
	"groq",
];

export interface InstallContext {
	paths: FreediaPaths;
	pi: PiConfig;
	extensionIds: string[];
	storeExtensionId: string | undefined;
	sourceBinary: string;
	print: (line: string) => void;
	installPi: (paths: FreediaPaths, version: string) => Promise<void>;
	signIn: ((pi: PiConfig) => Promise<void>) | undefined;
	openUrl: ((url: string) => Promise<void>) | undefined;
}

export interface NativeHostManifest {
	name: string;
	description: string;
	path: string;
	type: "stdio";
	allowed_origins: string[];
}

export function nativeHostManifest(
	binary: string,
	extensionIds: string[],
): NativeHostManifest {
	return {
		name: NATIVE_HOST_NAME,
		description: "freeDia helper",
		path: binary,
		type: "stdio",
		allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
	};
}

export function extensionIdsFrom(
	raw: string | undefined,
	storeId: string | undefined,
): string[] {
	const ids = (raw ?? DEV_EXTENSION_ID)
		.split(",")
		.map((id) => id.trim())
		.filter((id) => /^[a-p]{32}$/.test(id));
	return [...new Set(storeId === undefined ? ids : [...ids, storeId])];
}

export async function bunAddPi(
	paths: FreediaPaths,
	version: string,
	execPath: string,
): Promise<void> {
	mkdirSync(paths.piDir, { recursive: true });
	const manifest = join(paths.piDir, "package.json");
	if (!existsSync(manifest)) {
		writeFileSync(
			manifest,
			`${JSON.stringify({ name: "freedia-pi", private: true }, null, 2)}\n`,
		);
	}
	const proc = Bun.spawn(
		[execPath, "add", "--exact", `@earendil-works/pi-coding-agent@${version}`],
		{
			cwd: paths.piDir,
			env: { ...process.env, BUN_BE_BUN: "1" },
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(`bun add exited with code ${code}`);
	}
}

export async function piSignIn(pi: PiConfig): Promise<void> {
	const proc = Bun.spawn(
		[
			pi.execPath,
			pi.paths.piCli,
			"--no-session",
			"--no-tools",
			...ISOLATION_FLAGS,
		],
		{
			cwd: pi.paths.root,
			env: { ...piEnv(pi), TERM: process.env.TERM ?? "xterm-256color" },
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	await proc.exited;
}

export async function install(ctx: InstallContext): Promise<void> {
	const { paths, print } = ctx;
	mkdirSync(paths.bin, { recursive: true });
	mkdirSync(paths.chats, { recursive: true });
	mkdirSync(paths.piAgent, { recursive: true });
	const staging = `${paths.binary}.installing`;
	copyFileSync(ctx.sourceBinary, staging);
	chmodSync(staging, 0o755);
	renameSync(staging, paths.binary);
	print(`Helper installed: ${paths.binary}`);

	mkdirSync(paths.nativeHostDir, { recursive: true });
	writeFileSync(
		paths.nativeHostManifest,
		`${JSON.stringify(nativeHostManifest(paths.binary, ctx.extensionIds), null, 2)}\n`,
	);
	print(`Native host manifest: ${paths.nativeHostManifest}`);

	if (piVersion(paths) === PI_VERSION) {
		print(`pi ${PI_VERSION} already installed: ${paths.piDir}`);
	} else {
		print(`Installing pi ${PI_VERSION} into ${paths.piDir}…`);
		await ctx.installPi(paths, PI_VERSION);
		print(`pi ${piVersion(paths)} installed`);
	}

	const ready = await readyProviders(ctx.pi);
	if (ready.length > 0) {
		print(`Signed in: ${ready.join(", ")}`);
	} else if (ctx.signIn !== undefined) {
		print(
			"Sign in to an AI provider: type /login, pick a provider, then /quit.",
		);
		await ctx.signIn(ctx.pi);
	} else {
		print("Not signed in yet. Run `bunx freedia login` to sign in.");
	}

	if (ctx.storeExtensionId === undefined) {
		print(
			"Extension: load packages/extension/.output/chrome-mv3 unpacked at chrome://extensions (Developer mode).",
		);
		return;
	}
	mkdirSync(paths.externalExtensionsDir, { recursive: true });
	writeFileSync(
		join(paths.externalExtensionsDir, `${ctx.storeExtensionId}.json`),
		`${JSON.stringify({ external_update_url: STORE_UPDATE_URL }, null, 2)}\n`,
	);
	const storeUrl = `https://chromewebstore.google.com/detail/${ctx.storeExtensionId}`;
	if (ctx.openUrl !== undefined) {
		await ctx.openUrl(storeUrl);
	}
	print(`Extension: click "Add to Chrome" at ${storeUrl}`);
}

export function uninstall(
	ctx: Pick<InstallContext, "paths" | "storeExtensionId" | "print">,
	purge: boolean,
): void {
	const { paths, print } = ctx;
	const removed = [
		paths.nativeHostManifest,
		paths.bin,
		paths.piDir,
		paths.pages,
		paths.updateState,
		...(ctx.storeExtensionId === undefined
			? []
			: [join(paths.externalExtensionsDir, `${ctx.storeExtensionId}.json`)]),
		...(purge ? [paths.root] : []),
	];
	for (const path of removed) {
		rmSync(path, { recursive: true, force: true });
		print(`Removed ${path}`);
	}
	if (!purge) {
		print(
			`Kept your chats (${paths.chats}) and sign-ins (${paths.piAgent}); \`freedia uninstall --purge\` removes them.`,
		);
	}
}

export async function readyProviders(pi: PiConfig): Promise<string[]> {
	if (!existsSync(pi.paths.piCli)) {
		return [];
	}
	const results = await Promise.all(
		SIGN_IN_PROVIDERS.map(async (provider) => ({
			provider,
			status: (await authCheck(pi, provider)).status,
		})),
	);
	return results
		.filter((result) => result.status === "ready")
		.map((result) => result.provider);
}

export interface DoctorCheck {
	name: string;
	ok: boolean;
	detail: string;
}

export async function doctor(
	paths: FreediaPaths,
	pi: PiConfig,
	extensionIds: string[],
): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	checks.push({
		name: "helper binary",
		ok: existsSync(paths.binary),
		detail: paths.binary,
	});
	let manifest: Partial<NativeHostManifest> | undefined;
	try {
		manifest = JSON.parse(readFileSync(paths.nativeHostManifest, "utf8"));
	} catch {}
	const origins = manifest?.allowed_origins ?? [];
	const missingOrigins = extensionIds
		.map((id) => `chrome-extension://${id}/`)
		.filter((origin) => !origins.includes(origin));
	checks.push({
		name: "native host manifest",
		ok:
			manifest?.name === NATIVE_HOST_NAME &&
			manifest.path === paths.binary &&
			missingOrigins.length === 0,
		detail:
			manifest === undefined
				? `missing: ${paths.nativeHostManifest}`
				: missingOrigins.length > 0
					? `missing origins: ${missingOrigins.join(", ")}`
					: manifest.path === paths.binary
						? paths.nativeHostManifest
						: `points to ${manifest.path}, expected ${paths.binary}`,
	});
	const installed = piVersion(paths);
	checks.push({
		name: "pi",
		ok: installed === PI_VERSION,
		detail:
			installed === ""
				? `missing: ${paths.piCli}`
				: `${installed} (pinned ${PI_VERSION})`,
	});
	if (installed !== "") {
		const proc = Bun.spawn([pi.execPath, paths.piCli, "--version"], {
			cwd: paths.root,
			env: piEnv(pi),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		checks.push({
			name: "pi runs",
			ok: code === 0 && out.trim() === installed,
			detail: code === 0 ? `pi --version → ${out.trim()}` : err.trim(),
		});
		const ready = await readyProviders(pi);
		checks.push({
			name: "signed in",
			ok: ready.length > 0,
			detail:
				ready.length > 0
					? ready.join(", ")
					: "no provider; run `bunx freedia login`",
		});
	}
	return checks;
}
