import { ChatPage } from "../fixtures/chat";
import { chatIds, chatTitle, sessionFiles } from "../fixtures/env";
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
	await chat.ask("What does a sleeper car cost to build?");
	const [first, second] = chatIds(home).sort(
		(a, b) =>
			Number(
				sessionFiles(home)
					.find((name) => name.endsWith(`_${a}.jsonl`))
					?.localeCompare(
						sessionFiles(home).find((name) => name.endsWith(`_${b}.jsonl`)) ??
							"",
					),
			) || 0,
	);
	expect(chatIds(home)).toHaveLength(2);
	await expect
		.poll(() =>
			[
				chatTitle(home, first as string),
				chatTitle(home, second as string),
			].sort(),
		)
		.toEqual(["What Does A Sleeper Car Cost", "Who Rides The Night Train Now"]);

	await freedia.close();
	await freedia.launch();
	chat = await ChatPage.open(freedia.requireContext(), site.url("/short"));
	await chat.open();
	await expect(chat.assistant).toHaveCount(0);
	await chat.button("History").click();
	const history = chat.dialog.getByRole("region", { name: "Recent chats" });
	await expect(history.getByRole("listitem")).toHaveCount(2);
	await expect(history.getByRole("listitem").first()).toContainText(
		"What Does A Sleeper Car Cost",
	);
	await expect(history.getByRole("listitem").nth(1)).toContainText(
		"Who Rides The Night Train Now",
	);

	await history
		.getByRole("button", { name: /^Who Rides The Night Train Now/ })
		.click();
	await expect(
		chat.dialog.getByText("Who rides the night train now?"),
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
		.getByRole("button", { name: "Delete What Does A Sleeper Car Cost" })
		.click();
	const confirm = chat.dialog.getByRole("alertdialog", {
		name: "Delete this chat?",
	});
	await expect(confirm).toContainText(
		'"What Does A Sleeper Car Cost" will be permanently deleted.',
	);
	await confirm.getByRole("button", { name: "Delete" }).click();
	await expect(history.getByRole("listitem")).toHaveCount(1);
	await expect(history.getByRole("listitem").first()).toContainText(
		"Who Rides The Night Train Now",
	);
	expect(chatIds(home)).toHaveLength(1);
	expect(chatTitle(home, chatIds(home)[0] as string)).toBe(
		"Who Rides The Night Train Now",
	);
});
