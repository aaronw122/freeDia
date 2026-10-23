# Spike: omp RPC under Bun (pi → omp swap)

Date: 2026-10-23 · macOS arm64 · Bun 1.4.3 · omp `@oh-my-pi/pi-coding-agent@18.12.1` (`omp --version` → `omp/18.12.1`).
Everything below was observed on this machine. Model output comes from a local OpenAI-compatible mock server (`faux-server.ts`) registered as a keyless custom provider via `models.yml`; no real provider was called.

## Why omp

pi's RPC protocol descends from the same codebase: omp is a pi fork with the same `--mode rpc` JSONL protocol, the same event shapes, and `engines.bun >= 1.3.14` (Bun-native, no Node path at all). It adds what freeDia wants:

- `open_session {sessionDir}` — a host-binding command designed for embedders: "the runtime equivalent of `--session-dir <dir> --continue`, so a pre-spawned process can adopt a thread after startup".
- Subscription OAuth logins out of the box: `get_login_providers` lists `openai-codex` (ChatGPT Plus/Pro), `anthropic` (Claude Pro/Max), `zai`/`zai-coding-plan` (GLM Coding Plan), `kimi-code`, `openrouter`, … each with `available`/`authenticated` flags.
- Resume restores the session's saved model by itself — the pi `unknown`-model resume bug (S1 fixtures `model-override-*`) does not exist.
- RPC protocol v2 with `rpc_chunk` framing: oversized stdout frames (e.g. `get_messages` on a long chat) are chunked losslessly instead of erroring.

## Setup

- `bun add @oh-my-pi/pi-coding-agent@18.12.1` in a scratch package: 112 packages in 10 s; bin `dist/cli.js`. (18.12.6 is npm-latest; 18.12.1 pinned to match the installed brew build and this machine's `minimumReleaseAge` = 48 h.)
- Runs under Bun: `BUN_BE_BUN=1 bun …/dist/cli.js --version` → `omp/18.12.1`. `--session-id` does **not** exist (dropped from pi); session binding is `open_session`/`--session-dir` per conversation directory.
- `PI_CODING_AGENT_DIR` is honoured: config (`config.yml`), credentials (`agent.db`), model catalog (`models.db`), `models.yml` and prompt history (`history.db`) all live in the agent dir.
- With a fake `HOME` (isolated env), omp writes only `~/.omp/logs`, `~/.omp/run/{daemons,session-owners}` and `Library/Caches/bun` under it. The real home's `~/.env` leak is closed by pointing `HOME` at a freeDia-owned directory.
- Tooling: `faux-server.ts` (OpenAI-compatible mock, scripted replies on `[[write]]` / `[[read]]` / `[[long]]` / `[[ratelimit]]` / `[[recall]]` markers, `## Question` heading parsing, title replies), `models.yml` in the agent dir (`auth: none`, `baseUrl: http://127.0.0.1:8791/v1`, models `faux-1`/`faux-2`), and `spike.ts`, the scenario driver spawning `[process.execPath, cli.js, "--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--cwd", …]` with `BUN_BE_BUN=1`, as the helper will. Fixtures in `/tmp/omp-spike/out/*.jsonl`, same `{"t","dir","record"}` shape as the S1 fixtures.

## Findings

1. **`open_session` is the chat binding.** Fresh dir → `{cancelled:false, resumed:false, sessionId <uuidv7>, sessionFile <dir>/<timestamp>_<uuidv7>.jsonl}`; same dir again → `resumed:true`, same file, full context kept across processes (`[[recall]]` sees all prior turns). The chatId becomes the *directory* name; omp's session id never leaves omp.
2. **Model restore on resume is automatic.** After `set_model faux/faux-1` in process A, a fresh process B with `open_session` (no `--model`) reports `get_state.model = faux-1`. No `--model` on resume; no `unknown` restore.
3. **RPC `bash` still runs a real shell despite `--tools read,grep,glob`** (`echo SPIKE_PWNED` → `exitCode 0`, output `SPIKE_PWNED`). Same as pi S1: the helper's command allowlist is the security boundary. The run is also recorded into the session as a user message, polluting context — one more reason to block it.
4. **Abort keeps the partial.** `message_update` streams `assistantMessageEvent.text_delta` (with a `partial` snapshot); `abort` → response `success:true` → `prompt_result {status:"aborted", sessionSettled:true}` → `session_settled`. `get_messages` then shows the partial assistant message with `stopReason:"aborted"` (text = only what streamed before the abort).
5. **Run lifecycle = `prompt_result` + `session_settled`.** A completed prompt: ack `{command:"prompt", success:true}` (no `data`), then `prompt_result {agentInvoked:true, status:"completed", sessionSettled:true}`, then `session_settled`. `agent_end` can be non-terminal (`yielded:false`, retries/compaction), so the helper tears the process down on `session_settled`, like pi's `agent_settled`.
6. **Not-signed-in surfaces at `set_model`, not at prompt.** With no credentials, `set_model anthropic/claude-sonnet-4-5` → `success:false, error:"Model not found: anthropic/claude-sonnet-4-5"` (unauthenticated providers are unavailable); `get_login_providers` reports each provider's `authenticated:false`. With *no* model configured omp auto-selects an available one (faux-1 here), so a prompt can still succeed — sign-in state must be read from `get_login_providers`, not inferred from prompt failures.
7. **Read-only tools.** `--tools read,grep,glob`: a model `write` call → `tool_execution_end` with `isError:true`; nothing written. omp has no `find`/`ls` tools (pi names); `glob` covers listing.
8. **Message/event shapes are pi's.** `get_messages` → `data.messages[]` with `role`, `content` blocks, `usage`, `stopReason`; `message_update`/`message_end` identical to pi 1.3.0. The extension's rendering code carries over unchanged.
9. **Frame noise.** Even with `--no-extensions --no-skills --no-rules`, a session emits `available_commands_update` (startup + changes), `extension_ui_request` (`setWidget autoresearch`), and `advisor_cost_changed` frames. `--no-ui` drops presentation updates; the helper forwards unknown frames untouched and the extension ignores them.
10. **Protocol v2 negotiation works as documented**: `{negotiate_protocol, protocolVersion:2}` → `data.protocolVersion 2`; oversized frames then arrive as `rpc_chunk` sequences the helper must reassemble (not exercised by these small fixtures).
11. **`set_session_name` succeeds** on a resumed chat process; titles live in the session header's fixed-width title slot plus `title_change` entries.
12. **Session lease:** a second process writing the same session moves it to a sibling file — the helper must keep exactly one process per chat (it already does).
13. **Fake `HOME` works.** All five scenarios ran with `HOME=<scratch>/home`, `PATH=/usr/bin:/bin:…`, `PI_CODING_AGENT_DIR`, `BUN_BE_BUN=1` only. omp never touched the real home.

## Differences from pi that change the Contract

| pi 1.3.0 | omp 18.12.1 |
| --- | --- |
| `--session-id <chatId>` create/resume, chatId = session id | `open_session {sessionDir: ~/.freedia/chats/<chatId>}`; chatId = directory name; session id is omp's uuidv7 |
| resume needs `--model <session's model>` (else `unknown` bug) | resume restores the saved model; pass `--model` only on fresh spawn (the user's pick) |
| `agent_settled` ends a run | `prompt_result` + `session_settled` (with `sessionSettled` flag on the result) |
| 1 MiB frame cap, oversized → error | v2 `rpc_chunk` reassembly after `negotiate_protocol` (helper-side, new) |
| not signed in → prompt fails "No API key found" | `set_model` fails "Model not found: <provider/modelId>"; sign-in state via `get_login_providers` |
| `auth.json` in agent dir | credentials in `agent.db` (SQLite) in the agent dir; `omp login <provider>` for sign-in |
| `pi auth check --provider <p> --json` preflight | no such command; preflight = short-lived RPC `get_login_providers` |
| faux = pi-ai extension (`fauxProvider`) | faux = local OpenAI-compatible HTTP server + `models.yml` `auth: none` provider (no omp internals) |
| `--tools read,grep,find,ls` | `--tools read,grep,glob` |
| `PI_NO_TITLE` env / title via RPC one-shot | RPC disables auto-title itself; one-shot title via `omp -p --no-session --no-title --model <p/m>` (answer on stdout) |

## Numbers

- Whole spike (5 process lifecycles: fresh+stream+models+bash probe, resume+recall+rename, abort, unauth, write-block) ran in **6.25 s wall** including ~1 s per spawn under Bun. Respawn cost is on the order of pi's (~120–200 ms); memory per process **[NOT VERIFIED]** — re-measure during the swap implementation (pi measured 105–140 MB RSS).
