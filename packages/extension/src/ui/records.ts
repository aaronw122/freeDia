export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: null;
}

export function messageRole(record: UnknownRecord): unknown {
	return asRecord(record.message)?.role;
}
