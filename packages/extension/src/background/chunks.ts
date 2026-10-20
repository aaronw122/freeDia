export interface HelperChunk {
	type: "helper.chunk";
	chatId?: string;
	chunkId: string;
	index: number;
	count: number;
	data: string;
}

export function isHelperChunk(value: unknown): value is HelperChunk {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const v = value as Record<string, unknown>;
	return (
		v.type === "helper.chunk" &&
		typeof v.chunkId === "string" &&
		Number.isInteger(v.index) &&
		Number.isInteger(v.count) &&
		(v.count as number) > 0 &&
		typeof v.data === "string"
	);
}

interface Pending {
	count: number;
	parts: (Uint8Array | undefined)[];
	received: number;
}

function decodeBase64(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export class ChunkAssembler {
	private readonly pending = new Map<string, Pending>();

	accept(chunk: HelperChunk): unknown | undefined {
		let entry = this.pending.get(chunk.chunkId);
		if (entry === undefined) {
			entry = { count: chunk.count, parts: [], received: 0 };
			this.pending.set(chunk.chunkId, entry);
		}
		if (
			chunk.count !== entry.count ||
			chunk.index < 0 ||
			chunk.index >= entry.count ||
			entry.parts[chunk.index] !== undefined
		) {
			return undefined;
		}
		entry.parts[chunk.index] = decodeBase64(chunk.data);
		entry.received++;
		if (entry.received < entry.count) {
			return undefined;
		}
		this.pending.delete(chunk.chunkId);
		const total = entry.parts.reduce(
			(sum, part) => sum + (part?.length ?? 0),
			0,
		);
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const part of entry.parts) {
			if (part !== undefined) {
				bytes.set(part, offset);
				offset += part.length;
			}
		}
		return JSON.parse(new TextDecoder().decode(bytes));
	}

	clear(): void {
		this.pending.clear();
	}
}
