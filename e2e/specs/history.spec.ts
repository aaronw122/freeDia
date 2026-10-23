import { ChatPage } from "../fixtures/chat";
import { chatIds } from "../fixtures/env";
import { expect, test } from "../fixtures/test";

test("ENSURE 7: history survives a browser relaunch; list, reopen and delete match the session files", async ({
	freedia,
	home,
	site,
}) => {
	let chat = await ChatPage.open(
		freedia.requireContext(),
		site.url("/article"),
	);
	await chat.open();
	await chat.ask("Who rides the night train now?");
	await chat.button("New chat").click();
	await expect(chat.assistant).toHaveCount(0);
	await chat.ask("What does a sleeper car cost to build?");
	expect(chatIds(home)).toHaveLength(2);
	await freedia.close();
	await freedia.launch();
	chat = await ChatPage.open(freedia.requireContext(), site.url("/short"));
	await chat.open();
	await expect(chat.assistant).toHaveCount(0);
	await chat.button("History").click();
	const history = chat.dialog.getByRole("region", { name: "Recent chats" });
	await expect(history.getByRole("listitem")).toHaveCount(2);
	await expect(history.getByRole("listitem").first()).toContainText(
		"What does a sleeper car cost to build?",
	);
	await expect(history.getByRole("listitem").nth(1)).toContainText(
		"Who rides the night train now?",
	);

	await history
		.getByRole("button", { name: /^Who rides the night train now\?/ })
		.click();
	await expect(
		chat.dialog.getByText("Who rides the night train now?", { exact: true }),
	).toBeVisible();
	await expect(chat.assistant).toHaveCount(1);
	await expect(chat.assistant.first()).toContainText(
		"You asked: Who rides the night train now?",
	);
	const followUp = await chat.ask("Does that still hold on this page?");
	await expect(followUp).toContainText(
		"Earlier questions: “Who rides the night train now?”",
	);
	expect(chatIds(home)).toHaveLength(2);

	await chat.button("History").click();
	await history
		.getByRole("button", {
			name: "Delete What does a sleeper car cost to build?",
		})
		.click();
	const confirm = chat.dialog.getByRole("alertdialog", {
		name: "Delete this chat?",
	});
	await expect(confirm).toContainText(
		'"What does a sleeper car cost to build?" will be permanently deleted.',
	);
	await confirm.getByRole("button", { name: "Delete" }).click();
	await expect(history.getByRole("listitem")).toHaveCount(1);
	await expect(history.getByRole("listitem").first()).toContainText(
		"Who rides the night train now?",
	);
	expect(chatIds(home)).toHaveLength(1);
});
