import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PAGE_TTL_MS } from "../src/helper";
import { ISOLATION_FLAGS } from "../src/pi";
import {
	CHAT_A,
	CHAT_B,
	CHAT_C,
	type TestHelper as H,
	TestHelper,
} from "./harness";

const FAUX = "--offline --model faux/faux-1";
const homes: string[] = [];

function helper(options: ConstructorParameters<typeof TestHelper>[0] = {}): H {
	const h = new TestHelper({
		...options,
		env: { FREEDIA_PI_EXTRA_ARGS: FAUX, ...options.env },
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

const BLOCKED = [
	"bash",
	"abort_bash",
	"steer",
	"follow_up",
	"clear_queue",
	"new_session",
	"switch_session",
	"fork",
	"clone",
	"get_fork_messages",
	"get_entries",
	"get_tree",
	"export_html",
	"compact",
	"set_auto_compaction",
	"set_auto_retry",
	"abort_retry",
	"set_steering_mode",
	"set_follow_up_mode",
	"cycle_model",
	"set_thinking_level",
	"cycle_thinking_level",
	"get_available_thinking_levels",
	"get_session_stats",
	"get_last_assistant_text",
	"get_commands",
	"extension_ui_response",
	"set_session_name",
	"definitely_not_a_command",
];

function prompt(id: string, question: string, title = "Example") {
	return {
		id,
		type: "prompt",
		message: `URL: https://example.com\nTitle: ${title}\n\n## Question\n${question}`,
	};
}

describe("allowlist", () => {
	test.each(BLOCKED)(
		"drops %s without spawning pi or replying",
		async (type) => {
			const h = helper();
			await h.rpc(CHAT_A, { id: "r1", type, command: "touch /tmp/pwned" });
			await h.waitIdle();
			expect(h.spawns()).toHaveLength(0);
			expect(h.sent).toHaveLength(0);
		},
	);

	test.each([
		{ chatId: "../../etc", rpc: { id: "r1", type: "prompt", message: "hi" } },
		{ chatId: CHAT_A.toUpperCase(), rpc: { id: "r1", type: "get_state" } },
		{ type: "chat.delete", id: "h1", chatId: "../x" },
		{ type: "page.put", id: "h1", chatId: CHAT_A, markdown: 1 },
		{ type: "helper.hello", id: "h1", maxConcurrent: 0 },
		{ type: "bash", id: "h1", command: "ls" },
		"prompt",
		undefined,
	])("drops invalid message %p", async (message) => {
		const h = helper();
		await h.send(message);
		expect(h.spawns()).toHaveLength(0);
		expect(h.sent).toHaveLength(0);
	});
});

describe("pi launch", () => {
	test("uses the read-only flags, fixed cwd, clean env and test hook", async () => {
		const h = helper({
			env: {
				ANTHROPIC_API_KEY: "sk-ant-secret",
				GROQ_API_KEY: "gsk-secret",
				OPENAI_API_KEY: "sk-secret",
				GITHUB_TOKEN: "ghp-secret",
				FREEDIA_FAUX_TPS: "0",
				FREEDIA_PI_EXTRA_ARGS: `-e /tmp/faux.ts ${FAUX}`,
			},
		});
		await h.rpc(CHAT_A, prompt("r1", "hello"));
		await h.waitForRpc(
			CHAT_A,
			(rpc) => rpc.type === "agent_settled",
			"settled",
		);
		const [spawn] = h.chatSpawns(CHAT_A);
		const argv = spawn?.argv ?? [];
		expect(argv.slice(0, 7)).toEqual([
			"--mode",
			"rpc",
			"--session-dir",
			h.paths.chats,
			"--session-id",
			CHAT_A,
			"--model",
		]);
		expect(argv[7]).toBe("faux/faux-1");
		expect(argv).toContain("--tools");
		expect(argv[argv.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
		for (const flag of ISOLATION_FLAGS) {
			expect(argv).toContain(flag);
		}
		const rules = argv[argv.indexOf("--append-system-prompt") + 1] ?? "";
		expect(rules).toContain(join(h.paths.pages, `${CHAT_A}.md`));
		expect(rules).toContain("read-only");
		expect(argv.slice(-3)).toEqual(["-e", "/tmp/faux.ts", "--offline"]);
		expect(argv.filter((arg) => arg === "--model")).toHaveLength(1);
		expect(realpathSync(spawn?.cwd ?? "")).toBe(realpathSync(h.paths.root));
		const env = spawn?.env ?? {};
		expect(Object.keys(env).filter((key) => /KEY|TOKEN/.test(key))).toEqual([]);
		expect(env.HOME).toBe(h.home);
		expect(env.PI_CODING_AGENT_DIR).toBe(h.paths.piAgent);
		expect(env.BUN_BE_BUN).toBe("1");
		expect(env.FREEDIA_FAUX_TPS).toBe("0");
		expect(env.FREEDIA_PI_EXTRA_ARGS).toBeUndefined();
	});

	test("a resumed spawn never passes --model and keeps the chat's set_model choice", async () => {
		const h = helper({
			fake: {
				scripts: {
					[CHAT_A]: [
						"model-override-1-set-model",
						"model-override-3-resume-without-flag",
					],
				},
			},
		});
		await h.rpc(CHAT_A, prompt("r1", "first on faux-1"));
		await h.waitForRpc(
			CHAT_A,
			(rpc) => rpc.type === "agent_settled",
			"first reply",
		);
		await h.waitIdle();
		await h.rpc(CHAT_A, {
			id: "r2",
			type: "set_model",
			provider: "faux",
			modelId: "faux-2",
		});
		await h.rpc(CHAT_A, { id: "r3", type: "get_state" });
		await h.waitForRpc(CHAT_A, (rpc) => rpc.id === "r3", "get_state");
		await h.waitIdle();
		await h.rpc(CHAT_A, { id: "r4", type: "get_state" });
		const state = await h.waitForRpc(
			CHAT_A,
			(rpc) => rpc.id === "r4",
			"resumed state",
		);
		const spawns = h.chatSpawns(CHAT_A);
		expect(spawns).toHaveLength(3);
		expect(spawns[0]?.argv).toContain("--model");
		expect(spawns[1]?.argv).not.toContain("--model");
		expect(spawns[2]?.argv).not.toContain("--model");
		expect(state).toMatchObject({
			success: true,
			data: { model: { provider: "faux", id: "faux-2" } },
		});
	});

	test("set_model before the first message is used as --model for the new chat", async () => {
		const h = helper();
		await h.rpc(CHAT_A, {
			id: "r1",
			type: "set_model",
			provider: "faux",
			modelId: "faux-2",
		});
		await h.waitForRpc(CHAT_A, (rpc) => rpc.id === "r1", "set_model");
		await h.waitIdle();
		await h.rpc(CHAT_A, prompt("r2", "hello"));
		await h.waitForRpc(
			CHAT_A,
			(rpc) => rpc.type === "agent_settled",
			"settled",
		);
		const second = h.chatSpawns(CHAT_A)[1]?.argv ?? [];
		expect(second[second.indexOf("--model") + 1]).toBe("faux/faux-2");
	});
});

describe("routing and pool", () => {
	test("two chats stream concurrently without cross-talk", async () => {
		const h = helper({ fake: { realTiming: true, defaultScript: "abort" } });
		await Promise.all([
			h.rpc(CHAT_A, prompt("a1", "question for A")),
			h.rpc(CHAT_B, prompt("b1", "question for B")),
		]);
		await h.waitFor(
			() =>
				h.helper.runningChats().length === 2 &&
				h.rpcs(CHAT_A).length > 5 &&
				h.rpcs(CHAT_B).length > 5,
			"both streaming",
		);
		await h.rpc(CHAT_B, { id: "b2", type: "abort" });
		await h.waitForRpc(CHAT_B, (rpc) => rpc.id === "b2", "B abort response");
		expect(h.rpcs(CHAT_A).some((rpc) => rpc.type === "agent_settled")).toBe(
			false,
		);
		await h.rpc(CHAT_A, { id: "a2", type: "abort" });
		await h.waitForRpc(CHAT_A, (rpc) => rpc.id === "a2", "A abort response");
		const users = (chatId: string) =>
			h
				.rpcs(chatId)
				.filter((rpc) => rpc.type === "message_end")
				.map((rpc) => JSON.stringify(rpc.message))
				.filter((text) => text.includes('"role":"user"'));
		expect(users(CHAT_A).join()).toContain("question for A");
		expect(users(CHAT_A).join()).not.toContain("question for B");
		expect(users(CHAT_B).join()).toContain("question for B");
		expect(users(CHAT_B).join()).not.toContain("question for A");
		for (const chatId of [CHAT_A, CHAT_B]) {
			const ids = h
				.rpcs(chatId)
				.filter((rpc) => rpc.type === "response")
				.map((rpc) => rpc.id);
			expect(ids).toEqual(chatId === CHAT_A ? ["a1", "a2"] : ["b1", "b2"]);
		}
	});

	test("pi stdout lines are forwarded untouched in order", async () => {
		const h = helper();
		await h.rpc(CHAT_A, prompt("r2", "hello from freeDia"));
		await h.waitForRpc(
			CHAT_A,
			(rpc) => rpc.type === "agent_settled",
			"settled",
		);
		const emitted = h
			.fakeLog()
			.filter((entry) => entry.event === "stdout")
			.map((entry) => entry.record);
		expect(h.rpcs(CHAT_A)).toEqual(emitted as never);
	});

	test("prompts over maxConcurrent queue and start when a slot frees", async () => {
		const h = helper({ fake: { defaultScript: "abort" } });
		await h.send({ type: "helper.hello", id: "h1", maxConcurrent: 1 });
		await h.rpc(CHAT_A, prompt("a1", "long one"));
		await h.waitForRpc(CHAT_A, (rpc) => rpc.id === "a1", "A accepted");
		await h.rpc(CHAT_B, prompt("b1", "waits"));
		await h.rpc(CHAT_C, prompt("c1", "waits too"));
		const statuses = () =>
			h.sent
				.filter((m) => m.type === "chat.status")
				.map((m) => [m.chatId, "state" in m ? m.state : ""]);
		expect(statuses()).toEqual([
			[CHAT_A, "starting"],
			[CHAT_B, "queued"],
			[CHAT_C, "queued"],
		]);
		expect(h.chatSpawns(CHAT_B)).toHaveLength(0);
		await h.rpc(CHAT_A, { id: "a2", type: "abort" });
		await h.waitForRpc(CHAT_B, (rpc) => rpc.id === "b1", "B started");
		expect(statuses().slice(3)).toEqual([[CHAT_B, "starting"]]);
		expect(h.chatSpawns(CHAT_C)).toHaveLength(0);
		await h.rpc(CHAT_C, { id: "c2", type: "abort" });
		expect(h.rpcs(CHAT_C)).toEqual([
			{ id: "c2", type: "response", command: "abort", success: true },
		]);
		await h.rpc(CHAT_B, { id: "b2", type: "abort" });
		await h.waitIdle();
		expect(h.chatSpawns(CHAT_C)).toHaveLength(0);
		expect(h.fakeLog().some((entry) => entry.record?.id === "c1")).toBe(false);
	});

	test("abort while starting: the prompt never reaches pi, pi closes, then the abort response", async () => {
		const h = helper({
			fake: { defaultScript: "abort" },
			onMessage: (message, harness) => {
				if (message.type === "chat.status" && message.chatId === CHAT_A) {
					harness.rpc(CHAT_A, { id: "a2", type: "abort" });
				}
			},
		});
		await h.rpc(CHAT_A, prompt("a1", "never sent"));
		await h.waitIdle();
		expect(h.rpcs(CHAT_A)).toEqual([
			{ id: "a2", type: "response", command: "abort", success: true },
		]);
		const spawns = h.chatSpawns(CHAT_A);
		expect(spawns).toHaveLength(1);
		const events = h
			.fakeLog()
			.filter((entry) => entry.pid === spawns[0]?.pid)
			.map((entry) => entry.event);
		expect(events).toEqual(["spawn", "eof"]);
		await h.send({ type: "helper.hello", id: "h1", maxConcurrent: 1 });
		await h.rpc(CHAT_B, prompt("b1", "next chat still gets a slot"));
		await h.waitForRpc(CHAT_B, (rpc) => rpc.id === "b1", "B started");
		await h.rpc(CHAT_B, { id: "b2", type: "abort" });
		await h.waitIdle();
		expect(h.rpcs(CHAT_B).slice(-2)).toEqual([
			{ type: "agent_settled", aborted: true },
			{ id: "b2", type: "response", command: "abort", success: true },
		]);
	});

	test("process exits on agent_settled and the next message respawns and resumes", async () => {
		const h = helper({
			fake: { scripts: { [CHAT_A]: ["resume-create", "resume-continue"] } },
		});
		await h.rpc(CHAT_A, prompt("r1", "remember the word pineapple"));
		await h.waitForRpc(
			CHAT_A,
			(rpc) => rpc.type === "agent_settled",
			"first settled",
		);
		await h.waitIdle();
		const firstPid = h.chatSpawns(CHAT_A)[0]?.pid;
		const log = h.fakeLog().filter((entry) => entry.pid === firstPid);
		expect(log.at(-1)?.event).toBe("eof");
		expect(log.at(-2)?.record?.type).toBe("agent_settled");
		await h.rpc(CHAT_A, prompt("r2", "what word? [[recall]]"));
		await h.waitFor(
			() =>
				h.rpcs(CHAT_A).filter((rpc) => rpc.type === "agent_settled").length ===
				2,
			"second settled",
		);
		const spawns = h.chatSpawns(CHAT_A);
		expect(spawns).toHaveLength(2);
		expect(spawns[1]?.argv).not.toContain("--model");
		const recall = h
			.rpcs(CHAT_A)
			.filter((rpc) => rpc.type === "message_end")
			.map((rpc) => JSON.stringify(rpc.message))
			.join();
		expect(recall).toContain("pineapple");
	});

	test("abort ordering: agent_settled, then the abort response, then stdin closes", async () => {
		const h = helper({
			fake: { defaultScript: "abort", abortResponseDelayMs: 300 },
		});
		await h.rpc(CHAT_A, prompt("r1", "write something [[long]]"));
		await h.waitForRpc(CHAT_A, (rpc) => rpc.id === "r1", "accepted");
		await h.rpc(CHAT_A, { id: "r2", type: "abort" });
		await h.waitIdle();
		const tail = h.rpcs(CHAT_A).slice(-2);
		expect(tail).toEqual([
			{ type: "agent_settled", aborted: true },
			{ id: "r2", type: "response", command: "abort", success: true },
		]);
		const chatPid = h.chatSpawns(CHAT_A)[0]?.pid;
		const events = h
			.fakeLog()
			.filter((entry) => entry.pid === chatPid && entry.event !== "spawn")
			.map((entry) =>
				entry.event === "eof"
					? "eof"
					: `${entry.event}:${entry.record?.type}:${entry.record?.command ?? ""}`,
			);
		const settled = events.indexOf("stdout:agent_settled:");
		const response = events.indexOf("stdout:response:abort");
		const eof = events.indexOf("eof");
		expect(settled).toBeGreaterThan(0);
		expect(response).toBeGreaterThan(settled);
		expect(eof).toBeGreaterThan(response);
	});

	test("get_messages on a reopened chat spawns pi and exits after the response", async () => {
		const h = helper({ fake: { defaultScript: "abort-resume" } });
		await h.rpc(CHAT_A, { id: "g1", type: "get_messages" });
		const reply = await h.waitForRpc(
			CHAT_A,
			(rpc) => rpc.id === "g1",
			"messages",
		);
		expect(reply).toMatchObject({ command: "get_messages", success: true });
		await h.waitIdle();
		expect(h.chatSpawns(CHAT_A)).toHaveLength(1);
	});
});

describe("model list", () => {
	test("answers from one short-lived pi when no chat runs, then from cache", async () => {
		const h = helper();
		await h.rpc(CHAT_A, { id: "m1", type: "get_available_models" });
		await h.rpc(CHAT_B, { id: "m2", type: "get_available_models" });
		const a = h.rpcs(CHAT_A)[0];
		const b = h.rpcs(CHAT_B)[0];
		expect(a).toMatchObject({
			id: "m1",
			type: "response",
			command: "get_available_models",
			success: true,
		});
		expect(b).toMatchObject({ id: "m2", command: "get_available_models" });
		expect(a?.data).toMatchObject({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
		});
		expect(b?.data).toEqual(a?.data);
		const spawns = h.spawns();
		expect(spawns).toHaveLength(1);
		expect(spawns[0]?.argv).toContain("--no-session");
		expect(spawns[0]?.argv).not.toContain("--session-id");
	});
});

describe("helper commands", () => {
	test("helper.hello reports versions and pi_missing when pi is absent", async () => {
		const h = helper({ installPi: false });
		await h.send({ type: "helper.hello", id: "h1", maxConcurrent: 2 });
		expect(h.sent).toEqual([
			{ type: "helper.hello", id: "h1", helperVersion: "9.9.9", piVersion: "" },
			{
				type: "helper.error",
				code: "pi_missing",
				message: "pi is not installed in ~/.freedia/pi.",
				fix: "Run `bunx freedia install` in Terminal to reinstall the helper and pi.",
			},
		]);
		await h.rpc(CHAT_A, prompt("r1", "hi"));
		expect(h.sent.at(-1)).toMatchObject({
			type: "helper.error",
			id: "r1",
			chatId: CHAT_A,
			code: "pi_missing",
		});
	});

	test("helper.hello with pi installed reports its version", async () => {
		const h = helper();
		await h.send({ type: "helper.hello", id: "h1", maxConcurrent: 3 });
		expect(h.sent).toEqual([
			{
				type: "helper.hello",
				id: "h1",
				helperVersion: "9.9.9",
				piVersion: "1.3.0",
			},
		]);
	});

	test("not signed in to the chat's provider answers not_signed_in with fix text", async () => {
		const h = helper({
			env: { FREEDIA_PI_EXTRA_ARGS: "--model anthropic/claude-sonnet-4-5" },
			fake: { auth: { anthropic: "not_ready" } },
		});
		await h.rpc(CHAT_A, prompt("r1", "hi"));
		expect(h.sent.at(-1)).toEqual({
			type: "helper.error",
			id: "r1",
			chatId: CHAT_A,
			code: "not_signed_in",
			message: "Not signed in to anthropic.",
			fix: "Run `bunx freedia login` in Terminal and sign in to anthropic.",
		});
		expect(h.chatSpawns(CHAT_A)).toHaveLength(0);
	});

	test("chat.list: freeDia title, else the first 8 words of the question; newest first", async () => {
		const h = helper({
			fake: { title: "A Very Good Title For This Chat Indeed Yes Really" },
		});
		await h.rpc(
			CHAT_A,
			prompt("a1", "one two three four five six seven eight nine ten"),
		);
		await h.waitForRpc(
			CHAT_A,
			(rpc) => rpc.type === "agent_settled",
			"A settled",
		);
		await h.waitFor(
			() =>
				readFileSync(h.helperSession(CHAT_A), "utf8").includes("session_info"),
			"title written",
		);
		const b = helper({ home: h.home, fake: { title: null } });
		await b.rpc(
			CHAT_B,
			prompt(
				"b1",
				"  what   is\nthis page about, really, in plain words please",
			),
		);
		await b.waitForRpc(
			CHAT_B,
			(rpc) => rpc.type === "agent_settled",
			"B settled",
		);
		await b.waitIdle();
		await b.send({ type: "chat.list", id: "l1" });
		const list = b.sent.at(-1);
		expect(list).toMatchObject({ type: "chat.list", id: "l1" });
		const chats = (
			list as { chats: { chatId: string; title: string; updatedAt: string }[] }
		).chats;
		expect(chats.map((chat) => [chat.chatId, chat.title])).toEqual([
			[CHAT_B, "what is this page about, really, in plain"],
			[CHAT_A, "A Very Good Title For This Chat Indeed"],
		]);
		for (const chat of chats) {
			expect(new Date(chat.updatedAt).toISOString()).toBe(chat.updatedAt);
		}
	});

	test("chat.delete stops a running chat first, then deletes its session and page", async () => {
		const h = helper({
			fake: { defaultScript: "abort", abortResponseDelayMs: 200 },
		});
		await h.send({
			type: "page.put",
			id: "p1",
			chatId: CHAT_A,
			markdown: "# Page",
		});
		await h.rpc(CHAT_A, prompt("r1", "write something [[long]]"));
		await h.waitFor(
			() =>
				existsSync(join(h.paths.chats)) &&
				readdirSync(h.paths.chats).length > 0,
			"session file",
		);
		await h.send({ type: "chat.delete", id: "d1", chatId: CHAT_A });
		expect(h.sent.at(-1)).toEqual({
			type: "chat.delete",
			id: "d1",
			chatId: CHAT_A,
		});
		expect(h.helper.runningChats()).toEqual([]);
		const chatPid = h.chatSpawns(CHAT_A)[0]?.pid;
		const events = h
			.fakeLog()
			.filter((entry) => entry.pid === chatPid)
			.map((entry) => `${entry.event}:${entry.record?.type ?? ""}`);
		expect(events).toContain("stdin:abort");
		expect(events.at(-1)).toBe("eof:");
		expect(readdirSync(h.paths.chats)).toEqual([]);
		expect(existsSync(join(h.paths.pages, `${CHAT_A}.md`))).toBe(false);
		expect(h.rpcs(CHAT_A).some((rpc) => rpc.command === "abort")).toBe(false);
	});
});

describe("chat titles", () => {
	test("one-shot --no-session title, then set_session_name on the idle chat, cut to 8 words", async () => {
		const h = helper({
			fake: { title: '"Pineapples: A Long Title That Keeps Going On And On."' },
		});
		await h.rpc(
			CHAT_A,
			prompt("r1", "remember the word pineapple", "Fruit Facts"),
		);
		await h.waitForRpc(
			CHAT_A,
			(rpc) => rpc.type === "agent_settled",
			"settled",
		);
		await h.waitFor(
			() =>
				readFileSync(h.helperSession(CHAT_A), "utf8").includes("session_info"),
			"title written",
		);
		await h.waitIdle();
		const titleSpawn = h.spawns((argv) => argv.includes("--no-session"));
		expect(titleSpawn).toHaveLength(1);
		expect(titleSpawn[0]?.argv).toContain("--model");
		const titlePrompt = h
			.fakeLog()
			.find(
				(entry) => entry.pid === titleSpawn[0]?.pid && entry.event === "stdin",
			)?.record;
		expect(String(titlePrompt?.message)).toContain("Page title: Fruit Facts");
		expect(String(titlePrompt?.message)).toContain(
			"Question: remember the word pineapple",
		);
		expect(String(titlePrompt?.message)).not.toContain("URL:");
		const namer = h.chatSpawns(CHAT_A)[1];
		expect(namer?.argv).not.toContain("--model");
		const named = h
			.fakeLog()
			.filter((entry) => entry.pid === namer?.pid && entry.event === "stdin");
		expect(named.map((entry) => entry.record)).toEqual([
			expect.objectContaining({
				type: "set_session_name",
				name: "Pineapples: A Long Title That Keeps Going On",
			}),
		]);
		expect(
			h
				.rpcs(CHAT_A)
				.some(
					(rpc) =>
						rpc.type === "response" && rpc.command === "set_session_name",
				),
		).toBe(false);
	});

	test("a busy chat gets set_session_name as the first command of its next spawn", async () => {
		const h = helper({ fake: { title: "Fruit chat" } });
		await h.rpc(CHAT_A, prompt("r1", "first"));
		await h.waitForRpc(
			CHAT_A,
			(rpc) => rpc.type === "agent_settled",
			"settled",
		);
		await h.rpc(CHAT_A, prompt("r2", "second"));
		await h.waitFor(
			() =>
				h.rpcs(CHAT_A).filter((rpc) => rpc.type === "agent_settled").length ===
				2,
			"second settled",
		);
		await h.waitIdle();
		await h.waitFor(
			() =>
				readFileSync(h.helperSession(CHAT_A), "utf8").includes("session_info"),
			"title written",
		);
		const commands = h
			.fakeLog()
			.filter(
				(entry) =>
					entry.event === "stdin" &&
					entry.pid !==
						h.spawns((argv) => argv.includes("--no-session"))[0]?.pid,
			);
		const firstOfSpawn = new Map<number, string>();
		for (const entry of commands) {
			if (!firstOfSpawn.has(entry.pid)) {
				firstOfSpawn.set(entry.pid, entry.record?.type ?? "");
			}
		}
		expect([...firstOfSpawn.values()]).toContain("set_session_name");
		expect(
			h.fakeLog().filter((entry) => entry.record?.type === "set_session_name"),
		).toHaveLength(1);
	});

	test("a failed title call writes no name and chat.list falls back to the question", async () => {
		const h = helper({ fake: { title: null } });
		await h.rpc(CHAT_A, prompt("r1", "how do pineapples grow"));
		await h.waitForRpc(
			CHAT_A,
			(rpc) => rpc.type === "agent_settled",
			"settled",
		);
		await h.waitFor(
			() => h.spawns((argv) => argv.includes("--no-session")).length === 1,
			"title call",
		);
		await h.waitIdle();
		expect(readFileSync(h.helperSession(CHAT_A), "utf8")).not.toContain(
			"session_info",
		);
		await h.send({ type: "chat.list", id: "l1" });
		expect(h.sent.at(-1)).toMatchObject({
			chats: [{ chatId: CHAT_A, title: "how do pineapples grow" }],
		});
	});
});

describe("page files", () => {
	test("page.put writes, page.clear deletes, and startup clears the folder", async () => {
		const h = helper();
		await h.send({
			type: "page.put",
			id: "p1",
			chatId: CHAT_A,
			markdown: "# Hello\n\nworld",
		});
		expect(h.sent.at(-1)).toEqual({
			type: "page.put",
			id: "p1",
			chatId: CHAT_A,
		});
		const file = join(h.paths.pages, `${CHAT_A}.md`);
		expect(readFileSync(file, "utf8")).toBe("# Hello\n\nworld");
		await h.send({
			type: "page.put",
			id: "p2",
			chatId: CHAT_A,
			markdown: "v2",
		});
		expect(readFileSync(file, "utf8")).toBe("v2");
		await h.send({ type: "page.clear", id: "p3", chatId: CHAT_A });
		expect(h.sent.at(-1)).toEqual({
			type: "page.clear",
			id: "p3",
			chatId: CHAT_A,
		});
		expect(existsSync(file)).toBe(false);
		mkdirSync(h.paths.pages, { recursive: true });
		writeFileSync(join(h.paths.pages, `${CHAT_B}.md`), "stale");
		helper({ home: h.home });
		expect(readdirSync(h.paths.pages)).toEqual([]);
	});

	test("deletes a page after 60 minutes unused; use resets the clock", async () => {
		let now = 1_000_000;
		const h = helper({ helper: { now: () => now } });
		await h.send({ type: "page.put", id: "p1", chatId: CHAT_A, markdown: "a" });
		await h.send({ type: "page.put", id: "p2", chatId: CHAT_B, markdown: "b" });
		now += PAGE_TTL_MS - 1000;
		await h.rpc(CHAT_B, { id: "s1", type: "get_state" });
		await h.waitIdle();
		h.helper.sweepPages();
		expect(readdirSync(h.paths.pages).sort()).toEqual(
			[`${CHAT_A}.md`, `${CHAT_B}.md`].sort(),
		);
		now += 1000;
		h.helper.sweepPages();
		expect(readdirSync(h.paths.pages)).toEqual([`${CHAT_B}.md`]);
		now += PAGE_TTL_MS;
		h.helper.sweepPages();
		expect(readdirSync(h.paths.pages)).toEqual([]);
	});
});

describe("shutdown", () => {
	test("lets an in-flight run finish before resolving", async () => {
		const h = helper({ fake: { realTiming: true } });
		await h.rpc(CHAT_A, prompt("r1", "hello"));
		await h.waitForRpc(CHAT_A, (rpc) => rpc.id === "r1", "accepted");
		await h.helper.shutdown();
		expect(h.rpcs(CHAT_A).some((rpc) => rpc.type === "agent_settled")).toBe(
			true,
		);
		expect(h.helper.runningChats()).toEqual([]);
		await h.rpc(CHAT_B, prompt("r2", "after shutdown"));
		expect(h.chatSpawns(CHAT_B)).toHaveLength(0);
	});
});
