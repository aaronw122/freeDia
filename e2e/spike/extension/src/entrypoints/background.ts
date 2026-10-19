export default defineBackground(() => {
	browser.commands.onCommand.addListener(async (command, tab) => {
		const stored = await browser.storage.local.get("commands");
		const log: unknown[] = Array.isArray(stored.commands)
			? stored.commands
			: [];
		log.push({ command, tabId: tab?.id ?? null, at: Date.now() });
		await browser.storage.local.set({ commands: log });
		if (tab?.id !== undefined) {
			browser.tabs
				.sendMessage(tab.id, { type: "command", command })
				.catch(() => {});
		}
	});
});
