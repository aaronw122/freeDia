import { existsSync } from "node:fs";
import { join } from "node:path";
import { ChatPage } from "../fixtures/chat";
import { chatIds, chatProcesses } from "../fixtures/env";
import { expect, test } from "../fixtures/test";

test.describe("ENSURE 11: read-only agent", () => {
	test.use({ helperEnv: { FREEDIA_E2E_PROBE_API_KEY: "not-a-real-key" } });

	test("pi runs with read-only tools, isolation flags and a clean environment", async ({
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
			.toContain("--session-id ");
		const chatId = chatIds(home)[0] ?? "";
		expect(line).toContain("--mode rpc");
		expect(line).toContain(`--session-dir ${home.chats}`);
		expect(line).toContain(`--session-id ${chatId}`);
		expect(line).toContain("--tools read,grep,find,ls");
		for (const flag of [
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-mcp",
			"--no-themes",
		]) {
			expect(line).toContain(flag);
		}
		expect(line).toContain("--append-system-prompt");
		await chat.stopButton.click();
		await expect(chat.dialog.getByText("Stopped")).toBeVisible();

		const env = await chat.ask("Which environment do you run in? [[env]]");
		await expect(env).toContainText(`HOME=${home.home}`);
		await expect(env).toContainText(
			`PI_CODING_AGENT_DIR=${join(home.root, "pi-agent")}`,
		);
		await expect(env).toContainText(`cwd=${home.root}`);
		const keys = ((await env.textContent()) ?? "")
			.split("env keys: ")[1]
			?.split("HOME=")[0]
			?.trim()
			.split(/\s+/);
		expect(keys).toContain("BUN_BE_BUN");
		expect(keys).not.toContain("FREEDIA_E2E_PROBE_API_KEY");
		expect(keys?.filter((key) => /_API_KEY$|_TOKEN$/.test(key))).toEqual([]);
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
					if (message.rpc !== undefined) seen.push(message.rpc);
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
