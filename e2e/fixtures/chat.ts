import {
	type BrowserContext,
	type CDPSession,
	expect,
	type Locator,
	type Page,
} from "@playwright/test";
import { EXTENSION_ID } from "./env";

const OPEN_SHADOW_PATCH = `(() => {
	if (globalThis.__freediaE2eOpenShadow) return true;
	globalThis.__freediaE2eOpenShadow = true;
	const attach = Element.prototype.attachShadow;
	Element.prototype.attachShadow = function (init) {
		return attach.call(this, { ...init, mode: "open" });
	};
	return true;
})()`;

export const REPLY_TIMEOUT = 30_000;

export class ChatPage {
	private cdp: CDPSession | null = null;
	private readonly contexts = new Set<number>();

	constructor(readonly page: Page) {}

	static async open(context: BrowserContext, url: string): Promise<ChatPage> {
		const page = await context.newPage();
		const chat = new ChatPage(page);
		await chat.goto(url);
		return chat;
	}

	async goto(url: string): Promise<void> {
		await this.page.goto(url);
		await this.exposeShadow();
	}

	async reload(): Promise<void> {
		await this.page.reload();
		await this.exposeShadow();
	}

	async exposeShadow(): Promise<void> {
		if (this.cdp === null) {
			const cdp = await this.page.context().newCDPSession(this.page);
			cdp.on("Runtime.executionContextCreated", ({ context }) => {
				if (context.origin === `chrome-extension://${EXTENSION_ID}`) {
					this.contexts.add(context.id);
				}
			});
			cdp.on("Runtime.executionContextDestroyed", (event) => {
				this.contexts.delete(event.executionContextId);
			});
			cdp.on("Runtime.executionContextsCleared", () => this.contexts.clear());
			this.cdp = cdp;
			await cdp.send("Runtime.enable");
		}
		await expect
			.poll(() => this.contexts.size, {
				message: "freeDia content script world",
			})
			.toBeGreaterThan(0);
		for (const contextId of this.contexts) {
			await this.cdp
				.send("Runtime.evaluate", { expression: OPEN_SHADOW_PATCH, contextId })
				.catch(() => this.contexts.delete(contextId));
		}
	}

	async select(text: string): Promise<void> {
		await this.page.evaluate((needle) => {
			const walker = document.createTreeWalker(
				document.body,
				NodeFilter.SHOW_TEXT,
			);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const at = node.textContent?.indexOf(needle) ?? -1;
				if (at >= 0) {
					const range = document.createRange();
					range.setStart(node, at);
					range.setEnd(node, at + needle.length);
					const selection = window.getSelection();
					selection?.removeAllRanges();
					selection?.addRange(range);
					(node.parentElement as HTMLElement).scrollIntoView({
						block: "center",
					});
					return;
				}
			}
			throw new Error(`text not on page: ${needle}`);
		}, text);
	}

	async clearSelection(): Promise<void> {
		await this.page.evaluate(() => window.getSelection()?.removeAllRanges());
	}

	async pressShortcut(keys = "Meta+e"): Promise<void> {
		await this.exposeShadow();
		await this.page.keyboard.press(keys);
	}

	async open(): Promise<void> {
		await this.pressShortcut();
		await expect(this.dialog).toBeVisible();
	}

	get dialog(): Locator {
		return this.page.getByRole("dialog", { name: "freeDia chat" });
	}

	get chips(): Locator {
		return this.dialog
			.getByRole("list", { name: "Attachments" })
			.getByRole("listitem");
	}

	get input(): Locator {
		return this.dialog.getByRole("textbox", { name: "Message" });
	}

	get assistant(): Locator {
		return this.dialog.getByRole("article", { name: "Assistant message" });
	}

	get sendButton(): Locator {
		return this.dialog.getByRole("button", { name: "Send" });
	}

	get stopButton(): Locator {
		return this.dialog.getByRole("button", { name: "Stop" });
	}

	button(name: string): Locator {
		return this.dialog.getByRole("button", { name, exact: true });
	}

	async ready(): Promise<void> {
		await expect(this.input).toBeEnabled({ timeout: REPLY_TIMEOUT });
	}

	async send(text: string): Promise<void> {
		await this.ready();
		await expect(this.sendButton).toBeVisible({ timeout: REPLY_TIMEOUT });
		await this.input.fill(text);
		await this.input.press("Enter");
	}

	async waitForReplies(count: number): Promise<Locator> {
		const reply = this.assistant.nth(count - 1);
		await expect(reply.getByRole("button", { name: "Copy" })).toBeVisible({
			timeout: REPLY_TIMEOUT,
		});
		await expect(this.sendButton).toBeVisible();
		return reply;
	}

	async ask(text: string): Promise<Locator> {
		const before = await this.assistant.count();
		await this.send(text);
		return this.waitForReplies(before + 1);
	}
}
