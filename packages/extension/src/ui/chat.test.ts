import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent, waitFor } from "@testing-library/react";
import type { HelperErrorCode } from "freedia/protocol";
import { act } from "react";
import { memoryWindowStore } from "./layout";
import { promptRun, retextRun, type TimedRecord } from "./mock/fixtures";
import {
	fixtureMessages,
	fixtureReply,
	MockChatClient,
} from "./mock/mockClient";
import { mountChatWithStore } from "./mount";
import { asRecord } from "./records";
import { cleanupChats, type Harness, renderChat } from "./test-utils";
import { initialTranscript, transcriptReducer } from "./transcript";

afterEach(cleanupChats);

function eventType(entry: TimedRecord): unknown {
	return asRecord(entry.record.assistantMessageEvent)?.type;
}

function splitAt(
	run: TimedRecord[],
	predicate: (entry: TimedRecord) => boolean,
) {
	const index = run.findIndex(predicate);
	return [run.slice(0, index), run.slice(index)] as const;
}

async function ask(h: Harness, text: string) {
	const input = h.ui.getByRole("textbox", { name: "Message" });
	await h.act(() => {
		fireEvent.change(input, { target: { value: text } });
		fireEvent.keyDown(input, { key: "Enter" });
	});
}

const streamRun = promptRun("stream");

describe("restore", () => {
	test("opening the chat on a tab that already has one shows its messages", async () => {
		const chatId = crypto.randomUUID();
		const h = await renderChat({
			chatId,
			messages: { [chatId]: fixtureMessages() },
		});
		await waitFor(() =>
			expect(h.ui.getByText("hello from freeDia")).toBeTruthy(),
		);
		expect(h.client.callsTo("openChat")).toEqual([[chatId]]);
		expect(
			h.ui
				.getByRole("textbox", { name: "Message" })
				.getAttribute("placeholder"),
		).toBe("Ask another question");
	});

	test("a restore that lands after the user already sent a message is ignored", () => {
		const chatId = crypto.randomUUID();
		const sent = transcriptReducer(initialTranscript(chatId), {
			type: "send",
			text: "first question",
		});
		expect(
			transcriptReducer(sent, {
				type: "restored",
				chatId,
				messages: fixtureMessages(),
			}),
		).toBe(sent);
	});
});

describe("composer", () => {
	test("the message box gets focus once the helper connects", async () => {
		const h = await renderChat({ connection: "connecting" });
		const input = h.ui.getByRole("textbox", { name: "Message" });
		expect(h.root.activeElement).not.toBe(input);

		await h.act(() => h.client.setConnection("connected"));
		expect(h.root.activeElement).toBe(input);
	});

	test("highlights show as removable Selected Text chips and re-highlighting adds another", async () => {
		const h = await renderChat();
		expect(h.ui.queryByText("Selected Text")).toBeNull();

		await h.act(() => h.client.addQuote("first highlight"));
		expect(h.ui.getAllByText("Selected Text")).toHaveLength(1);

		await h.act(() => h.client.addQuote("second highlight"));
		const chips = h.ui.getAllByText("Selected Text");
		expect(chips).toHaveLength(2);

		const removeButtons = h.ui.getAllByRole("button", {
			name: "Remove Selected Text",
		});
		await h.act(() => fireEvent.click(removeButtons[0] as HTMLElement));
		expect(h.client.quotes().map((quote) => quote.text)).toEqual([
			"second highlight",
		]);
		expect(h.ui.getAllByText("Selected Text")).toHaveLength(1);
	});

	test("placeholder changes after the first message and send is disabled mid-reply", async () => {
		const h = await renderChat();
		const input = h.ui.getByRole("textbox", { name: "Message" });
		expect(input.getAttribute("placeholder")).toBe(
			"Ask a question about this page",
		);
		expect(
			h.ui.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
		).toBe(true);

		await ask(h, "hello from freeDia");
		expect(h.client.callsTo("send")).toEqual([["hello from freeDia"]]);
		expect(input.getAttribute("placeholder")).toBe("Ask another question");

		const [beforeEnd] = splitAt(
			streamRun,
			(entry) => entry.record.type === "agent_settled",
		);
		await h.play(beforeEnd);
		expect(h.ui.queryByRole("button", { name: "Send" })).toBeNull();
		await ask(h, "a second question mid-reply");
		expect(h.client.callsTo("send")).toHaveLength(1);

		await h.play([{ t: 0, record: { type: "agent_settled", aborted: false } }]);
		expect(h.ui.queryByRole("button", { name: "Stop" })).toBeNull();
		expect(
			(h.ui.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
				.value,
		).toBe("a second question mid-reply");
	});

	test("picking a model calls setModel and updates the picker", async () => {
		const h = await renderChat();
		const picker = await h.ui.findByRole("button", { name: "Model: Faux One" });
		await h.act(() => fireEvent.click(picker));
		const option = h.ui.getByRole("menuitemradio", { name: /Faux Two/ });
		await h.act(() => fireEvent.click(option));

		expect(h.client.callsTo("setModel")).toHaveLength(1);
		expect(h.client.callsTo("setModel")[0]?.[0]).toMatchObject({
			provider: "faux",
			modelId: "faux-2",
		});
		expect(h.ui.getByRole("button", { name: "Model: Faux Two" })).toBeTruthy();
		expect(h.ui.queryByRole("menu")).toBeNull();
	});

	test("the model picker sits beside Send, not in the header", async () => {
		const h = await renderChat();
		const picker = await h.ui.findByRole("button", { name: /^Model:/ });
		expect(picker.closest("form")).toBeTruthy();
		expect(picker.closest("header")).toBeNull();
	});
});

describe("streaming", () => {
	test("shows Thinking… from prompt accepted until the first text delta and ignores the system message", async () => {
		const h = await renderChat();
		await ask(h, "hello from freeDia");
		const [beforeDelta, rest] = splitAt(
			streamRun,
			(entry) => eventType(entry) === "text_delta",
		);
		await h.play(beforeDelta);
		expect(h.ui.getByRole("status", { name: "Thinking…" })).toBeTruthy();
		expect(h.ui.queryByText(/expert coding assistant/)).toBeNull();

		await h.play(rest.slice(0, 1));
		expect(h.ui.queryByText("Thinking…")).toBeNull();
		expect(h.ui.getByText("[faux-1] faux re")).toBeTruthy();
	});

	test("accumulates deltas by contentIndex, then replaces them with message_end", async () => {
		const h = await renderChat();
		await ask(h, "hello");
		const [beforeEnd] = splitAt(
			streamRun,
			(entry) => eventType(entry) === "text_end",
		);
		await h.play(beforeEnd);
		expect(
			h.ui.getByRole("article", { name: "Assistant message" }).textContent,
		).toContain("[faux-1] faux reply to: hello from freeDia");

		const end = streamRun.find(
			(entry) =>
				entry.record.type === "message_end" &&
				asRecord(entry.record.message)?.role === "assistant",
		);
		if (!end) throw new Error("fixture lacks assistant message_end");
		const message = asRecord(end.record.message);
		await h.play([
			{
				t: 0,
				record: {
					...end.record,
					message: {
						...message,
						content: [{ type: "text", text: "Final text from message_end" }],
					},
				},
			},
			{ t: 0, record: { type: "agent_settled", aborted: false } },
		]);
		const article = h.ui.getByRole("article", { name: "Assistant message" });
		expect(article.textContent).toContain("Final text from message_end");
		expect(article.textContent).not.toContain("faux reply");
	});

	test("shows only the question part of freeDia's prompt in the user bubble", async () => {
		const h = await renderChat();
		const run = retextRun(
			streamRun,
			"URL: https://example.com/\nTitle: Example\n\n## Question\nWhat is this page about?",
			"It is an example.",
		);
		await h.play(run);
		expect(h.ui.getByText("What is this page about?")).toBeTruthy();
		expect(h.ui.queryByText(/URL: https/)).toBeNull();
	});

	test("shows Starting… and Waiting for another chat to finish… from status events", async () => {
		const h = await renderChat();
		await ask(h, "hello");
		const chatId = h.client.currentChatId();
		await h.act(() =>
			h.client.emit({ type: "status", chatId, state: "queued" }),
		);
		expect(
			h.ui.getByRole("status", { name: "Waiting for another chat to finish…" }),
		).toBeTruthy();
		await h.act(() =>
			h.client.emit({ type: "status", chatId, state: "starting" }),
		);
		expect(h.ui.getByRole("status", { name: "Starting…" })).toBeTruthy();
		await h.act(() =>
			h.client.emit({
				type: "status",
				chatId: crypto.randomUUID(),
				state: "queued",
			}),
		);
		expect(h.ui.getByRole("status", { name: "Starting…" })).toBeTruthy();
		await h.play(streamRun.slice(0, 1));
		expect(h.ui.getByRole("status", { name: "Thinking…" })).toBeTruthy();
	});

	test("events for another chat are not rendered", async () => {
		const h = await renderChat();
		await h.act(() => h.client.play(streamRun, crypto.randomUUID()));
		expect(h.ui.queryByRole("article")).toBeNull();
	});
});

describe("stop and close", () => {
	const abortRun = promptRun("abort");
	const [abortBefore, abortAfter] = splitAt(
		abortRun,
		(entry) =>
			entry.record.type === "message_end" &&
			asRecord(entry.record.message)?.role === "assistant",
	);

	test("Stop sends abort and the partial reply renders as stopped", async () => {
		const h = await renderChat();
		await ask(h, "write something");
		await h.play(abortBefore);
		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "Stop" })),
		);
		expect(h.client.callsTo("abort")).toHaveLength(1);

		await h.play(abortAfter);
		const article = h.ui.getByRole("article", { name: "Assistant message" });
		expect(article.textContent).toContain(
			"[faux-1] Sentence 1 of a deliberately long faux reply. Sentence 2 of",
		);
		expect(h.ui.getByText("Stopped")).toBeTruthy();
		expect(h.ui.getByRole("button", { name: "Send" })).toBeTruthy();
	});

	test("closing mid-reply asks to cancel, then aborts and closes", async () => {
		const h = await renderChat();
		await ask(h, "write something");
		await h.play(abortBefore);

		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "Close" })),
		);
		const dialog = h.ui.getByRole("alertdialog", {
			name: "Cancel this response?",
		});
		expect(h.client.callsTo("abort")).toHaveLength(0);

		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "Keep waiting" })),
		);
		expect(h.ui.queryByRole("alertdialog")).toBeNull();
		expect(h.client.callsTo("abort")).toHaveLength(0);
		expect(dialog.isConnected).toBe(false);

		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "Close" })),
		);
		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "Cancel response" })),
		);
		expect(h.client.callsTo("abort")).toHaveLength(1);
		await waitFor(() =>
			expect(h.ui.queryByRole("dialog", { name: "freeDia chat" })).toBeNull(),
		);
	});

	test("closing while idle closes without a confirm, and freedia:open reopens", async () => {
		const h = await renderChat();
		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "Close" })),
		);
		expect(h.ui.queryByRole("alertdialog")).toBeNull();
		expect(h.ui.queryByRole("dialog", { name: "freeDia chat" })).toBeNull();

		await h.act(() => h.root.dispatchEvent(new CustomEvent("freedia:open")));
		expect(h.ui.getByRole("dialog", { name: "freeDia chat" })).toBeTruthy();
	});
});

describe("copy", () => {
	test("Copy code copies the code block and Copy copies the whole reply", async () => {
		const reply =
			"Here is code:\n\n```ts\nconst answer = 42;\nconsole.log(answer);\n```\n\nDone.";
		const h = await renderChat();
		await h.play(retextRun(streamRun, "show code", reply));

		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "Copy code" })),
		);
		expect(await navigator.clipboard.readText()).toBe(
			"const answer = 42;\nconsole.log(answer);",
		);
		await waitFor(() => expect(h.ui.getByText("Copied")).toBeTruthy());

		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "Copy" })),
		);
		expect(await navigator.clipboard.readText()).toBe(reply);
	});

	test("Copy is not offered while the reply is still streaming", async () => {
		const h = await renderChat();
		await ask(h, "hello");
		const [beforeEnd] = splitAt(
			streamRun,
			(entry) => eventType(entry) === "text_end",
		);
		await h.play(beforeEnd);
		expect(h.ui.queryByRole("button", { name: "Copy" })).toBeNull();
	});
});

describe("chats", () => {
	test("+ starts a new chat: messages and chips reset", async () => {
		const h = await renderChat();
		await h.play(streamRun);
		await h.act(() => h.client.addQuote("highlight"));
		expect(h.ui.getByRole("article")).toBeTruthy();
		const before = h.client.currentChatId();

		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "New chat" })),
		);
		expect(h.client.callsTo("newChat")).toHaveLength(1);
		expect(h.client.currentChatId()).not.toBe(before);
		expect(h.ui.queryByRole("article")).toBeNull();
		expect(h.ui.queryByText("Selected Text")).toBeNull();
		expect(
			h.ui
				.getByRole("textbox", { name: "Message" })
				.getAttribute("placeholder"),
		).toBe("Ask a question about this page");
	});

	test("history lists titles, reopens a chat and deletes after confirm", async () => {
		const older = crypto.randomUUID();
		const newer = crypto.randomUUID();
		const h = await renderChat({
			chats: [
				{
					chatId: newer,
					title: "Faux reply page",
					updatedAt: "2026-10-20T08:00:00.000Z",
				},
				{
					chatId: older,
					title: "Pricing table question",
					updatedAt: "2026-10-18T08:00:00.000Z",
				},
			],
			messages: { [newer]: fixtureMessages() },
		});
		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "History" })),
		);
		const list = await h.ui.findByRole("region", { name: "Recent chats" });
		expect(list.textContent).toContain("Faux reply page");
		expect(list.textContent).toContain("Pricing table question");

		await h.act(() => fireEvent.click(h.ui.getByText("Faux reply page")));
		expect(h.client.callsTo("openChat").at(-1)).toEqual([newer]);
		expect(
			h.client.callsTo("openChat").filter(([id]) => id === newer),
		).toHaveLength(1);
		await waitFor(() =>
			expect(h.ui.getByText("hello from freeDia")).toBeTruthy(),
		);
		expect(
			h.ui.getByRole("article", { name: "Assistant message" }).textContent,
		).toContain("[faux-1] faux reply to: hello from freeDia");
		expect(h.ui.queryByText(/expert coding assistant/)).toBeNull();

		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "History" })),
		);
		await h.ui.findByText("Pricing table question");
		await h.act(() =>
			fireEvent.click(
				h.ui.getByRole("button", { name: "Delete Pricing table question" }),
			),
		);
		expect(
			h.ui.getByRole("alertdialog", { name: "Delete this chat?" }),
		).toBeTruthy();
		expect(h.client.callsTo("deleteChat")).toHaveLength(0);
		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "Delete" })),
		);
		expect(h.client.callsTo("deleteChat")).toEqual([[older]]);
		await waitFor(() =>
			expect(h.ui.queryByText("Pricing table question")).toBeNull(),
		);
		expect(h.ui.getByText("Faux reply page")).toBeTruthy();
	});

	test("a reopened aborted reply renders as stopped", async () => {
		const chatId = crypto.randomUUID();
		const messages = fixtureMessages().map((message) =>
			message.role === "assistant"
				? {
						...message,
						stopReason: "aborted",
						errorMessage: "Request was aborted",
					}
				: message,
		);
		const h = await renderChat({
			chats: [
				{
					chatId,
					title: "Stopped chat",
					updatedAt: "2026-10-20T08:00:00.000Z",
				},
			],
			messages: { [chatId]: messages },
		});
		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "History" })),
		);
		await h.act(async () =>
			fireEvent.click(await h.ui.findByText("Stopped chat")),
		);
		await waitFor(() => expect(h.ui.getByText("Stopped")).toBeTruthy());
	});
});

describe("errors", () => {
	test("not signed in: failed prompt response shows sign-in fix and restores the draft", async () => {
		const h = await renderChat({
			reply: () => fixtureReply("not-signed-in-anthropic"),
			statusDelayMs: 0,
		});
		await ask(h, "hello");
		const alert = await h.ui.findByRole("alert");
		await waitFor(() =>
			expect(
				(h.ui.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
					.value,
			).toBe("hello"),
		);
		expect(alert.textContent).toContain("Not signed in to anthropic");
		expect(alert.textContent).toContain("bunx freedia login");
		expect(h.ui.queryByText("hello", { selector: "div" })).toBeNull();
		expect(
			(h.ui.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
				.value,
		).toBe("hello");
		expect(h.ui.getByRole("button", { name: "Send" })).toBeTruthy();
	});

	test("provider rejected (401) renders a sign-in error card", async () => {
		const h = await renderChat();
		await ask(h, "hello");
		await h.play(promptRun("provider-rejected-401"));
		const alert = h.ui.getByRole("alert");
		expect(alert.textContent).toContain("anthropic rejected freeDia's sign-in");
		expect(alert.textContent).toContain("bunx freedia login");
		expect(h.ui.getByRole("button", { name: "Send" })).toBeTruthy();
	});

	test("rate limit shows retrying during auto-retry, then a rate-limit card", async () => {
		const h = await renderChat();
		await ask(h, "trigger");
		const run = promptRun("rate-limit");
		const [beforeRetry, afterRetry] = splitAt(
			run,
			(entry) => entry.record.type === "auto_retry_start",
		);
		await h.play([...beforeRetry, ...afterRetry.slice(0, 1)]);
		expect(
			h.ui.getByRole("status", { name: /Retrying… \(attempt 1 of 3\)/ }),
		).toBeTruthy();
		expect(h.ui.queryByRole("alert")).toBeNull();

		await h.play(afterRetry.slice(1));
		expect(h.ui.queryByRole("status")).toBeNull();
		const alerts = h.ui.getAllByRole("alert");
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.textContent).toContain("faux is rate limiting requests");
	});

	test("stop during a retry wait renders the reply as stopped", async () => {
		const h = await renderChat();
		await ask(h, "trigger");
		const run = promptRun("rate-limit");
		const [beforeRetry, afterRetry] = splitAt(
			run,
			(entry) => entry.record.type === "auto_retry_start",
		);
		await h.play([...beforeRetry, ...afterRetry.slice(0, 1)]);
		await h.play([
			{
				t: 0,
				record: {
					type: "auto_retry_end",
					success: false,
					attempt: 1,
					finalError: "Retry cancelled",
				},
			},
			{ t: 0, record: { type: "agent_settled", aborted: true } },
		]);
		expect(h.ui.getByText("Stopped")).toBeTruthy();
		expect(h.ui.queryByRole("alert")).toBeNull();
	});

	const helperFixes: Record<HelperErrorCode, [string, string]> = {
		omp_missing: [
			"freeDia's helper can't find omp",
			"Run `bunx freedia install` in Terminal to reinstall the helper and omp.",
		],
		not_signed_in: [
			"Not signed in",
			"Run `bunx freedia login` in Terminal and sign in to anthropic.",
		],
		spawn_failed: [
			"freeDia couldn't start this chat",
			"Run `bunx freedia doctor` in Terminal to check the install.",
		],
	};

	for (const [code, [title, fix]] of Object.entries(helperFixes)) {
		test(`helper.error ${code} shows its title and fix text`, async () => {
			const h = await renderChat();
			await ask(h, "hello");
			await h.act(() =>
				h.client.emit({
					type: "helper_error",
					error: {
						type: "helper.error",
						chatId: h.client.currentChatId(),
						code: code as HelperErrorCode,
						message: `${code} happened`,
						fix,
					},
				}),
			);
			const alert = h.ui.getByRole("alert");
			expect(alert.textContent).toContain(title);
			expect(alert.textContent).toContain(fix.replaceAll("`", ""));
			expect(h.ui.queryByRole("status")).toBeNull();
			expect(h.ui.getByRole("button", { name: "Send" })).toBeTruthy();
		});
	}

	test("missing helper shows the Install helper card with a copyable command", async () => {
		const h = await renderChat({ connection: "helper_missing" });
		const card = h.ui.getByRole("region", { name: "Install helper" });
		expect(card.textContent).toContain("bunx freedia install");
		expect(h.ui.queryByRole("textbox", { name: "Message" })).toBeNull();
		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "Copy command" })),
		);
		expect(await navigator.clipboard.readText()).toBe("bunx freedia install");

		await h.act(() => h.client.setConnection("connected"));
		expect(h.ui.queryByRole("region", { name: "Install helper" })).toBeNull();
	});

	test("an unreadable page says freeDia can't read it", async () => {
		const h = await renderChat({ readability: "unreadable" });
		expect(h.ui.getByText(/freeDia can't read this page yet/)).toBeTruthy();
		await h.act(() => h.client.setReadability("readable"));
		expect(h.ui.queryByText(/freeDia can't read this page yet/)).toBeNull();
	});
});

describe("window", () => {
	const saved = {
		rect: { x: 100, y: 80, width: 420, height: 500 },
		expanded: false,
	};

	function windowStyle(h: Harness) {
		const element = h.ui.getByRole("dialog", { name: "freeDia chat" });
		return element.style;
	}

	test("opens at the saved position and size", async () => {
		const h = await renderChat({ layout: saved });
		await waitFor(() => expect(windowStyle(h).left).toBe("100px"));
		expect(windowStyle(h).top).toBe("80px");
		expect(windowStyle(h).width).toBe("420px");
		expect(windowStyle(h).height).toBe("500px");
	});

	test("dragging the header moves the window and saves the position", async () => {
		const h = await renderChat({ layout: saved });
		await waitFor(() => expect(windowStyle(h).left).toBe("100px"));
		const header = h.root.querySelector("header");
		if (!header) throw new Error("no header");
		await h.act(() => {
			fireEvent.pointerDown(header, { button: 0, clientX: 200, clientY: 100 });
			fireEvent.pointerMove(header, { clientX: 150, clientY: 160 });
			fireEvent.pointerUp(header, { clientX: 150, clientY: 160 });
		});
		expect(windowStyle(h).left).toBe("50px");
		expect(windowStyle(h).top).toBe("140px");
		expect(h.store.saved()).toEqual({
			rect: { x: 50, y: 140, width: 420, height: 500 },
			expanded: false,
		});
	});

	test("resizing from a corner saves the size, never below the minimum", async () => {
		const h = await renderChat({ layout: saved });
		await waitFor(() => expect(windowStyle(h).left).toBe("100px"));
		const handle = h.root.querySelector("[data-resize=se]");
		if (!handle) throw new Error("no handle");
		await h.act(() => {
			fireEvent.pointerDown(handle, { button: 0, clientX: 520, clientY: 580 });
			fireEvent.pointerMove(handle, { clientX: 100, clientY: 100 });
			fireEvent.pointerUp(handle);
		});
		expect(h.store.saved()?.rect).toEqual({
			x: 100,
			y: 80,
			width: 320,
			height: 360,
		});
	});

	test("expand toggles a larger window and persists the choice", async () => {
		const h = await renderChat({ layout: saved });
		await waitFor(() => expect(windowStyle(h).left).toBe("100px"));
		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "Expand" })),
		);
		expect(h.store.saved()?.expanded).toBe(true);
		expect(Number.parseInt(windowStyle(h).height, 10)).toBe(
			window.innerHeight - 32,
		);
		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "Collapse" })),
		);
		expect(h.store.saved()).toEqual(saved);
		expect(windowStyle(h).width).toBe("420px");
	});

	test("styles are injected into the shadow root, not the page", async () => {
		const before = document.head.querySelectorAll("style").length;
		const h = await renderChat();
		expect(h.root.querySelector("style")?.textContent).toContain("tailwindcss");
		expect(document.head.querySelectorAll("style").length).toBe(before);
	});
});

function rendered(h: Harness): string[] {
	const list = h.ui
		.getByRole("dialog", { name: "freeDia chat" })
		.querySelector(".overflow-y-auto");
	if (!list) return [];
	return [...list.children].flatMap((child) => {
		if (child.getAttribute("role") === "status") return [];
		const text = child.textContent?.replace(/Copy$/, "").trim() ?? "";
		return text ? [text] : [];
	});
}

function update(event: Record<string, unknown>): TimedRecord {
	return {
		t: 0,
		record: { type: "message_update", assistantMessageEvent: event },
	};
}

function message(
	type: string,
	role: string,
	extra: Record<string, unknown> = {},
) {
	return { t: 0, record: { type, message: { role, content: [], ...extra } } };
}

describe("run lifecycle", () => {
	test("stopping before pi echoes the prompt keeps the chat in order", async () => {
		const h = await renderChat({
			statusDelayMs: 1,
			reply: (question) => ({
				status: ["starting"],
				run: retextRun(streamRun, question, `reply to ${question}`, {
					stepMs: 0,
				}),
			}),
		});
		await ask(h, "first");
		expect(h.ui.getByRole("status", { name: "Starting…" })).toBeTruthy();
		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "Stop" })),
		);
		await waitFor(() =>
			expect(h.ui.getByRole("button", { name: "Send" })).toBeTruthy(),
		);
		expect(rendered(h)).toEqual(["first", "Stopped"]);

		await ask(h, "second");
		await waitFor(() =>
			expect(h.ui.getAllByRole("button", { name: "Copy" })).toHaveLength(1),
		);
		expect(rendered(h)).toEqual([
			"first",
			"Stopped",
			"second",
			"reply to second",
		]);
	});

	test("a successful abort response ends a queued run without agent_settled", async () => {
		const h = await renderChat();
		await ask(h, "hello");
		const chatId = h.client.currentChatId();
		await h.act(() =>
			h.client.emit({ type: "status", chatId, state: "queued" }),
		);
		expect(h.ui.getByRole("button", { name: "Stop" })).toBeTruthy();

		await h.play([
			{
				t: 0,
				record: { id: "a1", type: "response", command: "abort", success: true },
			},
		]);
		expect(h.ui.queryByRole("status")).toBeNull();
		expect(h.ui.queryByRole("button", { name: "Stop" })).toBeNull();
		expect(h.ui.getByRole("button", { name: "Send" })).toBeTruthy();
		expect(rendered(h)).toEqual(["hello", "Stopped"]);
	});

	test("after a mid-reply stop, a second prompt streams as a new reply", async () => {
		const h = await renderChat();
		await ask(h, "write something");
		const abortRun = promptRun("abort");
		await h.play(abortRun);
		await ask(h, "and now?");
		await h.play(retextRun(streamRun, "and now?", "Second answer."));
		const replies = h.ui.getAllByRole("article", { name: "Assistant message" });
		expect(replies).toHaveLength(2);
		expect(replies[0]?.textContent).toContain("Stopped");
		expect(replies[1]?.textContent).toContain("Second answer.");
		expect(replies[1]?.textContent).not.toContain("Stopped");
	});

	test("+ mid-reply resets the chat and ignores the old chat's late events", async () => {
		const h = await renderChat();
		await ask(h, "hello");
		const oldChat = h.client.currentChatId();
		const [beforeEnd, rest] = splitAt(
			streamRun,
			(entry) => eventType(entry) === "text_end",
		);
		await h.play(beforeEnd);
		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "New chat" })),
		);
		expect(h.ui.queryByRole("article")).toBeNull();
		expect(h.ui.getByRole("button", { name: "Send" })).toBeTruthy();

		await h.act(() => h.client.play(rest, oldChat));
		expect(h.ui.queryByRole("article")).toBeNull();
		expect(h.ui.queryByRole("status")).toBeNull();
	});
});

describe("reply content", () => {
	test("text blocks build by contentIndex; thinking and tool-call blocks are not shown", async () => {
		const h = await renderChat();
		await ask(h, "hello");
		await h.play([
			{
				t: 0,
				record: {
					id: "r1",
					type: "response",
					command: "prompt",
					success: true,
				},
			},
			message("message_start", "assistant", { provider: "faux" }),
			update({ type: "text_start", contentIndex: 0 }),
			update({ type: "text_delta", contentIndex: 0, delta: "Alpha " }),
			update({ type: "thinking_start", contentIndex: 1 }),
			update({ type: "thinking_delta", contentIndex: 1, delta: "secret plan" }),
			update({ type: "toolcall_start", contentIndex: 2, toolName: "read" }),
			update({ type: "toolcall_delta", contentIndex: 2, delta: '{"path":' }),
			update({ type: "text_delta", contentIndex: 3, delta: "Omega" }),
			update({ type: "text_delta", contentIndex: 0, delta: "beta" }),
		]);
		const article = h.ui.getByRole("article", { name: "Assistant message" });
		expect(article.textContent).toBe("Alpha betaOmega");
	});

	test("a tool loop renders as one reply with a tool status and one Copy", async () => {
		const h = await renderChat();
		await ask(h, "list files");
		const run = promptRun("tools-readonly", 1);
		const [beforeTool, fromTool] = splitAt(
			run,
			(entry) => entry.record.type === "tool_execution_end",
		);
		await h.play(beforeTool);
		expect(h.ui.getByRole("status", { name: "Listing files…" })).toBeTruthy();
		expect(h.ui.queryByRole("article")).toBeNull();

		await h.play(fromTool);
		const replies = h.ui.getAllByRole("article", { name: "Assistant message" });
		expect(replies).toHaveLength(1);
		expect(h.ui.getAllByRole("button", { name: "Copy" })).toHaveLength(1);
		expect(replies[0]?.textContent).toContain("pi/");
	});

	test("Copy on a tool loop copies the text of every step", async () => {
		const h = await renderChat();
		await ask(h, "please write a file");
		const run = promptRun("tools-readonly", 0);
		const [beforeTool] = splitAt(
			run,
			(entry) => entry.record.type === "tool_execution_end",
		);
		await h.play(beforeTool);
		expect(h.ui.getByRole("status", { name: "Using write…" })).toBeTruthy();
		await h.play(run.slice(beforeTool.length));
		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "Copy" })),
		);
		expect(await navigator.clipboard.readText()).toBe(
			"Writing the file now.\n\n[faux-1] tool write isError=true: Tool write not found",
		);
	});

	test("a reopened tool loop is one reply", async () => {
		const chatId = crypto.randomUUID();
		const run = promptRun("tools-readonly", 1);
		const settled = run.findLast((entry) => entry.record.type === "agent_end");
		const messages = settled?.record.messages;
		if (!Array.isArray(messages)) throw new Error("fixture lacks agent_end");
		const h = await renderChat({
			chats: [
				{ chatId, title: "Tools", updatedAt: "2026-10-20T08:00:00.000Z" },
			],
			messages: { [chatId]: messages },
		});
		await h.act(() =>
			fireEvent.click(h.ui.getByRole("button", { name: "History" })),
		);
		await h.act(async () => fireEvent.click(await h.ui.findByText("Tools")));
		await waitFor(() =>
			expect(h.ui.getByText("list files [[read]]")).toBeTruthy(),
		);
		expect(
			h.ui.getAllByRole("article", { name: "Assistant message" }),
		).toHaveLength(1);
	});

	test("raw HTML in a reply is not rendered as markup and links carry no stray props", async () => {
		const h = await renderChat();
		await h.play(
			retextRun(
				streamRun,
				"html",
				'<img src="x" onerror="alert(1)"><b>bold?</b> <script>alert(2)</script> [site](https://example.com/)',
			),
		);
		const article = h.ui.getByRole("article", { name: "Assistant message" });
		expect(article.querySelector("img, b, script")).toBeNull();
		const link = article.querySelector("a");
		expect(link?.getAttribute("href")).toBe("https://example.com/");
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.hasAttribute("node")).toBe(false);
	});
});

describe("mount", () => {
	test("state that changed before the UI subscribed is picked up", async () => {
		class LateClient extends MockChatClient {
			private reads = 0;
			override connection() {
				this.reads += 1;
				return this.reads === 1 ? "connecting" : "helper_missing";
			}
		}
		const host = document.createElement("div");
		document.body.append(host);
		const root = host.attachShadow({ mode: "open" });
		const client = new LateClient();
		let unmount = () => {};
		await act(async () => {
			unmount = mountChatWithStore(root, client, memoryWindowStore());
		});
		expect(root.querySelector("[aria-label='Install helper']")).toBeTruthy();
		act(() => unmount());
		host.remove();
	});
});
