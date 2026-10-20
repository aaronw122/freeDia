import type { PiRpcRecord } from "freedia/protocol";
import abortText from "../../../../helper/test/fixtures/pi/abort.jsonl?raw";
import notSignedInText from "../../../../helper/test/fixtures/pi/not-signed-in-anthropic.jsonl?raw";
import rejectedText from "../../../../helper/test/fixtures/pi/provider-rejected-401.jsonl?raw";
import rateLimitText from "../../../../helper/test/fixtures/pi/rate-limit.jsonl?raw";
import streamText from "../../../../helper/test/fixtures/pi/stream.jsonl?raw";
import toolsText from "../../../../helper/test/fixtures/pi/tools-readonly.jsonl?raw";
import { asRecord, messageRole, type UnknownRecord } from "../records";

export interface FixtureLine {
	t: number;
	dir: string;
	record: PiRpcRecord;
}

export type FixtureName =
	| "stream"
	| "abort"
	| "not-signed-in-anthropic"
	| "provider-rejected-401"
	| "rate-limit"
	| "tools-readonly";

const FIXTURE_TEXT: Record<FixtureName, string> = {
	stream: streamText,
	abort: abortText,
	"not-signed-in-anthropic": notSignedInText,
	"provider-rejected-401": rejectedText,
	"rate-limit": rateLimitText,
	"tools-readonly": toolsText,
};

function parseLine(text: string): FixtureLine {
	const line = asRecord(JSON.parse(text));
	const record = asRecord(line?.record);
	if (!line || typeof line.t !== "number" || typeof line.dir !== "string") {
		throw new Error(`bad fixture line: ${text.slice(0, 80)}`);
	}
	if (record && typeof record.type === "string") {
		return {
			t: line.t,
			dir: line.dir,
			record: { ...record, type: record.type },
		};
	}
	return { t: line.t, dir: line.dir, record: { type: "" } };
}

export function fixtureLines(name: FixtureName): FixtureLine[] {
	return FIXTURE_TEXT[name]
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map(parseLine);
}

export interface TimedRecord {
	t: number;
	record: PiRpcRecord;
}

export function promptRun(name: FixtureName, nth = 0): TimedRecord[] {
	const lines = fixtureLines(name);
	const prompt = lines.filter(
		(line) => line.dir === "stdin" && line.record.type === "prompt",
	)[nth];
	if (!prompt) throw new Error(`fixture ${name} has no prompt #${nth}`);
	const run: TimedRecord[] = [];
	for (const line of lines.slice(lines.indexOf(prompt) + 1)) {
		if (line.dir !== "stdout") continue;
		if (
			line.record.type === "response" &&
			line.record.id !== prompt.record.id
		) {
			continue;
		}
		run.push({ t: line.t - prompt.t, record: line.record });
		if (
			line.record.type === "agent_settled" ||
			(line.record.type === "response" && line.record.success === false)
		) {
			break;
		}
	}
	return run;
}

export function responseData(
	name: FixtureName,
	command: string,
): UnknownRecord {
	const line = fixtureLines(name).find(
		(entry) =>
			entry.dir === "stdout" &&
			entry.record.type === "response" &&
			entry.record.command === command &&
			entry.record.success === true,
	);
	const data = asRecord(line?.record.data);
	if (!data) throw new Error(`fixture ${name} has no ${command} response`);
	return data;
}

function withMessageText(record: PiRpcRecord, text: string): PiRpcRecord {
	return {
		...record,
		message: { ...asRecord(record.message), content: [{ type: "text", text }] },
	};
}

export function retextRun(
	run: TimedRecord[],
	prompt: string,
	reply: string,
	{ chunkSize = 16, stepMs = 30 } = {},
): TimedRecord[] {
	const result: TimedRecord[] = [];
	let shift = 0;
	for (const { t, record } of run) {
		const at = t + shift;
		const role = messageRole(record);
		const event = asRecord(record.assistantMessageEvent);
		if (
			(record.type === "message_start" || record.type === "message_end") &&
			role === "user"
		) {
			result.push({ t: at, record: withMessageText(record, prompt) });
		} else if (event?.type === "text_start") {
			result.push({ t: at, record });
			for (let i = 0; i < reply.length; i += chunkSize) {
				shift += stepMs;
				result.push({
					t: t + shift,
					record: {
						...record,
						assistantMessageEvent: {
							type: "text_delta",
							contentIndex: event.contentIndex,
							delta: reply.slice(i, i + chunkSize),
						},
					},
				});
			}
		} else if (event?.type === "text_delta") {
		} else if (event?.type === "text_end") {
			result.push({
				t: at,
				record: {
					...record,
					assistantMessageEvent: { ...event, content: reply },
				},
			});
		} else if (
			(record.type === "message_end" || record.type === "turn_end") &&
			role === "assistant"
		) {
			result.push({ t: at, record: withMessageText(record, reply) });
		} else {
			result.push({ t: at, record });
		}
	}
	return result;
}
