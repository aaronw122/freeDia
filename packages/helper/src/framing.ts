import {
	CHUNK_SLICE_BYTES,
	type HelperChunk,
	type HelperToExtension,
	MAX_HOST_MESSAGE_BYTES,
} from "./protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function frame(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(4 + payload.byteLength);
	new DataView(out.buffer).setUint32(0, payload.byteLength, true);
	out.set(payload, 4);
	return out;
}

export function encodeMessage(message: HelperToExtension): Uint8Array[] {
	return encodeJson(
		JSON.stringify(message),
		"chatId" in message ? message.chatId : undefined,
	);
}

export function encodeJson(json: string, chatId?: string): Uint8Array[] {
	const bytes = encoder.encode(json);
	if (bytes.byteLength <= MAX_HOST_MESSAGE_BYTES) {
		return [frame(bytes)];
	}
	const chunkId = crypto.randomUUID();
	const count = Math.ceil(bytes.byteLength / CHUNK_SLICE_BYTES);
	const frames: Uint8Array[] = [];
	for (let index = 0; index < count; index++) {
		const slice = bytes.subarray(
			index * CHUNK_SLICE_BYTES,
			(index + 1) * CHUNK_SLICE_BYTES,
		);
		const chunk: HelperChunk = {
			type: "helper.chunk",
			...(chatId === undefined ? {} : { chatId }),
			chunkId,
			index,
			count,
			data: slice.toBase64(),
		};
		frames.push(frame(encoder.encode(JSON.stringify(chunk))));
	}
	return frames;
}

export class FrameDecoder {
	private buffer = new Uint8Array(0);

	push(bytes: Uint8Array): unknown[] {
		const merged = new Uint8Array(this.buffer.byteLength + bytes.byteLength);
		merged.set(this.buffer, 0);
		merged.set(bytes, this.buffer.byteLength);
		const messages: unknown[] = [];
		let offset = 0;
		while (merged.byteLength - offset >= 4) {
			const length = new DataView(
				merged.buffer,
				merged.byteOffset + offset,
				4,
			).getUint32(0, true);
			if (merged.byteLength - offset - 4 < length) {
				break;
			}
			const body = merged.subarray(offset + 4, offset + 4 + length);
			offset += 4 + length;
			messages.push(parseJson(decoder.decode(body)));
		}
		this.buffer = merged.slice(offset);
		return messages;
	}

	get pending(): number {
		return this.buffer.byteLength;
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function splitLines(onLine: (line: string) => void) {
	let rest = "";
	const textDecoder = new TextDecoder();
	return {
		push(bytes: Uint8Array) {
			rest += textDecoder.decode(bytes, { stream: true });
			let index = rest.indexOf("\n");
			while (index >= 0) {
				const line = rest.slice(0, index);
				rest = rest.slice(index + 1);
				if (line.trim() !== "") {
					onLine(line);
				}
				index = rest.indexOf("\n");
			}
		},
		end() {
			rest += textDecoder.decode();
			if (rest.trim() !== "") {
				onLine(rest);
			}
			rest = "";
		},
	};
}
