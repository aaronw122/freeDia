import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { plugin } from "bun";

const runtimeGlobals = [
	"fetch",
	"Request",
	"Response",
	"Headers",
	"URL",
	"URLSearchParams",
	"AbortController",
	"AbortSignal",
	"ReadableStream",
	"WritableStream",
	"TransformStream",
	"TextEncoder",
	"TextDecoder",
	"Blob",
	"File",
	"FormData",
	"WebSocket",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"queueMicrotask",
	"structuredClone",
	"crypto",
	"performance",
	"console",
] as const;

const runtimeDescriptors = runtimeGlobals.flatMap((key) => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
	return descriptor ? [[key, descriptor] as const] : [];
});

GlobalRegistrator.register({ url: "https://example.com/" });

for (const [key, descriptor] of runtimeDescriptors) {
	Object.defineProperty(globalThis, key, { ...descriptor, configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });


plugin({
	name: "import-as-text",
	setup(build) {
		build.onResolve({ filter: /(\.css|\?inline|\?raw)$/ }, (args) => ({
			path: resolve(dirname(args.importer), args.path.replace(/\?\w+$/, "")),
			namespace: "import-as-text",
		}));
		build.onLoad({ filter: /.*/, namespace: "import-as-text" }, (args) => ({
			contents: `export default ${JSON.stringify(readFileSync(args.path, "utf8"))};`,
			loader: "js",
		}));
	},
});
