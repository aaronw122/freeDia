#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { encodeJson, encodeMessage, FrameDecoder } from "./framing";
import { Helper, type Output } from "./helper";
import {
	bunAddPi,
	doctor,
	extensionIdsFrom,
	install,
	piSignIn,
	uninstall,
} from "./install";
import { freediaPaths } from "./paths";
import { piConfigFromEnv } from "./pi";
import { SelfUpdater } from "./update";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const compiled = import.meta.path.startsWith("/$bunfs/");

function log(line: string): void {
	process.stderr.write(`[freedia-helper] ${line}\n`);
}

async function runHost(home: string): Promise<void> {
	const paths = freediaPaths(home);
	const pi = piConfigFromEnv(paths, process.env, process.execPath);
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
		pi,
		output,
		helperVersion: pkg.version,
		log,
		...(updater === undefined ? {} : { updater }),
	});
	const sweep = setInterval(() => helper.sweepPages(), SWEEP_INTERVAL_MS);
	const decoder = new FrameDecoder();
	for await (const chunk of process.stdin) {
		for (const message of decoder.push(chunk)) {
			helper.handle(message);
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
	const pi = piConfigFromEnv(paths, process.env, process.execPath);
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
				pi,
				extensionIds,
				storeExtensionId,
				sourceBinary: sourceBinary(values.binary),
				print,
				installPi: (target, version) =>
					bunAddPi(target, version, process.execPath),
				signIn:
					values["no-login"] || !process.stdin.isTTY ? undefined : piSignIn,
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
			print("Type /login, pick a provider and finish sign-in, then /quit.");
			await piSignIn(pi);
			return 0;
		case "doctor": {
			const checks = await doctor(paths, pi, extensionIds);
			for (const check of checks) {
				print(`${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
			}
			return checks.every((check) => check.ok) ? 0 : 1;
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
