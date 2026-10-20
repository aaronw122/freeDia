export interface Shortcut {
	code: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

export const DEFAULT_SHORTCUT: Shortcut = {
	code: "KeyE",
	metaKey: true,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
};

type KeyLike = Pick<
	KeyboardEvent,
	"code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

const MODIFIER_CODES: Record<string, true> = {
	MetaLeft: true,
	MetaRight: true,
	ControlLeft: true,
	ControlRight: true,
	AltLeft: true,
	AltRight: true,
	ShiftLeft: true,
	ShiftRight: true,
	CapsLock: true,
	Fn: true,
	OSLeft: true,
	OSRight: true,
};

export function matchesShortcut(event: KeyLike, shortcut: Shortcut): boolean {
	return (
		event.code === shortcut.code &&
		event.metaKey === shortcut.metaKey &&
		event.ctrlKey === shortcut.ctrlKey &&
		event.altKey === shortcut.altKey &&
		event.shiftKey === shortcut.shiftKey
	);
}

export function shortcutFromEvent(event: KeyLike): Shortcut | null {
	if (event.code === "" || MODIFIER_CODES[event.code]) {
		return null;
	}
	if (!event.metaKey && !event.ctrlKey && !event.altKey) {
		return null;
	}
	return {
		code: event.code,
		metaKey: event.metaKey,
		ctrlKey: event.ctrlKey,
		altKey: event.altKey,
		shiftKey: event.shiftKey,
	};
}

export function isShortcut(value: unknown): value is Shortcut {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const v = value as Record<string, unknown>;
	return (
		typeof v.code === "string" &&
		v.code !== "" &&
		typeof v.metaKey === "boolean" &&
		typeof v.ctrlKey === "boolean" &&
		typeof v.altKey === "boolean" &&
		typeof v.shiftKey === "boolean"
	);
}

function keyLabel(code: string): string {
	if (code.startsWith("Key")) {
		return code.slice(3);
	}
	if (code.startsWith("Digit")) {
		return code.slice(5);
	}
	return code;
}

export function formatShortcut(shortcut: Shortcut): string {
	return [
		shortcut.ctrlKey ? "⌃" : "",
		shortcut.altKey ? "⌥" : "",
		shortcut.shiftKey ? "⇧" : "",
		shortcut.metaKey ? "⌘" : "",
		keyLabel(shortcut.code),
	].join("");
}
