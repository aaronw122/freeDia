import { execFileSync } from "node:child_process";
import { ChatPage } from "../fixtures/chat";
import {
	chatIds,
	chatProcesses,
	helperPids,
	sessionEntries,
	waitForNoOmp,
} from "../fixtures/env";
import { expect, test } from "../fixtures/test";

const SLOW = "Walk me through the whole article [[slow]]";

test("ENSURE 14: two tabs stream at once, stopping one leaves the other, and the stopped chat resumes", async ({
	freedia,
	home,
	site,
}) => {
	const context = freedia.requireContext();
	const first = await ChatPage.open(context, site.url("/article"));
	await first.open();
	const second = await ChatPage.open(context, site.url("/short"));
	await second.open();

	await first.send(SLOW);
	await second.send(SLOW);
	await expect(first.assistant.first()).toContainText("Sentence 3");
	await expect(second.assistant.first()).toContainText("Sentence 3");
	await expect(first.stopButton).toBeVisible();
	await expect(second.stopButton).toBeVisible();
	expect(chatProcesses(home)).toHaveLength(2);

	await first.stopButton.click();
	await expect(first.dialog.getByText("Stopped")).toBeVisible();
	await expect(first.sendButton).toBeVisible();
	await expect(second.stopButton).toBeVisible();
	const secondBefore = (await second.assistant.first().textContent()) ?? "";
	await expect
		.poll(
			async () => ((await second.assistant.first().textContent()) ?? "").length,
		)
		.toBeGreaterThan(secondBefore.length);
	await second.waitForReplies(1);
	await expect(second.assistant.first()).toContainText("Sentence 60");
	await expect(second.dialog.getByText("Stopped")).toHaveCount(0);

	await waitForNoOmp(home);
	const firstChat = chatIds(home).find((id) =>
		sessionEntries(home, id).some(
			(entry) => entry.message?.stopReason === "aborted",
		),
	);
	expect(firstChat).toBeDefined();

	const resumed = await first.ask("Where did you stop?");
	await expect(resumed).toContainText(`Earlier questions: “${SLOW}”`);
	await expect(resumed).toContainText("Earlier replies: 0");
	await waitForNoOmp(home);
});

test("closing the chat mid-reply asks to cancel, then stops the reply", async ({
	freedia,
	home,
	site,
}) => {
	const chat = await ChatPage.open(
		freedia.requireContext(),
		site.url("/article"),
	);
	await chat.open();
	await chat.send(SLOW);
	await expect(chat.assistant.first()).toContainText("Sentence 2");
	await chat.button("Close").click();
	const confirm = chat.dialog.getByRole("alertdialog", {
		name: "Cancel this response?",
	});
	await confirm.getByRole("button", { name: "Keep waiting" }).click();
	await expect(confirm).toBeHidden();
	await expect(chat.stopButton).toBeVisible();
	await chat.button("Close").click();
	await confirm.getByRole("button", { name: "Cancel response" }).click();
	await expect(chat.dialog).toBeHidden();
	await waitForNoOmp(home);
	const [chatId] = chatIds(home);
	const reply = sessionEntries(home, chatId as string).findLast(
		(entry) => entry.message?.role === "assistant",
	);
	expect(reply?.message?.stopReason).toBe("aborted");

	await chat.open();
	await expect(chat.dialog.getByText("Stopped")).toBeVisible();
	await expect(chat.sendButton).toBeVisible();
});

test("a second chat over the concurrency limit waits, then runs", async ({
	freedia,
	home,
	site,
}) => {
	const worker = await freedia.serviceWorker();
	await worker.evaluate(() =>
		chrome.storage.local.set({
			settings: {
				shortcut: {
					code: "KeyE",
					metaKey: true,
					ctrlKey: false,
					altKey: false,
					shiftKey: false,
				},
				maxConcurrent: 1,
				onboarded: true,
			},
		}),
	);
	await freedia.close();
	await freedia.launch();
	const context = freedia.requireContext();
	const first = await ChatPage.open(context, site.url("/article"));
	await first.open();
	const second = await ChatPage.open(context, site.url("/short"));
	await second.open();
	await first.send(SLOW);
	await expect(first.assistant.first()).toContainText("Sentence 2");
	await second.send("Is the ticket office open on holidays?");
	await expect(
		second.dialog.getByRole("status", {
			name: "Waiting for another chat to finish…",
		}),
	).toBeVisible();
	expect(chatProcesses(home)).toHaveLength(1);
	await first.stopButton.click();
	const reply = await second.waitForReplies(1);
	await expect(reply).toContainText(
		"You asked: Is the ticket office open on holidays?",
	);
	await waitForNoOmp(home);
});

test("the helper exits when no tab needs it and a crashed helper reconnects", async ({
	freedia,
	home,
	site,
}) => {
	const context = freedia.requireContext();
	let chat = await ChatPage.open(context, site.url("/article"));
	await chat.open();
	await chat.ask("Who rides the night train now?");
	await expect.poll(() => helperPids()).toHaveLength(1);
	await chat.page.close();
	await expect.poll(() => helperPids()).toHaveLength(0);

	chat = await ChatPage.open(context, site.url("/article"));
	await chat.open();
	await expect.poll(() => helperPids()).toHaveLength(1);
	const [pid] = helperPids();
	execFileSync("kill", ["-KILL", pid as string]);
	await expect
		.poll(() => helperPids().filter((other) => other !== pid))
		.toHaveLength(1);
	const reply = await chat.ask("Still there after the helper restarted?");
	await expect(reply).toContainText(
		"You asked: Still there after the helper restarted?",
	);
	expect(chatIds(home)).toHaveLength(2);
	await waitForNoOmp(home);
});
