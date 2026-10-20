import { useEffect, useState } from "react";
import {
	DEFAULT_SHORTCUT,
	formatShortcut,
	type Shortcut,
	shortcutFromEvent,
} from "../lib/shortcut";
import {
	DEFAULT_SETTINGS,
	type KeyValueStore,
	loadSettings,
	type Settings,
	saveSettings,
} from "../lib/store";

const MAX_CONCURRENT_LIMIT = 10;

export function SettingsPage({ store }: { store: KeyValueStore }) {
	const [settings, setSettings] = useState<Settings | null>(null);
	const [recording, setRecording] = useState(false);

	useEffect(() => {
		void loadSettings(store).then(setSettings);
	}, [store]);

	useEffect(() => {
		if (!recording) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.code === "Escape") {
				setRecording(false);
				return;
			}
			const shortcut = shortcutFromEvent(event);
			if (shortcut !== null) {
				setRecording(false);
				void saveSettings(store, { shortcut, onboarded: true }).then(
					setSettings,
				);
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [recording, store]);

	if (settings === null) {
		return null;
	}

	const update = (patch: Partial<Settings>) => {
		void saveSettings(store, patch).then(setSettings);
	};
	const keep = (shortcut: Shortcut) => update({ shortcut, onboarded: true });

	return (
		<main className="mx-auto max-w-xl space-y-8 p-10 font-sans text-neutral-900">
			<header className="space-y-2">
				<h1 className="font-semibold text-2xl">
					{settings.onboarded ? "freeDia settings" : "Welcome to freeDia"}
				</h1>
				{!settings.onboarded && (
					<p className="text-neutral-600">
						Pick the shortcut that opens freeDia's chat on any page.
					</p>
				)}
			</header>

			<section className="space-y-3" aria-labelledby="shortcut-heading">
				<h2 id="shortcut-heading" className="font-medium text-lg">
					Shortcut
				</h2>
				<div className="flex items-center gap-3">
					<kbd
						className="rounded-md border border-neutral-300 bg-neutral-50 px-3 py-1.5 font-mono text-base"
						data-testid="current-shortcut"
					>
						{recording
							? "Press a combination…"
							: formatShortcut(settings.shortcut)}
					</kbd>
					{!settings.onboarded && !recording && (
						<button
							type="button"
							className="rounded-md bg-neutral-900 px-3 py-1.5 text-white"
							onClick={() => keep(settings.shortcut)}
						>
							Keep {formatShortcut(settings.shortcut)}
						</button>
					)}
					<button
						type="button"
						className="rounded-md border border-neutral-300 px-3 py-1.5"
						onClick={() => setRecording(!recording)}
					>
						{recording ? "Cancel" : "Pick another shortcut"}
					</button>
					{settings.onboarded &&
						!recording &&
						formatShortcut(settings.shortcut) !==
							formatShortcut(DEFAULT_SHORTCUT) && (
							<button
								type="button"
								className="rounded-md border border-neutral-300 px-3 py-1.5"
								onClick={() => keep(DEFAULT_SHORTCUT)}
							>
								Reset to {formatShortcut(DEFAULT_SHORTCUT)}
							</button>
						)}
				</div>
				<p className="text-neutral-600 text-sm">
					Dia uses ⌘E for its own chat: turn it off in Dia → Settings →
					Shortcuts, or pick another shortcut here. ⇧⌘E always works too.
				</p>
			</section>

			<section className="space-y-3" aria-labelledby="concurrency-heading">
				<h2 id="concurrency-heading" className="font-medium text-lg">
					Chats at once
				</h2>
				<label className="flex items-center gap-3">
					<span>Max chats generating at the same time</span>
					<input
						type="number"
						min={1}
						max={MAX_CONCURRENT_LIMIT}
						value={settings.maxConcurrent}
						className="w-20 rounded-md border border-neutral-300 px-2 py-1"
						onChange={(event) => {
							const value = Number.parseInt(event.target.value, 10);
							if (
								Number.isInteger(value) &&
								value >= 1 &&
								value <= MAX_CONCURRENT_LIMIT
							) {
								update({ maxConcurrent: value });
							}
						}}
					/>
				</label>
				<p className="text-neutral-600 text-sm">
					Extra chats wait until one finishes. Default{" "}
					{DEFAULT_SETTINGS.maxConcurrent}.
				</p>
			</section>
		</main>
	);
}
