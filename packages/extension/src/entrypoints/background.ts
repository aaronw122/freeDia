import { NATIVE_HOST_NAME } from "freedia/protocol";
import { browser } from "wxt/browser";
import { type NativePort, Relay, type TabPort } from "../background/relay";
import { chromeStore } from "../lib/chrome-store";
import {
	CHAT_PORT_NAME,
	OPEN_CHAT_MESSAGE,
	type WorkerToTab,
} from "../lib/messages";
import { SETTINGS_KEY } from "../lib/store";

function connectNative(): NativePort {
	const port = browser.runtime.connectNative(NATIVE_HOST_NAME);
	return {
		postMessage: (message) => port.postMessage(message),
		onMessage: (listener) => port.onMessage.addListener(listener),
		onDisconnect: (listener) =>
			port.onDisconnect.addListener(() => {
				listener(browser.runtime.lastError?.message ?? null);
			}),
		disconnect: () => port.disconnect(),
	};
}

export default defineBackground(() => {
	const relay = new Relay({
		connectNative,
		store: chromeStore,
		randomUUID: () => crypto.randomUUID(),
		setTimer: (callback, ms) => {
			setTimeout(callback, ms);
		},
	});

	browser.runtime.onConnect.addListener((port) => {
		const tabId = port.sender?.tab?.id;
		if (port.name !== CHAT_PORT_NAME || tabId === undefined) {
			return;
		}
		const tabPort: TabPort = {
			tabId,
			postMessage: (message: WorkerToTab) => port.postMessage(message),
			onMessage: (listener) => port.onMessage.addListener(listener),
			onDisconnect: (listener) =>
				port.onDisconnect.addListener(() => listener()),
		};
		relay.attachTab(tabPort);
	});

	browser.tabs.onRemoved.addListener((tabId) => {
		void relay.tabRemoved(tabId);
	});

	browser.commands.onCommand.addListener((command, tab) => {
		if (command !== "open-chat" || tab?.id === undefined) {
			return;
		}
		browser.tabs
			.sendMessage(tab.id, { type: OPEN_CHAT_MESSAGE })
			.catch(() => undefined);
	});

	browser.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && changes[SETTINGS_KEY] !== undefined) {
			void relay.settingsChanged();
		}
	});

	browser.runtime.onStartup.addListener(() => {
		void relay.browserStarted();
	});

	browser.runtime.onInstalled.addListener(({ reason }) => {
		if (reason === "install") {
			void browser.runtime.openOptionsPage();
		}
	});
});
