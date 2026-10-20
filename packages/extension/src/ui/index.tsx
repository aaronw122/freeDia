import type { ChatClient } from "../client/types";
import { chromeWindowStore } from "./layout";
import { mountChatWithStore } from "./mount";

export { OPEN_EVENT } from "./ChatApp";

export function mountChat(root: ShadowRoot, client: ChatClient): () => void {
	return mountChatWithStore(root, client, chromeWindowStore());
}
