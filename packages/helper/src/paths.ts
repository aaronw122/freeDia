import { join } from "node:path";
import { NATIVE_HOST_NAME } from "./protocol";

export const OMP_PACKAGE = "@oh-my-pi/pi-coding-agent";

export interface FreediaPaths {
	home: string;
	root: string;
	chats: string;
	pages: string;
	ompDir: string;
	ompPackage: string;
	ompCli: string;
	ompAgent: string;
	fakeHome: string;
	bin: string;
	binary: string;
	updateState: string;
	nativeHostDir: string;
	nativeHostManifest: string;
	externalExtensionsDir: string;
}

export function freediaPaths(home: string): FreediaPaths {
	const root = join(home, ".freedia");
	const ompDir = join(root, "omp");
	const ompPackage = join(ompDir, "node_modules", OMP_PACKAGE);
	const bin = join(root, "bin");
	const chrome = join(
		home,
		"Library",
		"Application Support",
		"Google",
		"Chrome",
	);
	const nativeHostDir = join(chrome, "NativeMessagingHosts");
	return {
		home,
		root,
		chats: join(root, "chats"),
		pages: join(root, "pages"),
		ompDir,
		ompPackage,
		ompCli: join(ompPackage, "dist", "cli.js"),
		ompAgent: join(root, "omp-agent"),
		fakeHome: join(root, "home"),
		bin,
		binary: join(bin, "freedia-helper"),
		updateState: join(root, "update.json"),
		nativeHostDir,
		nativeHostManifest: join(nativeHostDir, `${NATIVE_HOST_NAME}.json`),
		externalExtensionsDir: join(chrome, "External Extensions"),
	};
}

export function pageFile(paths: FreediaPaths, chatId: string): string {
	return join(paths.pages, `${chatId}.md`);
}
