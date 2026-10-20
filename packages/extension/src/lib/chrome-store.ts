import { browser } from "wxt/browser";
import type { KeyValueStore } from "./store";

export const chromeStore: KeyValueStore = {
	get: async (key) => (await browser.storage.local.get(key))[key],
	set: (key, value) => browser.storage.local.set({ [key]: value }),
	remove: (key) => browser.storage.local.remove(key),
};
