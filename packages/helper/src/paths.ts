import { join } from "node:path";
import { NATIVE_HOST_NAME } from "./protocol";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

export interface FreediaPaths {
	home: string;
	root: string;
	chats: string;
	pages: string;
	piDir: string;
	piPackage: string;
	piCli: string;
	piAgent: string;
	bin: string;
	binary: string;
	updateState: string;
	nativeHostDir: string;
	nativeHostManifest: string;
	externalExtensionsDir: string;
}

export function freediaPaths(home: string): FreediaPaths {
	const root = join(home, ".freedia");
	const piDir = join(root, "pi");
	const piPackage = join(piDir, "node_modules", PI_PACKAGE);
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
		piDir,
		piPackage,
		piCli: join(piPackage, "dist", "bundle", "cli.js"),
		piAgent: join(root, "pi-agent"),
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
