import { ChatPage } from "../fixtures/chat";
import {
	chatIds,
	chatTitle,
	sessionEntries,
	userMessages,
} from "../fixtures/env";
import {
	ARTICLE_ENDING,
	ARTICLE_HIGHLIGHT,
	ARTICLE_SECOND_HIGHLIGHT,
	ARTICLE_TITLE,
	NEXT_TITLE,
} from "../fixtures/site";
import { expect, test } from "../fixtures/test";

test("ENSURE 1: highlight + ⌘E opens the chat with a Selected Text chip", async ({
	freedia,
	site,
}) => {
	const chat = await ChatPage.open(
		freedia.requireContext(),
		site.url("/article"),
	);
	await chat.select(ARTICLE_HIGHLIGHT);
	await chat.open();
	await expect(chat.chips).toHaveCount(1);
	await expect(chat.chips.first()).toHaveText("Selected Text");
	await expect(chat.chips.first()).toHaveAttribute("title", ARTICLE_HIGHLIGHT);
	await expect(chat.input).toHaveAttribute(
		"placeholder",
		"Ask a question about this page",
	);
	await expect(chat.input).toBeFocused();
});

test("ENSURE 2: reply streams in and omp received URL, highlight and excerpt", async ({
	freedia,
	home,
	site,
}) => {
	const chat = await ChatPage.open(
		freedia.requireContext(),
		site.url("/article"),
	);
	await chat.select(ARTICLE_HIGHLIGHT);
	await chat.open();
	await chat.send("What changed on this route?");
	const reply = chat.assistant.first();
	const lengths: number[] = [];
	await expect
		.poll(
			async () => {
				lengths.push(((await reply.textContent()) ?? "").length);
				return reply.getByRole("button", { name: "Copy" }).count();
			},
			{ intervals: [25], timeout: 30_000 },
		)
		.toBe(1);
	expect(new Set(lengths.filter((length) => length > 0)).size).toBeGreaterThan(
		2,
	);
	await expect(reply).toContainText("You asked: What changed on this route?");
	await expect(reply).toContainText(`Page: ${site.url("/article")}`);
	await expect(reply).toContainText(
		`Selected text: 1 (“${ARTICLE_HIGHLIGHT.slice(0, 40)}`,
	);
	await expect(reply).toContainText(
		/Page excerpt: \d+ characters, middle omitted/,
	);
	await expect(reply).toContainText("Page file: available");
	await expect(chat.chips).toHaveCount(0);
	await expect(chat.input).toHaveAttribute(
		"placeholder",
		"Ask another question",
	);

	const [chatId] = chatIds(home);
	const [prompt] = userMessages(home, chatId as string);
	expect(prompt).toContain(`URL: ${site.url("/article")}`);
	expect(prompt).toContain(`Title: ${ARTICLE_TITLE}`);
	expect(prompt).toContain(`## Selected text\n\n> ${ARTICLE_HIGHLIGHT}`);
	expect(prompt).toContain("## Page excerpt\n\n");
	expect(prompt).toContain("characters omitted");
	expect(prompt).toContain(ARTICLE_ENDING);
	expect(prompt).toMatch(/## Question\n\nWhat changed on this route\?$/);
});

test("ENSURE 3: a follow-up keeps the earlier exchange and the page", async ({
	freedia,
	home,
	site,
}) => {
	const chat = await ChatPage.open(
		freedia.requireContext(),
		site.url("/article"),
	);
	await chat.select(ARTICLE_HIGHLIGHT);
	await chat.open();
	await chat.ask("Who rides the night train now?");
	const followUp = await chat.ask("And what holds the network back?");
	await expect(followUp).toContainText(
		"Earlier questions: “Who rides the night train now?”",
	);
	await expect(followUp).toContainText("Earlier replies: 1");
	await expect(followUp).toContainText("Selected text: 0");
	await expect(followUp).toContainText("Page excerpt: none");
	await expect(followUp).toContainText("Page file: available");
	expect(chatIds(home)).toHaveLength(1);
	const prompts = userMessages(home, chatIds(home)[0] as string);
	expect(prompts).toHaveLength(2);
	expect(prompts[1]).toBe(
		`URL: ${site.url("/article")}\nTitle: ${ARTICLE_TITLE}\n\n## Question\n\nAnd what holds the network back?`,
	);
});

test("navigating the tab keeps the chat and sends the new page", async ({
	freedia,
	home,
	site,
}) => {
	const chat = await ChatPage.open(
		freedia.requireContext(),
		site.url("/article"),
	);
	await chat.open();
	await chat.ask("Summarise this article.");
	await chat.goto(site.url("/next"));
	await chat.open();
	await expect(chat.assistant).toHaveCount(1);
	const reply = await chat.ask("When does the Hamburg train leave?");
	await expect(reply).toContainText(`Page: ${site.url("/next")}`);
	await expect(reply).toContainText(/Page excerpt: \d+ characters/);
	await expect(reply).toContainText(
		"Earlier questions: “Summarise this article.”",
	);
	expect(chatIds(home)).toHaveLength(1);
	const prompts = userMessages(home, chatIds(home)[0] as string);
	expect(prompts[1]).toContain(`Title: ${NEXT_TITLE}`);
	expect(prompts[1]).toContain("departs at 20:12");
});

test("ENSURE 4: switching models mid-chat sends the next message to the new model with history", async ({
	freedia,
	home,
	site,
}) => {
	const chat = await ChatPage.open(
		freedia.requireContext(),
		site.url("/article"),
	);
	await chat.open();
	const first = await chat.ask("Which cities does the sleeper connect?");
	await expect(first).toContainText("[faux-1]");
	await chat.button("Model: Faux One").click();
	await chat.dialog.getByRole("menuitemradio", { name: /Faux Two/ }).click();
	await expect(chat.button("Model: Faux Two")).toBeVisible();
	const second = await chat.ask("Answer again, briefly.");
	await expect(second).toContainText("[faux-2]");
	await expect(second).toContainText(
		"Earlier questions: “Which cities does the sleeper connect?”",
	);
	await expect(second).toContainText("Earlier replies: 1");
	const chatId = chatIds(home)[0] as string;
	const models = sessionEntries(home, chatId)
		.filter((entry) => entry.message?.role === "assistant")
		.map((entry) => `${entry.message?.provider}/${entry.message?.model}`);
	expect(models).toEqual(["faux/faux-1", "faux/faux-2"]);
	await chat.reload();
	await chat.open();
	await expect(chat.button("Model: Faux Two")).toBeVisible();
});

test("ENSURE 5: + starts a new chat and the previous one stays in history", async ({
	freedia,
	home,
	site,
}) => {
	const chat = await ChatPage.open(
		freedia.requireContext(),
		site.url("/article"),
	);
	await chat.open();
	await chat.ask("What is the bottleneck for new routes?");
	const firstChat = chatIds(home);
	expect(firstChat).toHaveLength(1);
	await chat.button("New chat").click();
	await expect(chat.assistant).toHaveCount(0);
	await expect(chat.input).toHaveAttribute(
		"placeholder",
		"Ask a question about this page",
	);
	const reply = await chat.ask("Who rides the night train now?");
	await expect(reply).toContainText("Earlier questions: none");
	await expect(reply).toContainText(/Page excerpt: \d+ characters/);
	expect(chatIds(home)).toHaveLength(2);
	await expect
		.poll(() => chatTitle(home, firstChat[0] as string))
		.toBe("What Is The Bottleneck For New");
	await chat.button("History").click();
	const history = chat.dialog.getByRole("region", { name: "Recent chats" });
	await expect(history.getByRole("listitem")).toHaveCount(2);
	await expect(
		history.getByRole("button", { name: /^What Is The Bottleneck For New/ }),
	).toBeVisible();
});

test("ENSURE 6: re-highlighting with the chat open adds a second quote", async ({
	freedia,
	home,
	site,
}) => {
	const chat = await ChatPage.open(
		freedia.requireContext(),
		site.url("/article"),
	);
	await chat.select(ARTICLE_HIGHLIGHT);
	await chat.open();
	await chat.select(ARTICLE_SECOND_HIGHLIGHT);
	await chat.pressShortcut();
	await expect(chat.chips).toHaveCount(2);
	await expect(chat.chips.nth(1)).toHaveAttribute(
		"title",
		ARTICLE_SECOND_HIGHLIGHT,
	);
	const reply = await chat.ask("How do these two points relate?");
	await expect(reply).toContainText("Selected text: 2");

	await chat.select(ARTICLE_ENDING);
	await chat.pressShortcut();
	await expect(chat.chips).toHaveCount(1);
	const followUp = await chat.ask("And the conclusion?");
	await expect(followUp).toContainText("Selected text: 1");
	const prompts = userMessages(home, chatIds(home)[0] as string);
	expect(prompts[0]).toContain(
		`> ${ARTICLE_HIGHLIGHT}\n\n> ${ARTICLE_SECOND_HIGHLIGHT}`,
	);
	expect(prompts[1]).toContain(`## Selected text\n\n> ${ARTICLE_ENDING}`);
	expect(prompts[1]).toContain("## Page excerpt around the selected text");
	expect(prompts[1]).not.toContain("## Page excerpt\n\n");
});
