export const NATIVE_HOST_NAME = "com.freedia.helper";

export const FORWARDED_RPC_TYPES = [
	"prompt",
	"abort",
	"set_model",
	"get_available_models",
	"get_messages",
	"get_state",
] as const;

export type ForwardedRpcType = (typeof FORWARDED_RPC_TYPES)[number];

export interface PiRpcRecord {
	type: string;
	id?: string;
	[key: string]: unknown;
}

export interface ForwardedRpc extends PiRpcRecord {
	type: ForwardedRpcType;
}

export interface Envelope<Rpc extends PiRpcRecord = PiRpcRecord> {
	chatId: string;
	rpc: Rpc;
}

export interface HelperHelloRequest {
	type: "helper.hello";
	id: string;
	maxConcurrent: number;
}

export interface HelperHelloResponse {
	type: "helper.hello";
	id: string;
	helperVersion: string;
	piVersion: string;
}

export interface ChatListRequest {
	type: "chat.list";
	id: string;
}

export interface ChatSummary {
	chatId: string;
	title: string;
	updatedAt: string;
}

export interface ChatListResponse {
	type: "chat.list";
	id: string;
	chats: ChatSummary[];
}

export interface ChatDeleteRequest {
	type: "chat.delete";
	id: string;
	chatId: string;
}

export interface ChatDeleteResponse {
	type: "chat.delete";
	id: string;
	chatId: string;
}

export type ChatState = "starting" | "queued";

export interface ChatStatus {
	type: "chat.status";
	chatId: string;
	state: ChatState;
}

export type HelperErrorCode = "pi_missing" | "not_signed_in" | "spawn_failed";

export interface HelperError {
	id?: string;
	type: "helper.error";
	chatId?: string;
	code: HelperErrorCode;
	message: string;
	fix: string;
}

export type HelperCommand =
	| HelperHelloRequest
	| ChatListRequest
	| ChatDeleteRequest;

export type HelperReply =
	| HelperHelloResponse
	| ChatListResponse
	| ChatDeleteResponse;

export type HelperPush = ChatStatus | HelperError;

export type ExtensionToHelper = Envelope<ForwardedRpc> | HelperCommand;

export type HelperToExtension = Envelope | HelperReply | HelperPush;

export const CHAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

const forwardedRpcTypes: ReadonlySet<string> = new Set(FORWARDED_RPC_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isForwardedRpcType(value: unknown): value is ForwardedRpcType {
	return typeof value === "string" && forwardedRpcTypes.has(value);
}

export function isForwardedRpc(value: unknown): value is ForwardedRpc {
	return isRecord(value) && isForwardedRpcType(value.type);
}

export function isChatId(value: unknown): value is string {
	return typeof value === "string" && CHAT_ID_PATTERN.test(value);
}

export function isEnvelope(value: unknown): value is Envelope {
	return (
		isRecord(value) &&
		isChatId(value.chatId) &&
		isRecord(value.rpc) &&
		typeof value.rpc.type === "string"
	);
}

export function isHelperCommand(value: unknown): value is HelperCommand {
	if (!isRecord(value) || typeof value.id !== "string") {
		return false;
	}
	switch (value.type) {
		case "helper.hello":
			return (
				typeof value.maxConcurrent === "number" &&
				Number.isInteger(value.maxConcurrent) &&
				value.maxConcurrent > 0
			);
		case "chat.list":
			return true;
		case "chat.delete":
			return isChatId(value.chatId);
		default:
			return false;
	}
}

export function isChatStatus(value: unknown): value is ChatStatus {
	return (
		isRecord(value) &&
		value.type === "chat.status" &&
		isChatId(value.chatId) &&
		(value.state === "starting" || value.state === "queued")
	);
}
