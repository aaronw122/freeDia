import { ChatPage } from "../fixtures/chat";
import { ARTICLE_HIGHLIGHT } from "../fixtures/site";
import { expect, test } from "../fixtures/test";

test("ENSURE 13: ⌘E by default, a changed shortcut replaces it, ⇧⌘E is registered and opens the chat", async ({
	freedia,
	site,
}) => {
	const onboarding = freedia.onboarding;
	if (onboarding === null) throw new Error("onboarding did not open");
	await expect(
		onboarding.getByRole("heading", { name: "Welcome to freeDia" }),
	).toBeVisible();
	await expect(onboarding.getByTestId("current-shortcut")).toHaveText("⌘E");

	const chat = await ChatPage.open(
		freedia.requireContext(),
		site.url("/short"),
	);
	await chat.pressShortcut("Meta+e");
	await expect(chat.dialog).toBeVisible();
	await chat.button("Close").click();
	await expect(chat.dialog).toBeHidden();

	await onboarding.bringToFront();
	await onboarding
		.getByRole("button", { name: "Pick another shortcut" })
		.click();
	await expect(onboarding.getByTestId("current-shortcut")).toHaveText(
		"Press a combination…",
	);
	await onboarding.keyboard.press("Control+Shift+KeyK");
	await expect(onboarding.getByTestId("current-shortcut")).toHaveText("⌃⇧K");
	await expect(
		onboarding.getByRole("heading", { name: "freeDia settings" }),
	).toBeVisible();

	await chat.page.bringToFront();
	await chat.pressShortcut("Meta+e");
	await expect(chat.dialog).toBeHidden();
	await chat.pressShortcut("Control+Shift+KeyK");
	await expect(chat.dialog).toBeVisible();
	await chat.button("Close").click();

	const worker = await freedia.serviceWorker();
	const commands = await worker.evaluate(() => chrome.commands.getAll());
	expect(commands).toContainEqual(
		expect.objectContaining({
			name: "open-chat",
			shortcut: process.platform === "darwin" ? "⇧⌘E" : "Ctrl+Shift+E",
		}),
	);

	const other = await ChatPage.open(
		freedia.requireContext(),
		site.url("/article"),
	);
	await other.select(ARTICLE_HIGHLIGHT);
	await other.exposeShadow();
	await other.page.bringToFront();
	await worker.evaluate(async () => {
		const [tab] = await chrome.tabs.query({
			active: true,
			lastFocusedWindow: true,
		});
		if (tab?.id === undefined) throw new Error("no active tab");
		await chrome.tabs.sendMessage(tab.id, { type: "freedia:open-chat" });
	});
	await expect(other.dialog).toBeVisible();
	await expect(other.chips).toHaveCount(1);
	await expect(chat.dialog).toBeHidden();
});
