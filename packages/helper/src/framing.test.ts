import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	encodeJson,
	encodeMessage,
	FrameDecoder,
	frame,
	isOversizedFrame,
	splitLines,
} from "./framing";
import {
	CHUNK_SLICE_BYTES,
	type HelperChunk,
	isHelperChunk,
	MAX_HOST_MESSAGE_BYTES,
} from "./protocol";

const CHAT_ID = "3f2a9c1e-8b4d-4e6f-a0b1-c2d3e4f5a6b7";

function concat(frames: Uint8Array[]): Uint8Array {
	const total = frames.reduce((sum, part) => sum + part.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of frames) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function reassemble(chunks: HelperChunk[]): unknown {
	const bytes = concat(
		chunks.map((chunk) => Uint8Array.fromBase64(chunk.data)),
	);
	return JSON.parse(new TextDecoder().decode(bytes));
}

describe("native messaging framing", () => {
	test("prefixes the UTF-8 length as 4-byte little-endian", () => {
		const framed = frame(new TextEncoder().encode('{"a":"é"}'));
		expect([...framed.subarray(0, 4)]).toEqual([10, 0, 0, 0]);
		expect(new TextDecoder().decode(framed.subarray(4))).toBe('{"a":"é"}');
	});

	test("round-trips messages split at arbitrary byte boundaries", () => {
		const messages = [
			{ type: "helper.hello", id: "h1", maxConcurrent: 3 },
			{
				chatId: CHAT_ID,
				rpc: { id: "r1", type: "prompt", message: "ünïcödé 🚀" },
			},
			{ type: "chat.list", id: "h2" },
		];
		const wire = concat(
			messages.flatMap((message) => encodeMessage(message as never)),
		);
		for (const step of [1, 3, 7, wire.byteLength]) {
			const decoder = new FrameDecoder();
			const decoded: unknown[] = [];
			for (let offset = 0; offset < wire.byteLength; offset += step) {
				decoded.push(...decoder.push(wire.subarray(offset, offset + step)));
			}
			expect(decoded).toEqual(messages);
			expect(decoder.pending).toBe(0);
		}
	});

	test("decodes a frame body that is not JSON as undefined and keeps going", () => {
		const decoder = new FrameDecoder();
		const wire = concat([
			frame(new TextEncoder().encode("{nope")),
			...encodeMessage({ type: "chat.list", id: "h1" } as never),
		]);
		expect(decoder.push(wire)).toEqual([
			undefined,
			{ type: "chat.list", id: "h1" },
		]);
	});

	test("splits pi stdout only on LF, keeping U+2028 inside records", () => {
		const lines: string[] = [];
		const splitter = splitLines((line) => lines.push(line));
		const text = '{"a":"x y"}\n{"b":1}\n{"c"';
		const bytes = new TextEncoder().encode(text);
		splitter.push(bytes.subarray(0, 5));
		splitter.push(bytes.subarray(5));
		splitter.push(new TextEncoder().encode(":2}\n"));
		splitter.end();
		expect(lines).toEqual(['{"a":"x y"}', '{"b":1}', '{"c":2}']);
	});
});

describe("extension → host size limit", () => {
	test("an oversized frame is reported and skipped without buffering; later frames still decode", () => {
		const decoder = new FrameDecoder(64);
		const big = frame(new TextEncoder().encode(`"${"x".repeat(98)}"`));
		const small = encodeMessage({
			type: "chat.list",
			id: "h1",
		} as never)[0] as Uint8Array;
		const out = [
			...decoder.push(big.subarray(0, 10)),
			...decoder.push(big.subarray(10, 60)),
		];
		expect(out).toEqual([{ oversized: 100 }]);
		expect(out.every((item) => isOversizedFrame(item))).toBe(true);
		expect(decoder.pending).toBe(44);
		const tail = concat([big.subarray(60), small]);
		expect(decoder.push(tail)).toEqual([{ type: "chat.list", id: "h1" }]);
		expect(decoder.pending).toBe(0);
	});
});

describe("host → extension size limit", () => {
	test("a message under 1 MB is sent as one plain frame", () => {
		const message = {
			chatId: CHAT_ID,
			rpc: { type: "text", text: "x".repeat(900_000) },
		};
		const frames = encodeMessage(message as never);
		expect(frames).toHaveLength(1);
		expect(new FrameDecoder().push(frames[0] as Uint8Array)).toEqual([message]);
	});

	test("a ~3 MB get_messages response comes out as ordered chunks ≤ 1 MB that reassemble exactly", () => {
		const stream = readFileSync(
			join(import.meta.dir, "..", "test", "fixtures", "pi", "stream.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).record)
			.find((record) => record.command === "get_messages");
		const messages = Array.from({ length: 60 }, (_, index) => ({
			...stream.data.messages[2],
			content: [
				{
					type: "text",
					text: `${index} "quoted" \\ ünï ${"lorem ".repeat(8000)}`,
				},
			],
		}));
		const rpc = { ...stream, data: { messages } };
		const rpcJson = JSON.stringify(rpc);
		const original = JSON.parse(`{"chatId":"${CHAT_ID}","rpc":${rpcJson}}`);
		const frames = encodeJson(
			`{"chatId":"${CHAT_ID}","rpc":${rpcJson}}`,
			CHAT_ID,
		);
		const totalBytes = new TextEncoder().encode(
			JSON.stringify(original),
		).byteLength;
		expect(totalBytes).toBeGreaterThan(2_900_000);
		expect(frames.length).toBe(Math.ceil(totalBytes / CHUNK_SLICE_BYTES));
		for (const framed of frames) {
			expect(framed.byteLength - 4).toBeLessThanOrEqual(MAX_HOST_MESSAGE_BYTES);
		}
		const decoder = new FrameDecoder();
		const chunks = frames.flatMap((framed) =>
			decoder.push(framed),
		) as HelperChunk[];
		expect(chunks.every(isHelperChunk)).toBe(true);
		expect(chunks.map((chunk) => chunk.index)).toEqual(
			chunks.map((_, index) => index),
		);
		expect(new Set(chunks.map((chunk) => chunk.chunkId)).size).toBe(1);
		expect(chunks.every((chunk) => chunk.count === chunks.length)).toBe(true);
		expect(chunks.every((chunk) => chunk.chatId === CHAT_ID)).toBe(true);
		expect(reassemble(chunks)).toEqual(original);
	});

	test("a chunked message without chatId carries no chatId", () => {
		const message = {
			type: "chat.list",
			id: "h1",
			chats: Array.from({ length: 20_000 }, (_, index) => ({
				chatId: CHAT_ID,
				title: `chat ${index} with a fairly long title`,
				updatedAt: "2026-10-20T00:00:00.000Z",
			})),
		};
		const decoder = new FrameDecoder();
		const chunks = encodeMessage(message as never).flatMap((framed) =>
			decoder.push(framed),
		) as HelperChunk[];
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => !("chatId" in chunk))).toBe(true);
		expect(reassemble(chunks)).toEqual(message);
	});
});
