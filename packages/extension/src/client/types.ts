import type {
	ChatState,
	ChatSummary,
	HelperError,
	PiRpcRecord,
} from "freedia/protocol";

export interface Quote {
	id: string;
	text: string;
}

export interface ModelRef {
	provider: string;
	modelId: string;
}

export interface ModelInfo extends ModelRef {
	name: string;
	contextWindow: number;
}

export type PageReadability = "readable" | "unreadable";

export type ConnectionState = "connecting" | "connected" | "helper_missing";

export type ClientEvent =
	| { type: "rpc"; chatId: string; rpc: PiRpcRecord }
	| { type: "status"; chatId: string; state: ChatState }
	| { type: "helper_error"; error: HelperError }
	| { type: "connection"; state: ConnectionState }
	| { type: "chat_changed"; chatId: string }
	| { type: "quotes_changed"; quotes: Quote[] }
	| { type: "page"; readability: PageReadability };

export type ClientListener = (event: ClientEvent) => void;

export interface ChatClient {
	currentChatId(): string;
	quotes(): Quote[];
	pageReadability(): PageReadability;
	connection(): ConnectionState;

	send(question: string): Promise<void>;
	abort(): Promise<void>;
	newChat(): Promise<string>;
	addQuote(text: string): Quote;
	removeQuote(id: string): void;

	listModels(): Promise<ModelInfo[]>;
	currentModel(): Promise<ModelRef | null>;
	setModel(model: ModelRef): Promise<void>;

	listChats(): Promise<ChatSummary[]>;
	openChat(chatId: string): Promise<PiRpcRecord[]>;
	deleteChat(chatId: string): Promise<void>;

	subscribe(listener: ClientListener): () => void;
}
