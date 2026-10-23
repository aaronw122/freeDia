import { ChatPage } from "../fixtures/chat";
import { FreediaBrowser } from "../fixtures/env";
import { expect, test } from "../fixtures/test";

test("ENSURE 10: no helper installed shows the Install helper card with the command", async ({
	home,
	site,
}) => {
	const browser = new FreediaBrowser(home, { nativeHost: false });
	try {
		const context = await browser.launch();
		const chat = await ChatPage.open(context, site.url("/article"));
		await chat.open();
		const card = chat.dialog.getByRole("region", { name: "Install helper" });
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(card).toContainText("bunx freedia install");
		await expect(
			card.getByRole("button", { name: "Copy command" }),
		).toBeVisible();
		await expect(chat.input).toHaveCount(0);
	} finally {
		await browser.dispose();
	}
});

test("ENSURE 10: a provider rejection from omp is shown with its fix", async ({
	freedia,
	site,
}) => {
	const chat = await ChatPage.open(
		freedia.requireContext(),
		site.url("/article"),
	);
	await chat.open();
	await chat.send("Explain this page [[reject]]");
	const alert = chat.assistant.first().getByRole("alert");
	await expect(alert).toContainText("faux rejected freeDia's sign-in");
	await expect(alert).toContainText("Run bunx freedia login in Terminal");
	await expect(alert.getByText("bunx freedia login").last()).toBeVisible();
	await expect(chat.sendButton).toBeVisible();

	const reply = await chat.ask("Try once more, please.");
	await expect(reply).toContainText("You asked: Try once more, please.");
});
