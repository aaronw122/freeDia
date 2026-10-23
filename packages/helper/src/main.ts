#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json";
import {
	encodeJson,
	encodeMessage,
	FrameDecoder,
	isOversizedFrame,
} from "./framing";
import { Helper, type Output } from "./helper";
import {
	bunAddOmp,
	doctor,
	extensionIdsFrom,
	install,
	OMP_VERSION,
	ompSignIn,
	uninstall,
} from "./install";
import { ompConfigFromEnv, ompVersion } from "./omp";
import { freediaPaths } from "./paths";
import { MAX_EXTENSION_MESSAGE_BYTES } from "./protocol";
import { SelfUpdater } from "./update";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const compiled = import.meta.path.startsWith("/$bunfs/");

function log(line: string): void {
	process.stderr.write(`[freedia-helper] ${line}\n`);
}

async function runHost(home: string): Promise<void> {
	const paths = freediaPaths(home);
	const omp = ompConfigFromEnv(paths, process.env, process.execPath);
	const write = (frames: Uint8Array[]) => {
		for (const frame of frames) {
			process.stdout.write(frame);
		}
	};
	const output: Output = {
		message: (message) => write(encodeMessage(message)),
		envelopeJson: (chatId, rpcJson) =>
			write(
				encodeJson(
					`{"chatId":${JSON.stringify(chatId)},"rpc":${rpcJson.trim()}}`,
					chatId,
				),
			),
	};
	const updater = compiled
		? new SelfUpdater({
				currentVersion: pkg.version,
				binaryPath: process.execPath,
				statePath: paths.updateState,
				log,
			})
		: undefined;
	const helper = new Helper({
		paths,
		omp,
		output,
		helperVersion: pkg.version,
		pinnedOmpVersion: OMP_VERSION,
		installOmp: (version) => bunAddOmp(paths, version, process.execPath, log),
		log,
		...(updater === undefined
			? {}
			: {
					updater,
					afterUpdate: async () => {
						const proc = Bun.spawn([process.execPath, "sync-omp"], {
							env: { ...process.env, FREEDIA_HOME: home },
							stdin: "ignore",
							stdout: "pipe",
							stderr: "pipe",
						});
						const [out, err, code] = await Promise.all([
							new Response(proc.stdout).text(),
							new Response(proc.stderr).text(),
							proc.exited,
						]);
						log(`${out}${err}`.trim());
						if (code !== 0) {
							throw new Error(`sync-omp exited with code ${code}`);
						}
					},
				}),
	});
	const sweep = setInterval(() => helper.sweepPages(), SWEEP_INTERVAL_MS);
	const decoder = new FrameDecoder(MAX_EXTENSION_MESSAGE_BYTES);
	for await (const chunk of process.stdin) {
		for (const message of decoder.push(chunk)) {
			if (isOversizedFrame(message)) {
				helper.rejectOversized(message.oversized);
			} else {
				helper.handle(message);
			}
		}
	}
	clearInterval(sweep);
	await helper.shutdown();
	process.exit(0);
}

function sourceBinary(explicit: string | undefined): string {
	if (explicit !== undefined) {
		return explicit;
	}
	if (compiled) {
		return process.execPath;
	}
	const dist = join(import.meta.dir, "..", "dist");
	const candidates = [
		join(dist, `freedia-helper-${process.platform}-${process.arch}`),
		join(dist, "freedia-helper"),
	];
	const found = candidates.find((path) => existsSync(path));
	if (found === undefined) {
		throw new Error(
			`No helper binary found in ${dist}. Run \`bun run build\` in packages/helper first.`,
		);
	}
	return found;
}

async function runCli(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			home: { type: "string" },
			binary: { type: "string" },
			"extension-id": { type: "string", multiple: true },
			"store-extension-id": { type: "string" },
			"no-login": { type: "boolean" },
			"no-open": { type: "boolean" },
			purge: { type: "boolean" },
		},
	});
	const home = values.home ?? process.env.FREEDIA_HOME ?? homedir();
	const paths = freediaPaths(home);
	const omp = ompConfigFromEnv(paths, process.env, process.execPath);
	const storeExtensionId =
		values["store-extension-id"] ?? process.env.FREEDIA_STORE_EXTENSION_ID;
	const extensionIds = extensionIdsFrom(
		values["extension-id"]?.join(",") ?? process.env.FREEDIA_EXTENSION_IDS,
		storeExtensionId,
	);
	const print = (line: string) => console.log(line);
	switch (positionals[0]) {
		case "install":
			await install({
				paths,
				omp,
				extensionIds,
				storeExtensionId,
				sourceBinary: sourceBinary(values.binary),
				print,
				installOmp: (target, version) =>
					bunAddOmp(target, version, process.execPath, print),
				signIn:
					values["no-login"] || !process.stdin.isTTY ? undefined : ompSignIn,
				openUrl: values["no-open"]
					? undefined
					: async (url) => {
							await Bun.spawn(["open", url]).exited;
						},
			});
			return 0;
		case "uninstall":
			uninstall({ paths, storeExtensionId, print }, values.purge === true);
			return 0;
		case "login":
			await ompSignIn(omp);
			return 0;
		case "doctor": {
			const checks = await doctor(paths, omp, extensionIds);
			for (const check of checks) {
				print(`${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
			}
			return checks.every((check) => check.ok) ? 0 : 1;
		}
		case "sync-omp": {
			const installed = ompVersion(paths);
			if (installed === OMP_VERSION) {
				print(`omp ${installed} matches the helper`);
				return 0;
			}
			print(`Installing omp ${OMP_VERSION} (was ${installed || "missing"})…`);
			await bunAddOmp(paths, OMP_VERSION, process.execPath, print);
			return 0;
		}
		case "version":
			print(pkg.version);
			return 0;
		default:
			print(
				"Usage: freedia install [--no-login] [--no-open] | uninstall [--purge] | login | doctor | version",
			);
			return 2;
	}
}

const argv = process.argv.slice(2);
if (argv[0]?.startsWith("chrome-extension://")) {
	await runHost(process.env.FREEDIA_HOME ?? homedir());
} else {
	process.exit(await runCli(argv));
}
