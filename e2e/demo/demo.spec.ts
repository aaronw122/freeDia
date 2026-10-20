import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ChatPage, REPLY_TIMEOUT } from "../fixtures/chat";
import { chatIds, chatTitle } from "../fixtures/env";
import { ARTICLE_HIGHLIGHT } from "../fixtures/site";
import { expect, test } from "../fixtures/test";

const outDir =
	process.env.FREEDIA_DEMO_OUT ??
	join(process.cwd(), "test-results/demo-shots");

test("demo: highlight, ⌘E, ask, stream, follow up, history", async ({
	freedia,
	home,
	site,
}) => {
	mkdirSync(outDir, { recursive: true });
	const shot = (name: string, chat: ChatPage) =>
		chat.page.screenshot({ path: join(outDir, `${name}.png`) });

	const chat = await ChatPage.open(
		freedia.requireContext(),
		site.url("/article"),
	);
	await chat.page.setViewportSize({ width: 1280, height: 800 });
	await chat.select(ARTICLE_HIGHLIGHT);
	await chat.open();
	await expect(chat.chips).toHaveCount(1);
	await expect(chat.chips.first()).toContainText("Selected Text");
	await chat.ready();
	await shot("01-highlight-and-shortcut", chat);
	await chat.send("Why are sleeper trains winning on this route?");
	await expect(chat.stopButton).toBeVisible({ timeout: REPLY_TIMEOUT });
	await expect(chat.assistant.first()).not.toBeEmpty({
		timeout: REPLY_TIMEOUT,
	});
	await shot("02-streaming", chat);

	const reply = await chat.waitForReplies(1);
	await expect(reply).toContainText("Selected text: 1");
	await shot("03-reply", chat);

	const followUp = await chat.ask("And what is holding the network back?");
	await expect(followUp).toContainText("Earlier questions: “Why are sleeper");
	await shot("04-follow-up", chat);

	await expect
		.poll(() => chatTitle(home, chatIds(home)[0] as string), {
			timeout: REPLY_TIMEOUT,
		})
		.not.toBeNull();
	await chat.button("History").click();
	const history = chat.dialog.getByRole("region", { name: "Recent chats" });
	await expect(history.getByRole("listitem")).toHaveCount(1);
	await shot("05-history", chat);
});
