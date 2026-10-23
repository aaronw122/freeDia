import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FreediaPaths } from "./paths";
import { type ChatSummary, isChatId } from "./protocol";

export const TITLE_WORDS = 8;

interface SessionEntry {
	type?: unknown;
	id?: unknown;
	timestamp?: unknown;
	name?: unknown;
	title?: unknown;
	provider?: unknown;
	modelId?: unknown;
	message?: {
		role?: unknown;
		content?: unknown;
		provider?: unknown;
		model?: unknown;
	};
}

export function sessionFiles(paths: FreediaPaths, chatId: string): string[] {
	const directory = join(paths.chats, chatId);
	if (!existsSync(directory)) return [];
	return readdirSync(directory)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(directory, name));
}

function readEntries(file: string): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim() === "") {
			continue;
		}
		try {
			entries.push(JSON.parse(line));
		} catch {}
	}
	return entries;
}

export function messageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((part) =>
			typeof part === "object" &&
			part !== null &&
			part.type === "text" &&
			typeof part.text === "string"
				? part.text
				: "",
		)
		.join("");
}

export function cutWords(text: string, max = TITLE_WORDS): string {
	return text
		.split(/\s+/)
		.filter((word) => word !== "")
		.slice(0, max)
		.join(" ");
}

export function questionOf(prompt: string): string {
	const match = /^## Question[ \t]*\r?\n([\s\S]*)$/m.exec(prompt);
	return (match ? match[1] : prompt)?.trim() ?? "";
}

export function pageTitleOf(prompt: string): string {
	const match = /^Title:[ \t]*(.*)$/m.exec(prompt);
	return match?.[1]?.trim() ?? "";
}

export function firstQuestion(entries: SessionEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "user") {
			return messageText(entry.message.content);
		}
	}
	return undefined;
}

export interface SessionState {
	id: unknown;
	headerTimestamp: string | undefined;
	name: string | undefined;
	updatedAt: string | undefined;
	model: string | undefined;
	userMessages: number;
	firstReplyTurn: number | undefined;
	firstPrompt: string | undefined;
}

export function readSession(file: string): SessionState {
	const entries = readEntries(file);
	const header = entries[0];
	let name: string | undefined =
		typeof header?.title === "string" ? header.title : undefined;
	let updatedAt: string | undefined;
	let model: string | undefined;
	let userMessages = 0;
	let firstReplyTurn: number | undefined;
	for (const entry of entries) {
		if (
			(entry.type === "session_info" || entry.type === "title") &&
			typeof entry.name === "string"
		) {
			name = entry.name;
		}
		if (
			entry.type === "model_change" &&
			typeof entry.provider === "string" &&
			typeof entry.modelId === "string"
		) {
			model = `${entry.provider}/${entry.modelId}`;
		}
		if (entry.type === "message") {
			if (typeof entry.timestamp === "string") {
				updatedAt = entry.timestamp;
			}
			const message = entry.message;
			if (message?.role === "user") {
				userMessages++;
			}
			if (message?.role === "assistant") {
				if (
					firstReplyTurn === undefined &&
					messageText(message.content).trim() !== ""
				) {
					firstReplyTurn = userMessages;
				}
				if (
					typeof message.provider === "string" &&
					typeof message.model === "string"
				) {
					model = `${message.provider}/${message.model}`;
				}
			}
		}
	}
	return {
		id: header?.type === "session" ? header.id : undefined,
		headerTimestamp:
			typeof header?.timestamp === "string" ? header.timestamp : undefined,
		name,
		updatedAt,
		model,
		userMessages,
		firstReplyTurn,
		firstPrompt: firstQuestion(entries),
	};
}

export function chatSessionState(
	paths: FreediaPaths,
	chatId: string,
): SessionState | undefined {
	const file = sessionFiles(paths, chatId).sort().at(-1);
	return file === undefined ? undefined : readSession(file);
}

export function listChats(paths: FreediaPaths): ChatSummary[] {
	if (!existsSync(paths.chats)) {
		return [];
	}
	const chats: ChatSummary[] = [];
	for (const chatId of readdirSync(paths.chats).sort()) {
		if (!isChatId(chatId)) continue;
		const session = chatSessionState(paths, chatId);
		if (session === undefined || session.firstPrompt === undefined) continue;
		chats.push({
			chatId,
			title: session.name ?? cutWords(questionOf(session.firstPrompt)),
			updatedAt: session.updatedAt ?? session.headerTimestamp ?? "",
		});
	}
	return [...chats.values()].sort((a, b) =>
		b.updatedAt.localeCompare(a.updatedAt),
	);
}

export function deleteSessionFiles(paths: FreediaPaths, chatId: string): void {
	rmSync(join(paths.chats, chatId), { recursive: true, force: true });
}
