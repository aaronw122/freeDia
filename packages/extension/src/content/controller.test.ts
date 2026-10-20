import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ChatClient, Quote } from "../client/types";
import { DEFAULT_SHORTCUT, formatShortcut } from "../lib/shortcut";
import {
	type ChatUi,
	ContentController,
	HOST_TAG,
	OPEN_EVENT,
} from "./controller";

const controllers: ContentController[] = [];

afterEach(() => {
	for (const controller of controllers.splice(0)) {
		controller.destroy();
	}
	window.getSelection()?.removeAllRanges();
	document.body.innerHTML = "";
});

function setup() {
	const quotes: string[] = [];
	const client = {
		addQuote: (text: string): Quote => {
			quotes.push(text);
			return { id: String(quotes.length), text };
		},
	} as unknown as ChatClient;
	const mounted = Promise.withResolvers<ShadowRoot>();
	const mountChat = mock((root: ShadowRoot, _client: ChatClient) => {
		mounted.resolve(root);
		return () => {};
	});
	const ui: ChatUi = { mountChat, createClient: () => client };
	const loadUi = mock(async () => ui);
	const controller = new ContentController({ window, loadUi });
	controllers.push(controller);
	const pageListener = mock((_event: KeyboardEvent) => {});
	window.addEventListener("keydown", pageListener);
	controllers.push({
		destroy: () => window.removeEventListener("keydown", pageListener),
	} as unknown as ContentController);
	return {
		controller,
		mountChat,
		loadUi,
		quotes,
		pageListener,
		client,
		mounted: mounted.promise,
	};
}

function press(init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		...init,
	});
	document.body.dispatchEvent(event);
	return event;
}

async function settle(controller: ContentController) {
	await controller.open().catch(() => undefined);
}

function select(text: string) {
	const p = document.createElement("p");
	p.textContent = text;
	document.body.append(p);
	const range = document.createRange();
	range.selectNodeContents(p);
	window.getSelection()?.removeAllRanges();
	window.getSelection()?.addRange(range);
}

describe("shortcut", () => {
	test("the default is ⌘E", () => {
		expect(DEFAULT_SHORTCUT).toEqual({
			code: "KeyE",
			metaKey: true,
			ctrlKey: false,
			altKey: false,
			shiftKey: false,
		});
		expect(formatShortcut(DEFAULT_SHORTCUT)).toBe("⌘E");
	});

	test("⌘E opens the chat into a shadow root, and the page never sees the key", async () => {
		const { mountChat, loadUi, pageListener, mounted } = setup();
		const event = press({ key: "e", code: "KeyE", metaKey: true });
		expect(event.defaultPrevented).toBe(true);
		expect(pageListener).not.toHaveBeenCalled();
		const root = await mounted;
		expect(loadUi).toHaveBeenCalledTimes(1);
		expect(mountChat).toHaveBeenCalledTimes(1);
		const host = document.documentElement.querySelector(HOST_TAG);
		expect(host?.shadowRoot).not.toBeNull();
		expect(root).toBe(host?.shadowRoot as ShadowRoot);
	});

	test("matches on event.code, so layouts and Shift case don't matter", () => {
		const { pageListener } = setup();
		expect(
			press({ key: "é", code: "KeyE", metaKey: true }).defaultPrevented,
		).toBe(true);
		expect(
			press({ key: "E", code: "KeyE", metaKey: true, shiftKey: true })
				.defaultPrevented,
		).toBe(false);
		expect(press({ key: "e", code: "KeyE" }).defaultPrevented).toBe(false);
		expect(pageListener).toHaveBeenCalledTimes(2);
	});

	test("a changed shortcut opens the chat and ⌘E no longer does", async () => {
		const { controller, loadUi, mounted } = setup();
		controller.setShortcut({
			code: "KeyK",
			metaKey: false,
			ctrlKey: true,
			altKey: false,
			shiftKey: true,
		});
		expect(
			press({ key: "e", code: "KeyE", metaKey: true }).defaultPrevented,
		).toBe(false);
		expect(loadUi).not.toHaveBeenCalled();
		expect(
			press({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true })
				.defaultPrevented,
		).toBe(true);
		await mounted;
		expect(loadUi).toHaveBeenCalledTimes(1);
	});
});

describe("opening", () => {
	test("the selection becomes a quote and the UI mounts once; later opens add quotes and re-show", async () => {
		const { controller, mountChat, loadUi, quotes } = setup();
		select("first highlight");
		await settle(controller);
		expect(quotes).toEqual(["first highlight"]);

		const root = document.documentElement.querySelector(HOST_TAG)?.shadowRoot;
		const reopened = mock(() => {});
		root?.addEventListener(OPEN_EVENT, reopened);

		select("second highlight");
		await settle(controller);
		await settle(controller);
		expect(quotes).toEqual([
			"first highlight",
			"second highlight",
			"second highlight",
		]);
		expect(loadUi).toHaveBeenCalledTimes(1);
		expect(mountChat).toHaveBeenCalledTimes(1);
		expect(reopened).toHaveBeenCalledTimes(2);
	});

	test("rapid presses before the UI has loaded still mount only once", async () => {
		const { controller, mountChat } = setup();
		await Promise.all([
			settle(controller),
			settle(controller),
			settle(controller),
		]);
		expect(mountChat).toHaveBeenCalledTimes(1);
		expect(document.documentElement.querySelectorAll(HOST_TAG)).toHaveLength(1);
	});
});
