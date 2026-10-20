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
	| "retrying";

export interface UserTurn {
	kind: "user";
	key: string;
	text: string;
	pending: boolean;
}

export interface AssistantTurn {
	kind: "assistant";
	key: string;
	parts: string[];
	done: boolean;
	stopReason: string | null;
	errorMessage: string | null;
	provider: string | null;
}

export type Turn = UserTurn | AssistantTurn;

export interface RetryInfo {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

export type ChatError =
	| { source: "helper"; error: HelperError }
	| { source: "prompt"; message: string }
	| { source: "action"; title: string; message: string };

export interface TranscriptState {
	chatId: string;
	turns: Turn[];
	phase: RunPhase;
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
	| { type: "failed"; title: string; message: string };

const WAITING_PHASES: ReadonlySet<RunPhase> = new Set([
	"sending",
	"starting",
	"queued",
]);

export function initialTranscript(chatId: string): TranscriptState {
	return {
		chatId,
		turns: [],
		phase: "idle",
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
	return turn.parts.join("");
}

export function questionFromPrompt(text: string): string {
	const heading = /^## Question[ \t]*$/m;
	const lines = text.split("\n");
	let index = -1;
	lines.forEach((line, i) => {
		if (heading.test(line)) index = i;
	});
	if (index === -1) return text.trim();
	return lines
		.slice(index + 1)
		.join("\n")
		.trim();
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

function assistantFromMessage(message: PiMessage, key: string): AssistantTurn {
	return {
		kind: "assistant",
		key,
		parts: textParts(message.content),
		done: true,
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
		const key = `m${index}`;
		if (message.role === "user") {
			turns.push({
				kind: "user",
				key,
				text: questionFromPrompt(textParts(message.content).join("")),
				pending: false,
			});
		} else if (message.role === "assistant") {
			turns.push(assistantFromMessage(message, key));
		}
	});
	return turns;
}

function lastAssistantIndex(turns: Turn[]): number {
	for (let i = turns.length - 1; i >= 0; i--) {
		if (turns[i]?.kind === "assistant") return i;
	}
	return -1;
}

function replaceAt(turns: Turn[], index: number, turn: Turn): Turn[] {
	return turns.map((existing, i) => (i === index ? turn : existing));
}

function streamingAssistant(state: TranscriptState): AssistantTurn | null {
	const last = state.turns.at(-1);
	return last?.kind === "assistant" && !last.done ? last : null;
}

function nextKey(state: TranscriptState): [string, number] {
	return [`t${state.seq}`, state.seq + 1];
}

function dropPendingUser(
	state: TranscriptState,
): [Turn[], { text: string; seq: number } | null] {
	const index = state.turns.findLastIndex(
		(turn) => turn.kind === "user" && turn.pending,
	);
	const pending = state.turns[index];
	if (index === -1 || pending?.kind !== "user") return [state.turns, null];
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
		retry: null,
		error,
		draft: draft ?? state.draft,
		seq: state.seq + 1,
	};
}

function onAssistantEvent(
	state: TranscriptState,
	event: Record<string, unknown>,
): TranscriptState {
	const turn = streamingAssistant(state);
	if (!turn) return state;
	const index = typeof event.contentIndex === "number" ? event.contentIndex : 0;
	const parts = [...turn.parts];
	while (parts.length <= index) parts.push("");
	if (event.type === "text_delta" && typeof event.delta === "string") {
		parts[index] = `${parts[index] ?? ""}${event.delta}`;
		const firstText =
			event.delta.length > 0 &&
			(state.phase === "thinking" || state.phase === "retrying");
		return {
			...state,
			phase: firstText ? "streaming" : state.phase,
			retry: firstText ? null : state.retry,
			turns: replaceAt(state.turns, state.turns.length - 1, {
				...turn,
				parts,
			}),
		};
	}
	if (event.type === "text_end" && typeof event.content === "string") {
		parts[index] = event.content;
		return {
			...state,
			turns: replaceAt(state.turns, state.turns.length - 1, {
				...turn,
				parts,
			}),
		};
	}
	return state;
}

function onMessageStart(
	state: TranscriptState,
	message: PiMessage,
): TranscriptState {
	if (message.role !== "assistant") return state;
	const [key, seq] = nextKey(state);
	const turn: AssistantTurn = {
		kind: "assistant",
		key,
		parts: [],
		done: false,
		stopReason: null,
		errorMessage: null,
		provider: stringOrNull(message.provider),
	};
	return {
		...state,
		seq,
		phase: state.phase === "retrying" ? "retrying" : "thinking",
		turns: [...state.turns, turn],
	};
}

function onMessageEnd(
	state: TranscriptState,
	message: PiMessage,
): TranscriptState {
	if (message.role === "user") {
		const text = questionFromPrompt(textParts(message.content).join(""));
		const index = state.turns.findIndex(
			(turn) => turn.kind === "user" && turn.pending,
		);
		const existing = state.turns[index];
		if (index !== -1 && existing) {
			return {
				...state,
				turns: replaceAt(state.turns, index, {
					kind: "user",
					key: existing.key,
					text,
					pending: false,
				}),
			};
		}
		const [key, seq] = nextKey(state);
		return {
			...state,
			seq,
			turns: [...state.turns, { kind: "user", key, text, pending: false }],
		};
	}
	if (message.role !== "assistant") return state;
	const current = streamingAssistant(state);
	if (current) {
		return {
			...state,
			turns: replaceAt(
				state.turns,
				state.turns.length - 1,
				assistantFromMessage(message, current.key),
			),
		};
	}
	const [key, seq] = nextKey(state);
	return {
		...state,
		seq,
		turns: [...state.turns, assistantFromMessage(message, key)],
	};
}

function settle(state: TranscriptState): TranscriptState {
	const turns = state.turns.map((turn) =>
		turn.kind === "assistant" && !turn.done ? { ...turn, done: true } : turn,
	);
	return { ...state, turns, phase: "idle", retry: null };
}

function onRetryStart(
	state: TranscriptState,
	record: PiRpcRecord,
): TranscriptState {
	const index = lastAssistantIndex(state.turns);
	const last = state.turns[index];
	const turns =
		last?.kind === "assistant" && last.stopReason === "error"
			? state.turns.filter((_, i) => i !== index)
			: state.turns;
	return {
		...state,
		turns,
		phase: "retrying",
		retry: {
			attempt: typeof record.attempt === "number" ? record.attempt : 1,
			maxAttempts:
				typeof record.maxAttempts === "number" ? record.maxAttempts : 1,
			delayMs: typeof record.delayMs === "number" ? record.delayMs : 0,
			errorMessage:
				typeof record.errorMessage === "string" ? record.errorMessage : "",
		},
	};
}

function onRetryEnd(
	state: TranscriptState,
	record: PiRpcRecord,
): TranscriptState {
	const last = state.turns.at(-1);
	const needsTurn =
		record.success === false &&
		!(last?.kind === "assistant" && last.stopReason === "error");
	if (!needsTurn) return { ...state, retry: null };
	const cancelled = record.finalError === "Retry cancelled";
	const [key, seq] = nextKey(state);
	const turn: AssistantTurn = {
		kind: "assistant",
		key,
		parts: [],
		done: true,
		stopReason: cancelled ? "aborted" : "error",
		errorMessage: cancelled ? null : stringOrNull(record.finalError),
		provider: null,
	};
	return { ...state, seq, retry: null, turns: [...state.turns, turn] };
}

function onRpc(state: TranscriptState, record: PiRpcRecord): TranscriptState {
	switch (record.type) {
		case "response": {
			if (record.command !== "prompt") return state;
			if (record.success === true) {
				return WAITING_PHASES.has(state.phase)
					? { ...state, phase: "thinking" }
					: state;
			}
			if (!state.turns.some((turn) => turn.kind === "user" && turn.pending)) {
				return state;
			}
			return failSend(state, {
				source: "prompt",
				message: typeof record.error === "string" ? record.error : "",
			});
		}
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
				retry: null,
				error: null,
				turns: [
					...state.turns,
					{ kind: "user", key, text: action.text, pending: true },
				],
			};
		}
		case "send_failed":
			if (!state.turns.some((turn) => turn.kind === "user" && turn.pending)) {
				return state;
			}
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
