import { browser } from "wxt/browser";
import { RealChatClient } from "../client/client";
import type { ChatUi } from "../content/controller";
import { chromeStore } from "../lib/chrome-store";
import {
	CHAT_PORT_NAME,
	type TabToWorker,
	type WorkerToTab,
} from "../lib/messages";
import { extractPage } from "../page/extract";
import { mountChat } from "../ui/index";

declare global {
	var freediaChatUi: ChatUi | undefined;
}

export default defineUnlistedScript(() => {
	globalThis.freediaChatUi = {
		mountChat,
		createClient: () =>
			new RealChatClient({
				connect: () => {
					const port = browser.runtime.connect({ name: CHAT_PORT_NAME });
					return {
						postMessage: (message: TabToWorker) => port.postMessage(message),
						onMessage: (listener) =>
							port.onMessage.addListener((message) =>
								listener(message as WorkerToTab),
							),
						onDisconnect: (listener) =>
							port.onDisconnect.addListener(() => listener()),
					};
				},
				store: chromeStore,
				readPage: () => extractPage(document, location.href),
				now: Date.now,
				randomUUID: () => crypto.randomUUID(),
				setTimer: (callback, ms) => {
					setTimeout(callback, ms);
				},
			}),
	};
});
