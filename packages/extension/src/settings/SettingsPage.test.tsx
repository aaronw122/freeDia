import { afterEach, describe, expect, test } from "bun:test";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { DEFAULT_SHORTCUT } from "../lib/shortcut";
import { loadSettings, memoryStore, saveSettings } from "../lib/store";
import { SettingsPage } from "./SettingsPage";

afterEach(cleanup);

describe("onboarding and settings", () => {
	test("first run offers ⌘E as the default, with the Dia note", async () => {
		const store = memoryStore();
		render(<SettingsPage store={store} />);
		expect(await screen.findByText("Welcome to freeDia")).toBeDefined();
		expect(screen.getByTestId("current-shortcut").textContent).toBe("⌘E");
		expect(
			screen.getByText(
				"Dia uses ⌘E for its own chat: turn it off in Dia → Settings → Shortcuts, or pick another shortcut here. ⇧⌘E always works too.",
			),
		).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Keep ⌘E" }));
		await waitFor(async () =>
			expect((await loadSettings(store)).onboarded).toBe(true),
		);
		expect((await loadSettings(store)).shortcut).toEqual(DEFAULT_SHORTCUT);
	});

	test("pressing another combination changes the shortcut", async () => {
		const store = memoryStore();
		render(<SettingsPage store={store} />);
		fireEvent.click(
			await screen.findByRole("button", { name: "Pick another shortcut" }),
		);
		expect(screen.getByTestId("current-shortcut").textContent).toBe(
			"Press a combination…",
		);
		fireEvent.keyDown(window, {
			key: "Shift",
			code: "ShiftLeft",
			shiftKey: true,
		});
		fireEvent.keyDown(window, { key: "k", code: "KeyK" });
		expect(screen.getByTestId("current-shortcut").textContent).toBe(
			"Press a combination…",
		);
		fireEvent.keyDown(window, {
			key: "K",
			code: "KeyK",
			ctrlKey: true,
			shiftKey: true,
		});
		await waitFor(() =>
			expect(screen.getByTestId("current-shortcut").textContent).toBe("⌃⇧K"),
		);
		expect((await loadSettings(store)).shortcut).toEqual({
			code: "KeyK",
			metaKey: false,
			ctrlKey: true,
			altKey: false,
			shiftKey: true,
		});
	});

	test("max concurrent chats defaults to 3 and is saved", async () => {
		const store = memoryStore();
		await saveSettings(store, { onboarded: true });
		render(<SettingsPage store={store} />);
		const input = await screen.findByRole("spinbutton");
		expect((input as HTMLInputElement).value).toBe("3");
		fireEvent.change(input, { target: { value: "5" } });
		await waitFor(async () =>
			expect((await loadSettings(store)).maxConcurrent).toBe(5),
		);
		fireEvent.change(input, { target: { value: "0" } });
		expect((await loadSettings(store)).maxConcurrent).toBe(5);
	});
});
