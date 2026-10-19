import { expect, test } from "bun:test";
import { isEnvelope } from "freedia/protocol";
import { toEnvelope } from "./envelope";

test("wraps a forwarded rpc in a chat envelope", () => {
	const envelope = toEnvelope("c-01J", { id: "r1", type: "abort" });
	expect(envelope).toEqual({
		chatId: "c-01J",
		rpc: { id: "r1", type: "abort" },
	});
	expect(isEnvelope(envelope)).toBe(true);
});
