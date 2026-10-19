import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const fixtureHtml = `<!doctype html><meta charset="utf-8"><title>freeDia S2 fixture</title>
<h1>freeDia S2 fixture</h1>
<p id="text">Highlight me. Lorem ipsum dolor sit amet.</p>
<button id="page-open-pip">page-world: open PiP</button>
<script>
const pageState = { world: "main", hasPipApi: "documentPictureInPicture" in window, keys: [], pip: [] };
const report = () => document.documentElement.setAttribute("data-spike-page", JSON.stringify(pageState));
const openPip = async (trigger) => {
	const entry = { trigger, userActivation: navigator.userActivation.isActive };
	pageState.pip.push(entry);
	try {
		const w = await documentPictureInPicture.requestWindow({ width: 320, height: 240 });
		entry.result = "opened";
		w.document.body.textContent = "page-world PiP";
		w.addEventListener("pagehide", () => { entry.closedAt = Date.now(); report(); });
	} catch (error) {
		entry.result = "error: " + error.name + ": " + error.message;
	}
	report();
};
document.getElementById("page-open-pip").addEventListener("click", () => openPip("page-click"));
document.addEventListener("keydown", (event) => {
	pageState.keys.push({ key: event.key, code: event.code, meta: event.metaKey, shift: event.shiftKey, defaultPrevented: event.defaultPrevented });
	if (event.ctrlKey && event.altKey && event.code === "KeyP") openPip("page-keydown-ctrl-alt-p");
	report();
});
documentPictureInPicture.addEventListener("enter", () => { pageState.enterEvents = (pageState.enterEvents ?? 0) + 1; report(); });
report();
if (location.search === "?auto") setTimeout(() => openPip("page-load-no-activation"), 100);
</script>`;

export async function startHttpsFixture(
	port = 0,
): Promise<{ server: Server; origin: string }> {
	const dir = mkdtempSync(join(tmpdir(), "freedia-s2-"));
	const key = join(dir, "key.pem");
	const cert = join(dir, "cert.pem");
	execFileSync("openssl", [
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		key,
		"-out",
		cert,
		"-days",
		"1",
		"-subj",
		"/CN=localhost",
		"-addext",
		"subjectAltName=DNS:localhost,IP:127.0.0.1",
	]);
	const server = createServer(
		{ key: readFileSync(key), cert: readFileSync(cert) },
		(_req, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.end(fixtureHtml);
		},
	);
	await new Promise<void>((resolve) =>
		server.listen(port, "127.0.0.1", resolve),
	);
	const address = server.address();
	const actualPort =
		typeof address === "object" && address ? address.port : port;
	return { server, origin: `https://localhost:${actualPort}` };
}
