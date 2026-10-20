import { ChatPage } from "../fixtures/chat";
import { chatIds, userMessages } from "../fixtures/env";
import { SHORT_TITLE } from "../fixtures/site";
import { expect, test } from "../fixtures/test";

test("ENSURE 12: each tab keeps its own chat", async ({
	freedia,
	home,
	site,
}) => {
	const context = freedia.requireContext();
	const article = await ChatPage.open(context, site.url("/article"));
	await article.open();
	await article.ask("Who rides the night train now?");

	const short = await ChatPage.open(context, site.url("/short"));
	await short.open();
	await expect(short.assistant).toHaveCount(0);
	const reply = await short.ask("When does the ticket office open?");
	await expect(reply).toContainText(`Page: ${site.url("/short")}`);
	await expect(reply).toContainText("Earlier questions: none");

	await article.page.bringToFront();
	await expect(article.assistant).toHaveCount(1);
	await expect(article.assistant.first()).toContainText(
		"You asked: Who rides the night train now?",
	);
	await expect(
		article.dialog.getByText("When does the ticket office open?"),
	).toHaveCount(0);

	const ids = chatIds(home);
	expect(ids).toHaveLength(2);
	const prompts = ids.flatMap((id) => userMessages(home, id));
	expect(
		prompts.filter((p) => p.includes(`Title: ${SHORT_TITLE}`)),
	).toHaveLength(1);

	await short.reload();
	await short.open();
	await expect(short.assistant).toHaveCount(1);
	await expect(short.assistant.first()).toContainText(
		"You asked: When does the ticket office open?",
	);
	const followUp = await short.ask("And on holidays?");
	await expect(followUp).toContainText(
		"Earlier questions: “When does the ticket office open?”",
	);
	expect(chatIds(home)).toHaveLength(2);
});
