import { browser } from "wxt/browser";
import { type ChatUi, ContentController } from "../../content/controller";
import { chromeStore } from "../../lib/chrome-store";
import { OPEN_CHAT_MESSAGE } from "../../lib/messages";
import { loadSettings, parseSettings, SETTINGS_KEY } from "../../lib/store";

async function loadUi(): Promise<ChatUi> {
	await import(/* @vite-ignore */ browser.runtime.getURL("/chat-ui.js"));
	const ui = globalThis.freediaChatUi;
	if (ui === undefined) {
		throw new Error("freeDia chat UI failed to load");
	}
	return ui;
}

export default defineContentScript({
	matches: ["http://*/*", "https://*/*"],
	runAt: "document_start",
	main(ctx) {
		const controller = new ContentController({ window, loadUi });
		ctx.onInvalidated(() => {
			controller.destroy();
		});
		void loadSettings(chromeStore).then((settings) => {
			controller.setShortcut(settings.shortcut);
		});
		browser.storage.onChanged.addListener((changes, area) => {
			const change = changes[SETTINGS_KEY];
			if (area === "local" && change !== undefined) {
				controller.setShortcut(parseSettings(change.newValue).shortcut);
			}
		});
		browser.runtime.onMessage.addListener((message: { type?: unknown }) => {
			if (message?.type === OPEN_CHAT_MESSAGE) {
				void controller.open();
			}
		});
	},
});
