import { existsSync } from "node:fs";
import { join } from "node:path";
import { ChatPage } from "../fixtures/chat";
import { chatProcesses, processEnv } from "../fixtures/env";
import { expect, test } from "../fixtures/test";

test.describe("ENSURE 11: read-only agent", () => {
	test.use({ helperEnv: { FREEDIA_E2E_PROBE_API_KEY: "not-a-real-key" } });

	test("omp runs with read-only tools, isolation flags and a clean environment", async ({
		freedia,
		home,
		site,
	}) => {
		const chat = await ChatPage.open(
			freedia.requireContext(),
			site.url("/article"),
		);
		await chat.open();
		await chat.send("Tell me everything [[slow]]");
		await expect(chat.assistant.first()).toContainText("Sentence 2");
		let line = "";
		await expect
			.poll(() => {
				line = chatProcesses(home)[0] ?? "";
				return line;
			})
			.toContain("--mode rpc");
		expect(line).toContain(`--cwd ${home.root}`);
		expect(line).not.toContain("--session-id");
		expect(line).toContain("--tools read,grep,glob");
		for (const flag of [
			"--no-ui",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-lsp",
		]) {
			expect(line).toContain(flag);
		}
		expect(line).toContain("--append-system-prompt");

		const pid = line.trim().split(/\s+/)[0] ?? "";
		const env = processEnv(pid);
		expect(env).toContain(`HOME=${join(home.root, "home")}`);
		expect(env).toContain(
			`PI_CODING_AGENT_DIR=${join(home.root, "omp-agent")}`,
		);
		expect(env).toContain("BUN_BE_BUN=1");
		expect(env).not.toContain("FREEDIA_E2E_PROBE_API_KEY");
		expect(env.match(/\b[A-Z0-9_]+_API_KEY=/g) ?? []).toEqual([]);
		await chat.stopButton.click();
		await expect(chat.dialog.getByText("Stopped")).toBeVisible();
	});

	test("the model can read the page file but cannot run commands or write files", async ({
		freedia,
		home,
		site,
	}) => {
		const chat = await ChatPage.open(
			freedia.requireContext(),
			site.url("/article"),
		);
		await chat.open();
		const read = await chat.ask("Read the full page [[page]]");
		await expect(read).toContainText("tool read isError=false");
		await expect(read).toContainText("A service written off too early");

		const bash = await chat.ask("Run a command [[bash]]");
		await expect(bash).toContainText("tool bash isError=true");
		const write = await chat.ask("Save a note [[write]]");
		await expect(write).toContainText("tool write isError=true");
		expect(existsSync(join(home.root, "freedia-bash-ran"))).toBe(false);
		expect(existsSync(join(home.root, "freedia-write-ran.txt"))).toBe(false);
	});

	test("the helper drops RPC bash sent over the native port", async ({
		freedia,
		home,
	}) => {
		const marker = join(home.root, "rpc-bash-ran");
		const worker = await freedia.serviceWorker();
		const replies = await worker.evaluate(async (target) => {
			const port = chrome.runtime.connectNative("com.freedia.helper");
			const chatId = crypto.randomUUID();
			const seen: { id?: string; type?: string; command?: string }[] = [];
			const done = Promise.withResolvers<void>();
			port.onMessage.addListener(
				(message: {
					rpc?: { id?: string; type?: string; command?: string };
				}) => {
					if (message.rpc?.type === "response") seen.push(message.rpc);
					if (message.rpc?.id === "after") done.resolve();
				},
			);
			port.postMessage({ type: "helper.hello", id: "hello", maxConcurrent: 3 });
			port.postMessage({
				chatId,
				rpc: { id: "bash", type: "bash", command: `touch ${target}` },
			});
			port.postMessage({ chatId, rpc: { id: "after", type: "get_state" } });
			await done.promise;
			port.disconnect();
			return seen;
		}, marker);
		expect(replies.map((rpc) => rpc.id)).toEqual(["after"]);
		expect(existsSync(marker)).toBe(false);
	});
});
