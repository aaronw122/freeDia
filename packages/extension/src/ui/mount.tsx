import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ChatClient } from "../client/types";
import { ChatApp } from "./ChatApp";
import type { WindowStore } from "./layout";
import css from "./styles.css?inline";

export function mountChatWithStore(
	root: ShadowRoot,
	client: ChatClient,
	store: WindowStore,
): () => void {
	const style = document.createElement("style");
	style.textContent = css;
	const container = document.createElement("div");
	container.className = "fd-root";
	root.append(style, container);
	const reactRoot = createRoot(container);
	reactRoot.render(
		<StrictMode>
			<ChatApp client={client} store={store} events={root} />
		</StrictMode>,
	);
	return () => {
		reactRoot.unmount();
		container.remove();
		style.remove();
	};
}
