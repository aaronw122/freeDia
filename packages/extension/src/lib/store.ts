import type { PageRecord } from "../page/context";
import { DEFAULT_SHORTCUT, isShortcut, type Shortcut } from "./shortcut";

export interface KeyValueStore {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	remove(key: string): Promise<void>;
}

export interface Settings {
	shortcut: Shortcut;
	maxConcurrent: number;
	onboarded: boolean;
}

export const DEFAULT_MAX_CONCURRENT = 3;

export const SETTINGS_KEY = "settings";
const TAB_CHATS_KEY = "tabChats";
const PAGE_KEY_PREFIX = "page:";

export const DEFAULT_SETTINGS: Settings = {
	shortcut: DEFAULT_SHORTCUT,
	maxConcurrent: DEFAULT_MAX_CONCURRENT,
	onboarded: false,
};

export function parseSettings(value: unknown): Settings {
	if (typeof value !== "object" || value === null) {
		return DEFAULT_SETTINGS;
	}
	const v = value as Record<string, unknown>;
	return {
		shortcut: isShortcut(v.shortcut) ? v.shortcut : DEFAULT_SETTINGS.shortcut,
		maxConcurrent:
			typeof v.maxConcurrent === "number" &&
			Number.isInteger(v.maxConcurrent) &&
			v.maxConcurrent > 0
				? v.maxConcurrent
				: DEFAULT_SETTINGS.maxConcurrent,
		onboarded: v.onboarded === true,
	};
}

export async function loadSettings(store: KeyValueStore): Promise<Settings> {
	return parseSettings(await store.get(SETTINGS_KEY));
}

export async function saveSettings(
	store: KeyValueStore,
	patch: Partial<Settings>,
): Promise<Settings> {
	const next = { ...(await loadSettings(store)), ...patch };
	await store.set(SETTINGS_KEY, next);
	return next;
}

export async function loadTabChats(
	store: KeyValueStore,
): Promise<Record<string, string>> {
	const value = await store.get(TAB_CHATS_KEY);
	if (typeof value !== "object" || value === null) {
		return {};
	}
	const map: Record<string, string> = {};
	for (const [tabId, chatId] of Object.entries(value)) {
		if (typeof chatId === "string") {
			map[tabId] = chatId;
		}
	}
	return map;
}

export async function saveTabChats(
	store: KeyValueStore,
	map: Record<string, string>,
): Promise<void> {
	await store.set(TAB_CHATS_KEY, map);
}

function isPageRecord(value: unknown): value is PageRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const v = value as Record<string, unknown>;
	return (
		(v.fingerprint === null || typeof v.fingerprint === "string") &&
		typeof v.sentAt === "number" &&
		typeof v.fileKey === "string"
	);
}

export async function loadPageRecord(
	store: KeyValueStore,
	chatId: string,
): Promise<PageRecord | null> {
	const value = await store.get(PAGE_KEY_PREFIX + chatId);
	return isPageRecord(value) ? value : null;
}

export async function savePageRecord(
	store: KeyValueStore,
	chatId: string,
	record: PageRecord,
): Promise<void> {
	await store.set(PAGE_KEY_PREFIX + chatId, record);
}

export async function forgetPageFile(
	store: KeyValueStore,
	chatId: string,
): Promise<void> {
	const record = await loadPageRecord(store, chatId);
	if (record !== null) {
		await savePageRecord(store, chatId, { ...record, fileKey: "" });
	}
}

export async function removePageRecord(
	store: KeyValueStore,
	chatId: string,
): Promise<void> {
	await store.remove(PAGE_KEY_PREFIX + chatId);
}

export interface MemoryStore extends KeyValueStore {
	data: Map<string, unknown>;
}

export function memoryStore(): MemoryStore {
	const data = new Map<string, unknown>();
	return {
		data,
		get: async (key) => structuredClone(data.get(key)),
		set: async (key, value) => {
			data.set(key, structuredClone(value));
		},
		remove: async (key) => {
			data.delete(key);
		},
	};
}
