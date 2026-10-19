import { describe, expect, test } from "bun:test";
import {
	FORWARDED_RPC_TYPES,
	isChatId,
	isChatStatus,
	isEnvelope,
	isForwardedRpc,
	isForwardedRpcType,
	isHelperCommand,
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

	test.each([
		{ rpc },
		{ chatId: 7, rpc },
		{ chatId: "../../x", rpc },
		{ chatId: "c-01J" },
		{ chatId: "c-01J", rpc: { id: "r1" } },
		{ chatId: "c-01J", rpc: "prompt" },
	])("rejects %p", (value) => {
		expect(isEnvelope(value)).toBe(false);
	});
});

describe("chatId validator", () => {
	test.each([
		"c-01JABCDEF0123456789XYZWVUT",
		"01JABCDEF0123456789XYZWVUT",
		"a",
		"A".repeat(128),
	])("accepts %p", (chatId) => {
		expect(isChatId(chatId)).toBe(true);
	});

	test.each([
		"../../x",
		"--tools=bash",
		"-c01J",
		"a/b",
		"c_01J",
		"c 01J",
		"c.01J",
		"",
		"A".repeat(129),
	])("rejects %p", (chatId) => {
		expect(isChatId(chatId)).toBe(false);
	});

	test("rejects non-strings", () => {
		expect(isChatId(undefined)).toBe(false);
		expect(isChatId(1)).toBe(false);
	});
});

describe("helper wire format", () => {
	const wire = [
		[
			"helper.hello",
			isHelperCommand,
			'{"type":"helper.hello","id":"h1","maxConcurrent":3}',
		],
		["chat.list", isHelperCommand, '{"type":"chat.list","id":"h2"}'],
		[
			"chat.delete",
			isHelperCommand,
			'{"type":"chat.delete","id":"h3","chatId":"c-01J"}',
		],
		[
			"chat.status",
			isChatStatus,
			'{"type":"chat.status","chatId":"c-01J","state":"queued"}',
		],
	] as const;

	test.each(wire)("accepts exact %s JSON", (_name, guard, json) => {
		expect(guard(JSON.parse(json))).toBe(true);
	});

	test.each(
		wire.flatMap(([name, guard, json]) =>
			Object.keys(JSON.parse(json)).map(
				(field) => [name, field, guard, json] as const,
			),
		),
	)("rejects %s JSON without %s", (_name, field, guard, json) => {
		const { [field]: _dropped, ...rest } = JSON.parse(json);
		expect(guard(rest)).toBe(false);
	});

	test.each([
		[
			"zero maxConcurrent",
			isHelperCommand,
			{ type: "helper.hello", id: "h1", maxConcurrent: 0 },
		],
		["bash command", isHelperCommand, { type: "bash", id: "h3" }],
		[
			"chat.delete bad chatId",
			isHelperCommand,
			{ type: "chat.delete", id: "h1", chatId: "../../x" },
		],
		[
			"chat.status bad chatId",
			isChatStatus,
			{ type: "chat.status", chatId: "a/b", state: "queued" },
		],
		[
			"chat.status unknown state",
			isChatStatus,
			{ type: "chat.status", chatId: "c-01J", state: "done" },
		],
	] as const)("rejects %s", (_name, guard, value) => {
		expect(guard(value)).toBe(false);
	});
});
