import { browser } from "wxt/browser";

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface WindowLayout {
	rect: Rect;
	expanded: boolean;
}

export interface WindowStore {
	load(): Promise<WindowLayout | null>;
	save(layout: WindowLayout): Promise<void>;
}

export interface Viewport {
	width: number;
	height: number;
}

export type ResizeEdge = "nw" | "ne" | "sw" | "se";

export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 360;
const MARGIN = 16;
const STORAGE_KEY = "freedia.window";

function isRect(value: unknown): value is Rect {
	if (typeof value !== "object" || value === null) return false;
	const rect = value as Record<string, unknown>;
	return ["x", "y", "width", "height"].every(
		(key) => typeof rect[key] === "number" && Number.isFinite(rect[key]),
	);
}

export function isWindowLayout(value: unknown): value is WindowLayout {
	if (typeof value !== "object" || value === null) return false;
	const layout = value as Record<string, unknown>;
	return isRect(layout.rect) && typeof layout.expanded === "boolean";
}

export function chromeWindowStore(): WindowStore {
	return {
		async load() {
			const stored = await browser.storage.local.get(STORAGE_KEY);
			const value = stored[STORAGE_KEY];
			return isWindowLayout(value) ? value : null;
		},
		async save(layout) {
			await browser.storage.local.set({ [STORAGE_KEY]: layout });
		},
	};
}

export function memoryWindowStore(initial: WindowLayout | null = null) {
	let saved = initial;
	const store: WindowStore & { saved(): WindowLayout | null } = {
		async load() {
			return saved;
		},
		async save(layout) {
			saved = layout;
		},
		saved: () => saved,
	};
	return store;
}

export function defaultRect(viewport: Viewport): Rect {
	const width = Math.min(400, viewport.width - MARGIN * 2);
	const height = Math.min(620, viewport.height - MARGIN * 2);
	return {
		x: viewport.width - width - MARGIN * 1.5,
		y: MARGIN * 1.5,
		width,
		height,
	};
}

export function expandedRect(viewport: Viewport): Rect {
	const width = Math.max(MIN_WIDTH, Math.min(760, viewport.width - MARGIN * 2));
	return {
		x: viewport.width - width - MARGIN,
		y: MARGIN,
		width,
		height: Math.max(MIN_HEIGHT, viewport.height - MARGIN * 2),
	};
}

export function clampRect(rect: Rect, viewport: Viewport): Rect {
	const width = Math.max(
		MIN_WIDTH,
		Math.min(rect.width, Math.max(MIN_WIDTH, viewport.width)),
	);
	const height = Math.max(
		MIN_HEIGHT,
		Math.min(rect.height, Math.max(MIN_HEIGHT, viewport.height)),
	);
	return {
		x: Math.min(Math.max(0, rect.x), Math.max(0, viewport.width - width)),
		y: Math.min(Math.max(0, rect.y), Math.max(0, viewport.height - height)),
		width,
		height,
	};
}

export function resizeRect(
	start: Rect,
	edge: ResizeEdge,
	dx: number,
	dy: number,
	viewport: Viewport,
): Rect {
	const west = edge === "nw" || edge === "sw";
	const north = edge === "nw" || edge === "ne";
	const right = start.x + start.width;
	const bottom = start.y + start.height;
	const width = west
		? Math.min(Math.max(MIN_WIDTH, start.width - dx), right)
		: Math.min(Math.max(MIN_WIDTH, start.width + dx), viewport.width - start.x);
	const height = north
		? Math.min(Math.max(MIN_HEIGHT, start.height - dy), bottom)
		: Math.min(
				Math.max(MIN_HEIGHT, start.height + dy),
				viewport.height - start.y,
			);
	return {
		x: west ? right - width : start.x,
		y: north ? bottom - height : start.y,
		width,
		height,
	};
}
