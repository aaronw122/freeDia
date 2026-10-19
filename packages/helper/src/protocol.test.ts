import { describe, expect, test } from "bun:test";
import {
	type ChatDeleteRequest,
	type ChatDeleteResponse,
	type ChatListRequest,
	type ChatListResponse,
	type ChatStatus,
	FORWARDED_RPC_TYPES,
	type HelperError,
	type HelperHelloRequest,
	type HelperHelloResponse,
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

	test("rejects missing chatId", () => {
		expect(isEnvelope({ rpc })).toBe(false);
	});

	test("rejects invalid chatId", () => {
		expect(isEnvelope({ chatId: "", rpc })).toBe(false);
		expect(isEnvelope({ chatId: 7, rpc })).toBe(false);
		expect(isEnvelope({ chatId: "../../x", rpc })).toBe(false);
		expect(isEnvelope({ chatId: "--tools=bash", rpc })).toBe(false);
	});

	test("rejects missing or malformed rpc", () => {
		expect(isEnvelope({ chatId: "c-01J" })).toBe(false);
		expect(isEnvelope({ chatId: "c-01J", rpc: { id: "r1" } })).toBe(false);
		expect(isEnvelope({ chatId: "c-01J", rpc: "prompt" })).toBe(false);
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

	test("guards chat.delete and chat.status chatIds", () => {
		expect(
			isHelperCommand({ type: "chat.delete", id: "h1", chatId: "c-01J" }),
		).toBe(true);
		expect(
			isHelperCommand({ type: "chat.delete", id: "h1", chatId: "../../x" }),
		).toBe(false);
		expect(
			isChatStatus({ type: "chat.status", chatId: "c-01J", state: "queued" }),
		).toBe(true);
		expect(
			isChatStatus({ type: "chat.status", chatId: "a/b", state: "queued" }),
		).toBe(false);
	});
});

describe("helper command guard", () => {
	test("accepts helper commands", () => {
		expect(
			isHelperCommand({ type: "helper.hello", id: "h1", maxConcurrent: 3 }),
		).toBe(true);
		expect(isHelperCommand({ type: "chat.list", id: "h2" })).toBe(true);
	});

	test("rejects malformed helper commands", () => {
		expect(isHelperCommand({ type: "helper.hello", id: "h1" })).toBe(false);
		expect(
			isHelperCommand({ type: "helper.hello", id: "h1", maxConcurrent: 0 }),
		).toBe(false);
		expect(isHelperCommand({ type: "chat.list" })).toBe(false);
		expect(isHelperCommand({ type: "bash", id: "h3" })).toBe(false);
	});

	test("rejects chat.status with an unknown state", () => {
		expect(
			isChatStatus({ type: "chat.status", chatId: "c-01J", state: "done" }),
		).toBe(false);
	});
});

describe("helper command wire format", () => {
	test("helper.hello", () => {
		const request: HelperHelloRequest = {
			type: "helper.hello",
			id: "h1",
			maxConcurrent: 3,
		};
		const reply: HelperHelloResponse = {
			type: "helper.hello",
			id: "h1",
			helperVersion: "0.1.0",
			piVersion: "1.3.0",
		};
		expect(JSON.stringify(request)).toBe(
			'{"type":"helper.hello","id":"h1","maxConcurrent":3}',
		);
		expect(JSON.stringify(reply)).toBe(
			'{"type":"helper.hello","id":"h1","helperVersion":"0.1.0","piVersion":"1.3.0"}',
		);
	});

	test("chat.list", () => {
		const request: ChatListRequest = { type: "chat.list", id: "h2" };
		const reply: ChatListResponse = {
			type: "chat.list",
			id: "h2",
			chats: [
				{
					chatId: "c-01J",
					title: "Pricing page",
					updatedAt: "2026-10-19T18:53:00.000Z",
				},
			],
		};
		expect(JSON.stringify(request)).toBe('{"type":"chat.list","id":"h2"}');
		expect(JSON.stringify(reply)).toBe(
			'{"type":"chat.list","id":"h2","chats":[{"chatId":"c-01J","title":"Pricing page","updatedAt":"2026-10-19T18:53:00.000Z"}]}',
		);
	});

	test("chat.delete", () => {
		const request: ChatDeleteRequest = {
			type: "chat.delete",
			id: "h3",
			chatId: "c-01J",
		};
		const reply: ChatDeleteResponse = {
			type: "chat.delete",
			id: "h3",
			chatId: "c-01J",
		};
		expect(JSON.stringify(request)).toBe(
			'{"type":"chat.delete","id":"h3","chatId":"c-01J"}',
		);
		expect(JSON.stringify(reply)).toBe(
			'{"type":"chat.delete","id":"h3","chatId":"c-01J"}',
		);
	});

	test("chat.status", () => {
		const push: ChatStatus = {
			type: "chat.status",
			chatId: "c-01J",
			state: "queued",
		};
		expect(JSON.stringify(push)).toBe(
			'{"type":"chat.status","chatId":"c-01J","state":"queued"}',
		);
	});

	test("helper.error", () => {
		const reply: HelperError = {
			id: "h1",
			type: "helper.error",
			chatId: "c-01J",
			code: "not_signed_in",
			message: "pi is not signed in to anthropic",
			fix: "Run: freedia login",
		};
		const push: HelperError = {
			type: "helper.error",
			code: "pi_missing",
			message: "pi is not installed",
			fix: "Run: bunx freedia install",
		};
		expect(JSON.stringify(reply)).toBe(
			'{"id":"h1","type":"helper.error","chatId":"c-01J","code":"not_signed_in","message":"pi is not signed in to anthropic","fix":"Run: freedia login"}',
		);
		expect(JSON.stringify(push)).toBe(
			'{"type":"helper.error","code":"pi_missing","message":"pi is not installed","fix":"Run: bunx freedia install"}',
		);
	});
});
