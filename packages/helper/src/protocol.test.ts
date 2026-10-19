import { describe, expect, test } from "bun:test";
import {
	FORWARDED_RPC_TYPES,
	isEnvelope,
	isForwardedRpc,
	isForwardedRpcType,
} from "./protocol";

describe("forwarded RPC allowlist", () => {
	test.each([...FORWARDED_RPC_TYPES])("accepts %s", (type) => {
		expect(isForwardedRpcType(type)).toBe(true);
		expect(isForwardedRpc({ id: "r1", type })).toBe(true);
	});

	test.each([
		"bash",
		"export_html",
		"fork",
		"clone",
		"switch_session",
		"new_session",
		"unknown_command",
		"",
	])("rejects %p", (type) => {
		expect(isForwardedRpcType(type)).toBe(false);
		expect(isForwardedRpc({ id: "r1", type, command: "ls" })).toBe(false);
	});

	test("rejects non-string and missing types", () => {
		expect(isForwardedRpcType(undefined)).toBe(false);
		expect(isForwardedRpcType(42)).toBe(false);
		expect(isForwardedRpc({ id: "r1" })).toBe(false);
		expect(isForwardedRpc(null)).toBe(false);
		expect(isForwardedRpc("prompt")).toBe(false);
	});
});

describe("envelope guard", () => {
	const rpc = { id: "r1", type: "prompt", message: "hi" };

	test("accepts an envelope with chatId and rpc", () => {
		expect(isEnvelope({ chatId: "c-01J", rpc })).toBe(true);
	});

	test("rejects missing chatId", () => {
		expect(isEnvelope({ rpc })).toBe(false);
	});

	test("rejects empty or non-string chatId", () => {
		expect(isEnvelope({ chatId: "", rpc })).toBe(false);
		expect(isEnvelope({ chatId: 7, rpc })).toBe(false);
	});

	test("rejects missing or malformed rpc", () => {
		expect(isEnvelope({ chatId: "c-01J" })).toBe(false);
		expect(isEnvelope({ chatId: "c-01J", rpc: { id: "r1" } })).toBe(false);
		expect(isEnvelope({ chatId: "c-01J", rpc: "prompt" })).toBe(false);
	});
});
