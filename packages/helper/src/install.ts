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
import { type OmpConfig, ompEnv, ompVersion, runOneShot } from "./omp";
import type { FreediaPaths } from "./paths";
import { NATIVE_HOST_NAME } from "./protocol";

export const DEV_EXTENSION_ID = "hnjcpmkohkooncneepdhfodblhhgimnh";
export const OMP_VERSION = pkg.dependencies["@oh-my-pi/pi-coding-agent"];
export const STORE_UPDATE_URL =
	"https://clients2.google.com/service/update2/crx";

export interface InstallContext {
	paths: FreediaPaths;
	omp: OmpConfig;
	extensionIds: string[];
	storeExtensionId: string | undefined;
	sourceBinary: string;
	print: (line: string) => void;
	installOmp: (paths: FreediaPaths, version: string) => Promise<void>;
	signIn: ((omp: OmpConfig) => Promise<void>) | undefined;
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

export async function bunAddOmp(
	paths: FreediaPaths,
	version: string,
	execPath: string,
	log: (line: string) => void,
): Promise<void> {
	mkdirSync(paths.ompDir, { recursive: true });
	const manifest = join(paths.ompDir, "package.json");
	if (!existsSync(manifest))
		writeFileSync(
			manifest,
			`${JSON.stringify({ name: "freedia-omp", private: true }, null, 2)}\n`,
		);
	const proc = Bun.spawn(
		[execPath, "add", "--exact", `@oh-my-pi/pi-coding-agent@${version}`],
		{
			cwd: paths.ompDir,
			env: { ...process.env, BUN_BE_BUN: "1" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	for (const line of `${out}\n${err}`.split("\n"))
		if (line.trim() !== "") log(line);
	if (code !== 0) throw new Error(`bun add exited with code ${code}`);
	const installed = ompVersion(paths);
	if (installed !== version)
		throw new Error(
			`bun add finished but omp's package.json reports ${installed || "nothing"}, expected ${version}`,
		);
}

export async function ompSignIn(omp: OmpConfig): Promise<void> {
	const proc = Bun.spawn([omp.execPath, omp.paths.ompCli, "login"], {
		cwd: omp.paths.root,
		env: { ...ompEnv(omp), TERM: process.env.TERM ?? "xterm-256color" },
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	await proc.exited;
}

export async function readyProviders(omp: OmpConfig): Promise<string[]> {
	if (!existsSync(omp.paths.ompCli)) return [];
	const records = await runOneShot(
		omp,
		{ id: "auth", type: "get_login_providers" },
		(record) => record.type === "response",
		30_000,
	);
	const response = records.find(
		(record) => record.command === "get_login_providers",
	);
	const data = response?.data;
	const providers =
		data && typeof data === "object" && "providers" in data
			? data.providers
			: undefined;
	if (!Array.isArray(providers)) return [];
	return providers.flatMap((provider) =>
		provider &&
		typeof provider === "object" &&
		"authenticated" in provider &&
		provider.authenticated === true &&
		"id" in provider &&
		typeof provider.id === "string"
			? [provider.id]
			: [],
	);
}

export async function install(ctx: InstallContext): Promise<void> {
	const { paths, print } = ctx;
	for (const directory of [
		paths.bin,
		paths.chats,
		paths.ompAgent,
		paths.fakeHome,
	])
		mkdirSync(directory, { recursive: true });
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
	if (ompVersion(paths) === OMP_VERSION)
		print(`omp ${OMP_VERSION} already installed: ${paths.ompDir}`);
	else {
		print(`Installing omp ${OMP_VERSION} into ${paths.ompDir}…`);
		await ctx.installOmp(paths, OMP_VERSION);
		print(`omp ${ompVersion(paths)} installed`);
	}
	const ready = await readyProviders(ctx.omp);
	if (ready.length > 0) print(`Signed in: ${ready.join(", ")}`);
	else if (ctx.signIn !== undefined) {
		print("Sign in to an AI provider.");
		await ctx.signIn(ctx.omp);
	} else print("Not signed in yet. Run `bunx freedia login` to sign in.");
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
	if (ctx.openUrl !== undefined) await ctx.openUrl(storeUrl);
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
		paths.ompDir,
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
	if (!purge)
		print(
			`Kept your chats (${paths.chats}) and sign-ins (${paths.ompAgent}); \`freedia uninstall --purge\` removes them.`,
		);
}

export interface DoctorCheck {
	name: string;
	ok: boolean;
	detail: string;
}

export async function doctor(
	paths: FreediaPaths,
	omp: OmpConfig,
	extensionIds: string[],
): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [
		{
			name: "helper binary",
			ok: existsSync(paths.binary),
			detail: paths.binary,
		},
	];
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
				: paths.nativeHostManifest,
	});
	const installed = ompVersion(paths);
	checks.push({
		name: "omp",
		ok: installed === OMP_VERSION,
		detail:
			installed === ""
				? `missing: ${paths.ompCli}`
				: `${installed} (pinned ${OMP_VERSION})`,
	});
	if (installed !== "") {
		const proc = Bun.spawn([omp.execPath, paths.ompCli, "--version"], {
			cwd: paths.root,
			env: ompEnv(omp),
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
			name: "omp runs",
			ok: code === 0 && out.trim() === `omp/${installed}`,
			detail: code === 0 ? `omp --version → ${out.trim()}` : err.trim(),
		});
		const ready = await readyProviders(omp);
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
