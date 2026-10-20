import type { ExtensionToHelper, HelperToExtension } from "freedia/protocol";
import type { ConnectionState } from "../client/types";

export const CHAT_PORT_NAME = "freedia-chat";

export const OPEN_CHAT_MESSAGE = "freedia:open-chat";

export interface TabState {
	type: "tab.state";
	chatId: string;
	connection: ConnectionState;
	connectionId: string;
}

export type TabToWorker =
	| { type: "tab.hello" }
	| { type: "tab.newChat" }
	| { type: "tab.openChat"; chatId: string }
	| { type: "helper"; message: ExtensionToHelper };

export type WorkerToTab =
	| TabState
	| { type: "helper"; message: HelperToExtension };
