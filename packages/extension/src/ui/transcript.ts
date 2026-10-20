import type { HelperError, PiRpcRecord } from "freedia/protocol";
import type { ClientEvent } from "../client/types";
import { asRecord } from "./records";

export type RunPhase =
	| "idle"
	| "sending"
	| "starting"
	| "queued"
	| "thinking"
	| "streaming"
	| "tool"
	| "retrying";

export interface UserTurn {
	kind: "user";
	key: string;
	text: string;
	pending: boolean;
}

export interface ReplySegment {
	parts: string[];
	stopReason: string | null;
	errorMessage: string | null;
	provider: string | null;
}

export interface AssistantTurn {
	kind: "assistant";
	key: string;
	segments: ReplySegment[];
	done: boolean;
}

export type Turn = UserTurn | AssistantTurn;

export interface RetryInfo {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
	provider: string | null;
}

export type ChatError =
	| { source: "helper"; error: HelperError }
	| { source: "prompt"; message: string }
	| { source: "action"; title: string; message: string };

export interface TranscriptState {
	chatId: string;
	turns: Turn[];
	phase: RunPhase;
	tool: string | null;
	retry: RetryInfo | null;
	error: ChatError | null;
	draft: { text: string; seq: number } | null;
	seq: number;
}

export type TranscriptAction =
	| { type: "client"; event: ClientEvent }
	| { type: "send"; text: string }
	| { type: "send_failed"; message: string }
	| { type: "reset"; chatId: string }
	| { type: "loaded"; chatId: string; messages: PiRpcRecord[] }
	| { type: "restored"; chatId: string; messages: PiRpcRecord[] }
	| { type: "failed"; title: string; message: string };

const WAITING_PHASES: ReadonlySet<RunPhase> = new Set([
	"sending",
	"starting",
	"queued",
]);

const ABORTED_SEGMENT: ReplySegment = {
	parts: [],
	stopReason: "aborted",
	errorMessage: null,
	provider: null,
};

export function initialTranscript(chatId: string): TranscriptState {
	return {
		chatId,
		turns: [],
		phase: "idle",
		tool: null,
		retry: null,
		error: null,
		draft: null,
		seq: 0,
	};
}

export function isRunning(state: TranscriptState): boolean {
	return state.phase !== "idle";
}

export function assistantText(turn: AssistantTurn): string {
	return turn.segments
		.map((segment) => segment.parts.join("").trim())
		.filter((text) => text.length > 0)
		.join("\n\n");
}

export function replyFailure(turn: AssistantTurn): ReplySegment | null {
	const last = turn.segments.at(-1);
	return last?.stopReason === "error" ? last : null;
}

export function replyStopped(turn: AssistantTurn): boolean {
	return turn.segments.some((segment) => segment.stopReason === "aborted");
}

export function questionFromPrompt(text: string): string {
	const lines = text.split("\n");
	const index = lines.findLastIndex((line) => /^## Question[ \t]*$/.test(line));
	if (index === -1) return text.trim();
	return lines
		.slice(index + 1)
		.join("\n")
		.trim();
}

export function toolLabel(toolName: string): string {
	switch (toolName) {
		case "read":
			return "Reading the page…";
		case "grep":
			return "Searching the page…";
		case "find":
			return "Looking for files…";
		case "ls":
			return "Listing files…";
		default:
			return `Using ${toolName}…`;
	}
}

interface PiMessage {
	role: string;
	content: unknown;
	stopReason: unknown;
	errorMessage: unknown;
	provider: unknown;
}

function asMessage(value: unknown): PiMessage | null {
	const record = asRecord(value);
	if (!record || typeof record.role !== "string") return null;
	return {
		role: record.role,
		content: record.content,
		stopReason: record.stopReason,
		errorMessage: record.errorMessage,
		provider: record.provider,
	};
}

function textParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.map((block) => {
		const record = asRecord(block);
		return record?.type === "text" && typeof record.text === "string"
			? record.text
			: "";
	});
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function segmentFromMessage(message: PiMessage): ReplySegment {
	return {
		parts: textParts(message.content),
		stopReason: stringOrNull(message.stopReason),
		errorMessage: stringOrNull(message.errorMessage),
		provider: stringOrNull(message.provider),
	};
}

export function turnsFromMessages(messages: PiRpcRecord[]): Turn[] {
	const turns: Turn[] = [];
	messages.forEach((raw, index) => {
		const message = asMessage(raw);
		if (!message) return;
		const last = turns.at(-1);
		if (message.role === "user") {
			turns.push({
				kind: "user",
				key: `m${index}`,
				text: questionFromPrompt(textParts(message.content).join("")),
				pending: false,
			});
		} else if (message.role === "assistant" && last?.kind === "assistant") {
			last.segments.push(segmentFromMessage(message));
		} else if (message.role === "assistant") {
			turns.push({
				kind: "assistant",
				key: `m${index}`,
				segments: [segmentFromMessage(message)],
				done: true,
			});
		}
	});
	return turns;
}

function nextKey(state: TranscriptState): [string, number] {
	return [`t${state.seq}`, state.seq + 1];
}

function openReply(state: TranscriptState): AssistantTurn | null {
	const last = state.turns.at(-1);
	return last?.kind === "assistant" && !last.done ? last : null;
}

function withOpenReply(
	state: TranscriptState,
	update: (turn: AssistantTurn) => AssistantTurn,
): TranscriptState {
	const turn = openReply(state);
	if (turn) {
		return { ...state, turns: [...state.turns.slice(0, -1), update(turn)] };
	}
	const [key, seq] = nextKey(state);
	const fresh: AssistantTurn = {
		kind: "assistant",
		key,
		segments: [],
		done: false,
	};
	return { ...state, seq, turns: [...state.turns, update(fresh)] };
}

function withLastSegment(
	turn: AssistantTurn,
	update: (segment: ReplySegment) => ReplySegment,
): AssistantTurn {
	const last = turn.segments.at(-1);
	if (!last) return turn;
	return { ...turn, segments: [...turn.segments.slice(0, -1), update(last)] };
}

function dropPendingUser(
	state: TranscriptState,
): [Turn[], { text: string; seq: number } | null] {
	const index = state.turns.findLastIndex(
		(turn) => turn.kind === "user" && turn.pending,
	);
	const pending = state.turns[index];
	if (pending?.kind !== "user") return [state.turns, null];
	return [
		state.turns.filter((_, i) => i !== index),
		{ text: pending.text, seq: state.seq },
	];
}

function failSend(state: TranscriptState, error: ChatError): TranscriptState {
	const [turns, draft] = dropPendingUser(state);
	return {
		...state,
		turns,
		phase: "idle",
		tool: null,
		retry: null,
		error,
		draft: draft ?? state.draft,
		seq: state.seq + 1,
	};
}

function hasPendingUser(state: TranscriptState): boolean {
	return state.turns.some((turn) => turn.kind === "user" && turn.pending);
}

function onAssistantEvent(
	state: TranscriptState,
	event: Record<string, unknown>,
): TranscriptState {
	const turn = openReply(state);
	if (!turn || turn.segments.length === 0) return state;
	const index = typeof event.contentIndex === "number" ? event.contentIndex : 0;
	const text =
		event.type === "text_delta" && typeof event.delta === "string"
			? { value: event.delta, append: true }
			: event.type === "text_end" && typeof event.content === "string"
				? { value: event.content, append: false }
				: null;
	if (!text) return state;
	const next = withOpenReply(state, (open) =>
		withLastSegment(open, (segment) => {
			const parts = [...segment.parts];
			while (parts.length <= index) parts.push("");
			parts[index] = text.append
				? `${parts[index] ?? ""}${text.value}`
				: text.value;
			return { ...segment, parts };
		}),
	);
	const firstText =
		text.value.length > 0 &&
		(state.phase === "thinking" || state.phase === "retrying");
	return firstText ? { ...next, phase: "streaming", retry: null } : next;
}

function onMessageStart(
	state: TranscriptState,
	message: PiMessage,
): TranscriptState {
	if (message.role !== "assistant") return state;
	const next = withOpenReply(state, (turn) => ({
		...turn,
		segments: [
			...turn.segments,
			{ ...segmentFromMessage(message), parts: [], stopReason: null },
		],
	}));
	return {
		...next,
		tool: null,
		phase: state.phase === "retrying" ? "retrying" : "thinking",
	};
}

function onUserEcho(
	state: TranscriptState,
	message: PiMessage,
): TranscriptState {
	const text = questionFromPrompt(textParts(message.content).join(""));
	const pending = state.turns.flatMap((turn, index) =>
		turn.kind === "user" && turn.pending ? [{ turn, index }] : [],
	);
	const match =
		pending.find(({ turn }) => turn.text === text) ?? pending.at(-1);
	if (match) {
		return {
			...state,
			turns: state.turns.map((turn, index) =>
				index === match.index
					? { kind: "user", key: match.turn.key, text, pending: false }
					: turn,
			),
		};
	}
	const [key, seq] = nextKey(state);
	return {
		...state,
		seq,
		turns: [...state.turns, { kind: "user", key, text, pending: false }],
	};
}

function onMessageEnd(
	state: TranscriptState,
	message: PiMessage,
): TranscriptState {
	if (message.role === "user") return onUserEcho(state, message);
	if (message.role !== "assistant") return state;
	const segment = segmentFromMessage(message);
	return withOpenReply(state, (turn) =>
		turn.segments.length === 0
			? { ...turn, segments: [segment] }
			: withLastSegment(turn, () => segment),
	);
}

function settle(state: TranscriptState): TranscriptState {
	const turns: Turn[] = [];
	for (const turn of state.turns) {
		if (turn.kind === "assistant" && !turn.done) {
			turns.push({ ...turn, done: true });
		} else if (turn.kind === "user" && turn.pending) {
			turns.push({ ...turn, pending: false });
			turns.push({
				kind: "assistant",
				key: `${turn.key}-stopped`,
				segments: [ABORTED_SEGMENT],
				done: true,
			});
		} else {
			turns.push(turn);
		}
	}
	return { ...state, turns, phase: "idle", tool: null, retry: null };
}

function onRetryStart(
	state: TranscriptState,
	record: PiRpcRecord,
): TranscriptState {
	const failed = openReply(state);
	const provider = failed?.segments.at(-1)?.provider ?? state.retry?.provider;
	const next = withOpenReply(state, (turn) =>
		replyFailure(turn)
			? { ...turn, segments: turn.segments.slice(0, -1) }
			: turn,
	);
	return {
		...next,
		phase: "retrying",
		tool: null,
		retry: {
			attempt: typeof record.attempt === "number" ? record.attempt : 1,
			maxAttempts:
				typeof record.maxAttempts === "number" ? record.maxAttempts : 1,
			delayMs: typeof record.delayMs === "number" ? record.delayMs : 0,
			errorMessage:
				typeof record.errorMessage === "string" ? record.errorMessage : "",
			provider: provider ?? null,
		},
	};
}

function onRetryEnd(
	state: TranscriptState,
	record: PiRpcRecord,
): TranscriptState {
	const turn = openReply(state);
	if (record.success !== false || (turn && replyFailure(turn))) {
		return { ...state, retry: null };
	}
	const cancelled = record.finalError === "Retry cancelled";
	const segment: ReplySegment = cancelled
		? ABORTED_SEGMENT
		: {
				parts: [],
				stopReason: "error",
				errorMessage: stringOrNull(record.finalError),
				provider: state.retry?.provider ?? null,
			};
	const next = withOpenReply(state, (open) => ({
		...open,
		segments: [...open.segments, segment],
	}));
	return { ...next, retry: null };
}

function onRpc(state: TranscriptState, record: PiRpcRecord): TranscriptState {
	switch (record.type) {
		case "response":
			if (record.command === "abort" && record.success === true) {
				return isRunning(state) || hasPendingUser(state)
					? settle(state)
					: state;
			}
			if (record.command !== "prompt") return state;
			if (record.success === true) {
				return WAITING_PHASES.has(state.phase)
					? { ...state, phase: "thinking" }
					: state;
			}
			if (!hasPendingUser(state)) return state;
			return failSend(state, {
				source: "prompt",
				message: typeof record.error === "string" ? record.error : "",
			});
		case "agent_start":
			return WAITING_PHASES.has(state.phase)
				? { ...state, phase: "thinking" }
				: state;
		case "message_start": {
			const message = asMessage(record.message);
			return message ? onMessageStart(state, message) : state;
		}
		case "message_update": {
			const event = asRecord(record.assistantMessageEvent);
			return event ? onAssistantEvent(state, event) : state;
		}
		case "message_end": {
			const message = asMessage(record.message);
			return message ? onMessageEnd(state, message) : state;
		}
		case "tool_execution_start":
			return typeof record.toolName === "string" && isRunning(state)
				? { ...state, phase: "tool", tool: toolLabel(record.toolName) }
				: state;
		case "tool_execution_end":
			return state.phase === "tool"
				? { ...state, phase: "thinking", tool: null }
				: state;
		case "auto_retry_start":
			return onRetryStart(state, record);
		case "auto_retry_end":
			return onRetryEnd(state, record);
		case "agent_settled":
			return settle(state);
		default:
			return state;
	}
}

function onClientEvent(
	state: TranscriptState,
	event: ClientEvent,
): TranscriptState {
	switch (event.type) {
		case "rpc":
			return event.chatId === state.chatId ? onRpc(state, event.rpc) : state;
		case "status":
			if (event.chatId !== state.chatId || !WAITING_PHASES.has(state.phase)) {
				return state;
			}
			return { ...state, phase: event.state };
		case "helper_error":
			if (event.error.chatId && event.error.chatId !== state.chatId) {
				return state;
			}
			return failSend(state, { source: "helper", error: event.error });
		case "chat_changed":
			return event.chatId === state.chatId
				? state
				: initialTranscript(event.chatId);
		default:
			return state;
	}
}

export function transcriptReducer(
	state: TranscriptState,
	action: TranscriptAction,
): TranscriptState {
	switch (action.type) {
		case "client":
			return onClientEvent(state, action.event);
		case "send": {
			const [key, seq] = nextKey(state);
			return {
				...state,
				seq,
				phase: "sending",
				tool: null,
				retry: null,
				error: null,
				turns: [
					...state.turns,
					{ kind: "user", key, text: action.text, pending: true },
				],
			};
		}
		case "send_failed":
			if (!hasPendingUser(state)) return state;
			return failSend(state, { source: "prompt", message: action.message });
		case "reset":
			return action.chatId === state.chatId
				? state
				: initialTranscript(action.chatId);
		case "loaded":
			return {
				...initialTranscript(action.chatId),
				turns: turnsFromMessages(action.messages),
				seq: state.seq,
			};
		case "restored":
			if (
				action.chatId !== state.chatId ||
				state.turns.length > 0 ||
				state.phase !== "idle"
			) {
				return state;
			}
			return { ...state, turns: turnsFromMessages(action.messages) };
		case "failed":
			return {
				...state,
				error: {
					source: "action",
					title: action.title,
					message: action.message,
				},
			};
	}
}
