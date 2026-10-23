import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { INTERNAL_PREFIX } from "../src/helper";
import { freediaPaths } from "../src/paths";
import {
	CHAT_A,
	CHAT_B,
	CHAT_C,
	installFakeOmp,
	type Sent,
	TestHelper,
	tempHome,
} from "./harness";

const FAUX = "--offline --model faux/faux-1";
const homes: string[] = [];

function helper(options: ConstructorParameters<typeof TestHelper>[0] = {}) {
	const h = new TestHelper({
		...options,
		env: { FREEDIA_OMP_EXTRA_ARGS: FAUX, ...options.env },
		fake: { title: null, ...options.fake },
	});
	homes.push(h.home);
	return h;
}

afterEach(() => {
	for (const home of homes.splice(0)) {
		rmSync(home, { recursive: true, force: true });
	}
});

function prompt(id: string, question: string) {
	return {
		id,
		type: "prompt",
		message: `URL: https://example.com\nTitle: Example\n\n## Question\n${question}`,
	};
}

function deferred() {
	let resolve: () => void = () => {};
	let reject: (error: Error) => void = () => {};
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const statuses = (sent: Sent[]) =>
	sent
		.filter((message) => message.type === "chat.status")
		.map((message) => [message.chatId, message.state]);

describe("pi follows the helper's pin", () => {
	test("a different installed pi is replaced before any chat spawns; prompts wait as starting", async () => {
		const install = deferred();
		const installs: string[] = [];
		const home = tempHome();
		const h = helper({
			home,
			ompVersion: "18.12.0",
			helper: {
				installOmp: async (version) => {
					installs.push(version);
					await install.promise;
					installFakeOmp(freediaPaths(home), version);
				},
			},
		});
		const sending = h.rpc(CHAT_A, prompt("r1", "hello"));
		expect(statuses(h.sent)).toEqual([[CHAT_A, "starting"]]);
		expect(installs).toEqual(["18.12.1"]);
		expect(h.spawns()).toHaveLength(0);
		install.resolve();
		await sending;
		await h.waitForRpc(CHAT_A, (rpc) => rpc.type === "session_settled", "ran");
		expect(h.chatSpawns(CHAT_A)).toHaveLength(1);
		expect(installs).toEqual(["18.12.1"]);
	});

	test("a failed pi install answers spawn_failed pointing to doctor and frees the slot", async () => {
		const h = helper({
			ompVersion: "18.12.0",
			helper: {
				installOmp: async () => {
					throw new Error("bun add exited with code 1");
				},
			},
		});
		await h.send({ type: "helper.hello", id: "h1", maxConcurrent: 1 });
		await h.rpc(CHAT_A, prompt("r1", "hello"));
		await h.waitFor(
			() => h.sent.find((message) => message.type === "helper.error"),
			"install failure",
		);
		expect(h.sent.at(-1)).toMatchObject({
			type: "helper.error",
			id: "r1",
			chatId: CHAT_A,
			code: "spawn_failed",
			fix: "Run `bunx freedia doctor` in Terminal to check the install.",
		});
		expect(String(h.sent.at(-1)?.message)).toContain(
			"bun add exited with code 1",
		);
		expect(h.spawns()).toHaveLength(0);
		await h.waitIdle();
	});

	test("the pinned pi already installed: no install", async () => {
		const h = helper();
		await h.rpc(CHAT_A, prompt("r1", "hello"));
		await h.waitIdle();
		expect(h.ompInstalls).toEqual([]);
	});
});

describe("first come, first served", () => {
	test("slot and queue position are assigned before any async preflight", async () => {
		const h = helper({ fake: { defaultScript: "abort" } });
		await h.send({ type: "helper.hello", id: "h1", maxConcurrent: 1 });
		const a = h.rpc(CHAT_A, prompt("a1", "first"));
		const b = h.rpc(CHAT_B, prompt("b1", "second"));
		const c = h.rpc(CHAT_C, prompt("c1", "third"));
		expect(statuses(h.sent)).toEqual([
			[CHAT_A, "starting"],
			[CHAT_B, "queued"],
			[CHAT_C, "queued"],
		]);
		await Promise.all([a, b, c]);
		await h.rpc(CHAT_A, { id: "a2", type: "abort" });
		await h.waitForRpc(CHAT_B, (rpc) => rpc.id === "b1", "B started");
		await h.rpc(CHAT_B, { id: "b2", type: "abort" });
		await h.waitForRpc(CHAT_C, (rpc) => rpc.id === "c1", "C started");
		await h.rpc(CHAT_C, { id: "c2", type: "abort" });
		await h.waitIdle();
		const order = h
			.fakeLog()
			.filter(
				(entry) =>
					entry.event === "stdin" && entry.record?.type === "open_session",
			)
			.map((entry) => entry.record?.sessionDir?.toString().split("/").at(-1));
		expect(order).toEqual([CHAT_A, CHAT_B, CHAT_C]);
	});

	test("the sign-in check runs once and keyless faux prompts succeed", async () => {
		const h = helper({ fake: { auth: { faux: "ready" } } });
		const authChecks = () =>
			h
				.fakeLog()
				.filter(
					(entry) =>
						entry.event === "stdin" &&
						entry.record?.type === "get_login_providers",
				).length;
		await h.rpc(CHAT_A, prompt("a1", "one"));
		await h.waitIdle();
		await h.rpc(CHAT_B, prompt("b1", "two"));
		await h.waitIdle();
		expect(authChecks()).toBe(1);
		expect(h.rpcs(CHAT_B).find((rpc) => rpc.id === "b1")).toMatchObject({
			success: true,
		});
	});
});

describe("title calls yield to user prompts", () => {
	test("a queued user prompt gets the freed slot before the title call", async () => {
		const h = helper({
			fake: { title: "Fruit chat", scripts: { [CHAT_A]: ["stream"] } },
		});
		await h.send({ type: "helper.hello", id: "h1", maxConcurrent: 1 });
		await h.rpc(CHAT_A, prompt("a1", "first"));
		await h.rpc(CHAT_B, prompt("b1", "waiting"));
		expect(statuses(h.sent).at(-1)).toEqual([CHAT_B, "queued"]);
		await h.waitForRpc(
			CHAT_B,
			(rpc) => rpc.type === "session_settled",
			"B done",
		);
		await h.waitIdle();
		const log = h.fakeLog();
		const bSpawn = log.findIndex(
			(entry) =>
				entry.event === "stdin" &&
				entry.record?.type === "open_session" &&
				entry.record?.sessionDir?.toString().endsWith(CHAT_B),
		);
		const bPid = log[bSpawn]?.pid;
		const bEof = log.findIndex(
			(entry) => entry.pid === bPid && entry.event === "eof",
		);
		const titleSpawn = log.findIndex(
			(entry) => entry.event === "spawn" && entry.argv?.includes("-p"),
		);
		expect(bSpawn).toBeGreaterThan(-1);
		expect(titleSpawn).toBeGreaterThan(bEof);
	});
});

describe("pi stops mid-run", () => {
	test("killed pi: spawn_failed with the user's prompt id, slot freed", async () => {
		const h = helper({ fake: { defaultScript: "abort", realTiming: true } });
		await h.send({ type: "helper.hello", id: "h1", maxConcurrent: 1 });
		await h.rpc(CHAT_A, prompt("a1", "long [[long]]"));
		await h.waitForRpc(
			CHAT_A,
			(rpc) => rpc.type === "message_start",
			"streaming",
		);
		await h.rpc(CHAT_B, prompt("b1", "waiting"));
		const pid = h.chatSpawns(CHAT_A)[0]?.pid as number;
		process.kill(pid, "SIGKILL");
		const error = await h.waitFor(
			() => h.sent.find((message) => message.type === "helper.error"),
			"error",
		);
		expect(error).toMatchObject({
			type: "helper.error",
			id: "a1",
			chatId: CHAT_A,
			code: "spawn_failed",
		});
		await h.waitForRpc(CHAT_B, (rpc) => rpc.id === "b1", "B got the slot");
		await h.rpc(CHAT_B, { id: "b2", type: "abort" });
		await h.waitIdle();
	});

	test("pi exiting 0 without agent_settled is reported too", async () => {
		const h = helper({ fake: { exitAfterStdout: 4 } });
		await h.rpc(CHAT_A, prompt("a1", "hello"));
		await h.waitIdle();
		const errors = h.sent.filter((message) => message.type === "helper.error");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({
			id: "a1",
			chatId: CHAT_A,
			code: "spawn_failed",
		});
		expect(String(errors[0]?.message)).toContain("exit code 0");
		expect(h.rpcs(CHAT_A).some((rpc) => rpc.type === "session_settled")).toBe(
			false,
		);
	});

	test("a crash during the helper's own title write never reports an internal id", async () => {
		const h = helper({ fake: { exitAfterStdout: 1 } });
		await h.rpc(CHAT_A, { id: "g1", type: "get_state" });
		await h.waitIdle();
		for (const message of h.sent) {
			expect(String(message.id ?? "")).not.toStartWith(INTERNAL_PREFIX);
		}
	});
});

describe("caps", () => {
	test("page.put over 5 MB is refused and leaves no stale page file", async () => {
		const h = helper();
		await h.send({
			type: "page.put",
			id: "p1",
			chatId: CHAT_A,
			markdown: "old",
		});
		await h.send({
			type: "page.put",
			id: "p2",
			chatId: CHAT_A,
			markdown: "é".repeat(2.6 * 1024 * 1024),
		});
		expect(h.sent.at(-1)).toMatchObject({
			type: "helper.error",
			id: "p2",
			chatId: CHAT_A,
			code: "spawn_failed",
		});
		expect(existsSync(join(h.paths.pages, `${CHAT_A}.md`))).toBe(false);
		await h.send({
			type: "page.put",
			id: "p3",
			chatId: CHAT_A,
			markdown: "x".repeat(5 * 1024 * 1024),
		});
		expect(h.sent.at(-1)).toEqual({
			type: "page.put",
			id: "p3",
			chatId: CHAT_A,
		});
	});

	test("an oversized extension message is answered with helper.error", () => {
		const h = helper();
		h.helper.rejectOversized(9 * 1024 * 1024);
		expect(h.sent).toEqual([
			{
				type: "helper.error",
				code: "spawn_failed",
				message:
					"A message from the extension was 9.0 MB; the helper accepts at most 8 MB.",
				fix: "Try again with a shorter selection or message.",
			},
		]);
	});
});

describe("extension input filtering", () => {
	test("requests using the helper's internal id prefix are dropped", async () => {
		const h = helper();
		await h.rpc(CHAT_A, { id: `${INTERNAL_PREFIX}abort-x`, type: "get_state" });
		await h.rpc(CHAT_A, { id: 7 as never, type: "get_state" });
		await h.waitIdle();
		expect(h.sent).toEqual([]);
		expect(h.spawns()).toHaveLength(0);
	});

	test("only each command's own fields reach pi", async () => {
		const h = helper();
		await h.rpc(CHAT_A, {
			...prompt("r1", "hello"),
			streamingBehavior: "steer",
			images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			command: "rm -rf /",
		});
		await h.waitIdle();
		await h.rpc(CHAT_A, {
			id: "m1",
			type: "set_model",
			provider: "faux",
			modelId: "faux-2",
			extra: true,
		});
		await h.rpc(CHAT_A, { id: "s1", type: "get_state", sessionPath: "/etc" });
		await h.waitIdle();
		const sentToPi = h
			.fakeLog()
			.filter(
				(entry) =>
					entry.event === "stdin" &&
					h.chatSpawns(CHAT_A).some((spawn) => spawn.pid === entry.pid) &&
					entry.record?.type !== "set_session_name" &&
					!String(entry.record?.id ?? "").startsWith(INTERNAL_PREFIX),
			)
			.map((entry) => entry.record);
		expect(sentToPi).toEqual([
			{
				...prompt("r1", "hello"),
				images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			},
			{ id: "m1", type: "set_model", provider: "faux", modelId: "faux-2" },
			{ id: "s1", type: "get_state" },
		]);
	});
});

describe("titles after an aborted partial reply", () => {
	test("the retained assistant partial can title the chat", async () => {
		const h = helper({ fake: { title: "Fruit chat", defaultScript: "abort" } });
		await h.rpc(CHAT_A, prompt("r1", "long [[long]]"));
		await h.waitForRpc(CHAT_A, (rpc) => rpc.id === "r1", "accepted");
		await h.rpc(CHAT_A, { id: "r2", type: "abort" });
		await h.waitIdle();
		expect(h.spawns((argv) => argv.includes("-p"))).toHaveLength(1);
		expect(readFileSync(h.helperSession(CHAT_A), "utf8")).toContain(
			'"title":"Fruit chat"',
		);
	});
});
