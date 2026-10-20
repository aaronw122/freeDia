import type { ChatClient } from "../client/types";
import {
	DEFAULT_SHORTCUT,
	matchesShortcut,
	type Shortcut,
} from "../lib/shortcut";

export const HOST_TAG = "freedia-chat";
export const OPEN_EVENT = "freedia:open";

export interface ChatUi {
	mountChat(root: ShadowRoot, client: ChatClient): () => void;
	createClient(): ChatClient;
}

export interface ControllerDeps {
	window: Window;
	loadUi(): Promise<ChatUi>;
}

const HOST_STYLE =
	"all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";

export class ContentController {
	private shortcut: Shortcut = DEFAULT_SHORTCUT;
	private root: ShadowRoot | null = null;
	private client: ChatClient | null = null;
	private queue: Promise<void> = Promise.resolve();
	private unmount: (() => void) | null = null;
	private readonly onKeyDown = (event: KeyboardEvent) => {
		if (!matchesShortcut(event, this.shortcut)) {
			return;
		}
		event.preventDefault();
		event.stopImmediatePropagation();
		void this.open();
	};

	constructor(private readonly deps: ControllerDeps) {
		deps.window.addEventListener("keydown", this.onKeyDown, true);
	}

	setShortcut(shortcut: Shortcut): void {
		this.shortcut = shortcut;
	}

	open(): Promise<void> {
		const selection = this.deps.window.getSelection()?.toString().trim() ?? "";
		const next = this.queue.then(() => this.show(selection));
		this.queue = next.catch(() => undefined);
		return next;
	}

	destroy(): void {
		this.deps.window.removeEventListener("keydown", this.onKeyDown, true);
		this.unmount?.();
		this.unmount = null;
		this.root?.host.remove();
		this.root = null;
	}

	private async show(selection: string): Promise<void> {
		if (this.root !== null && this.client !== null) {
			if (selection !== "") {
				this.client.addQuote(selection);
			}
			this.root.dispatchEvent(new CustomEvent(OPEN_EVENT));
			return;
		}
		const ui = await this.deps.loadUi();
		const document = this.deps.window.document;
		const host = document.createElement(HOST_TAG);
		host.setAttribute("style", HOST_STYLE);
		const root = host.attachShadow({ mode: "open" });
		document.documentElement.append(host);
		const client = ui.createClient();
		if (selection !== "") {
			client.addQuote(selection);
		}
		this.unmount = ui.mountChat(root, client);
		this.root = root;
		this.client = client;
	}
}
