# Spike S1: pi RPC under Bun

Date: 2026-10-19 · macOS arm64 · Bun 1.4.3 · pi `@earendil-works/pi-coding-agent@1.3.0` (`pi --version` → `1.3.0`).
Everything below was observed on this machine unless marked `[INFERENCE]` or `[NOT VERIFIED]`. The user is not signed in to any provider. Model output comes from pi-ai's faux provider; one real provider call was made on purpose with an invalid Anthropic key.

## Setup

- `npm i @earendil-works/pi-coding-agent@1.3.0 --save-exact` in `~/.freedia/pi` (Node 21.7.3's npm): 118 packages in 5 s. The only issue was an `EBADENGINE` warning for `lru-cache@11.5.3` (needs Node 20 or ≥22), which made no difference: pi runs under Bun, not Node.
- **`bun add` no longer 404s.** In a fresh `/tmp` package, `bun add @earendil-works/pi-coding-agent@1.3.0` (Bun 1.4.3) ran "Resolved, downloaded and extracted [246]", installed 118 packages in 2.68 s, and created the `pi` bin. The `@aws-sdk/credential-provider-http` 404 the plan mentions did not happen.
- pi declares `"engines": {"node": ">=22.19.0"}` and `"bin": {"pi": "dist/bundle/cli.js"}`.
- `PI_CODING_AGENT_DIR=~/.freedia/pi-agent` was honoured: pi created `auth.json` (`{}`) and `models-store.json` there. `models-store.json` grew to 20 KB after the one run without `--offline` (model catalog refresh).
- Experiments ran with cwd `~/.freedia`, a fresh `mktemp` `--session-dir` per run, and all `*_API_KEY` / `*_TOKEN` env vars stripped (see "Env keys" below).

## Tooling added (all under `packages/helper/test/fixtures/pi/`)

- `faux-extension.ts`: a pi extension that registers pi-ai's `fauxProvider` as provider `faux` with models `faux-1` and `faux-2`. Its scripted replies depend on markers in the prompt:
  - `[[write]]` makes a `write` tool call; `[[read]]` makes an `ls` tool call.
  - `[[long]]` gives a ~23 KB reply; `[[ratelimit]]` returns an Anthropic-shaped 429 error.
  - `[[recall]]` lists every user and assistant turn the model was sent.
  - Anything else echoes `[<model>] faux reply to: <prompt>`.
  - Env: `FREEDIA_FAUX_TPS` sets streaming speed (default 400 tokens/s; `0` means as fast as possible). `FREEDIA_FAUX_CONTEXT` sets the context window (default 128000).
- `record.ts`: the scenario driver that produced every fixture and number in this note. It spawns `[process.execPath, cli.js, "--mode", "rpc", …]` with `BUN_BE_BUN=1`, as the helper will. Run it with `bun packages/helper/test/fixtures/pi/record.ts [--write-fixtures] [scenario…]`.
  - It writes fixtures only with `--write-fixtures` (into this folder) or `FREEDIA_FIXTURE_DIR=<dir>`; by default it only prints results.
  - It deletes its temp `--session-dir` on exit.
- `*.jsonl` fixtures: one line per record, `{"t": <ms since spawn>, "dir": "stdin"|"stdout"|"stderr"|"exit", "record": <parsed JSON | stderr string | {code}>}`. A fake pi can replay `stdout` records once it has seen the matching `stdin` record.
  - Machine-specific values are scrubbed when saving: the temp session dir becomes `$TMP/freedia-s1`, other temp paths `$TMP`, this folder `$FIXTURES`, the home dir `$HOME`, and Anthropic request ids `req_PLACEHOLDER`. The record shapes are not changed.

| Fixture                       | What it captures                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `stream.jsonl`                | `get_state` → `prompt` streaming → `get_messages` → `get_available_models`                             |
| `tools-readonly.jsonl`        | model calls `write` (blocked: `Tool write not found`), then `ls` (allowed)                             |
| `bash-command.jsonl`          | RPC `bash` command runs a shell despite `--tools read,grep,find,ls`                                    |
| `abort.jsonl`                 | `abort` mid-reply, then `get_messages` showing the kept partial                                        |
| `abort-resume.jsonl`          | respawn after the abort: `get_messages` + a follow-up that sees the partial in context                 |
| `prompt-while-streaming.jsonl`| second `prompt` during a run is rejected; then `abort` with an empty partial                           |
| `set-model.jsonl`             | `set_model` mid-session (success + unknown model failure), next reply from the new model with history  |
| `resume-create.jsonl` / `resume-continue.jsonl` | create a chat, exit, respawn with the same `--session-id`, full context kept         |
| `resume-other-cwd.jsonl`      | same `--session-id`, different cwd → empty new session                                                  |
| `session-name.jsonl`          | `set_session_name` → `session_info_changed` event, `get_state.sessionName`                             |
| `model-override-1-set-model.jsonl` / `-2-resume-with-model-flag.jsonl` / `-3-resume-without-flag.jsonl` | `set_model faux-2`; a resume with `--model faux/faux-1` that gets a reply; a later resume without `--model` stays on faux-1 |
| `session-id-too-long.jsonl`   | 300-char session id: `prompt` accepted, reply fails with `ENAMETOOLONG`, no file written                 |
| `rate-limit.jsonl`            | 429 → three auto-retries (2 s, 4 s, 8 s) → final failure                                                 |
| `rate-limit-abort.jsonl`      | `abort` during the retry wait                                                                           |
| `provider-rejected-401.jsonl` | **real** Anthropic call with an invalid key → 401 error message                                         |
| `not-signed-in-no-model.jsonl`| no credentials, no `--model`: `get_state`, empty `get_available_models`, `prompt` rejected              |
| `not-signed-in-anthropic.jsonl` | no credentials, `--model anthropic/claude-sonnet-4-5`: `prompt` rejected                              |

## Bun

- **Bun 1.4.3 runs pi 1.3.0 in RPC mode without problems.** Across every scenario, stderr only ever contained `Warning: No project session found with id '<id>'; creating a new session with that id.` (once per new chat). There were no crashes, no Bun-specific errors and no hangs. **No Node fallback needed.**
- **Compiled binary:**
  - `bun build --compile record.ts` produced a 70.9 MB binary. Inside it, `process.execPath` is the binary itself (`/private/tmp/s1-compiled/rec`).
  - Spawning `[process.execPath, <pi>/dist/bundle/cli.js, "--mode", "rpc", …]` with `BUN_BE_BUN=1` ran pi, and every scenario gave the same results as plain `bun` (stream, tools, bash, abort, set_model, resume, respawn timings).
  - `BUN_BE_BUN=1 ./rec --version` prints `1.4.3`.
  - Without `BUN_BE_BUN`, the same spawn ran the binary's own entry point (the recorder) and ignored the pi path. The variable is required.
- pi child processes inherit `BUN_BE_BUN=1`. `[INFERENCE]` This does not matter for the read-only tool set, which spawns nothing.

## Timings and memory

Times are spawn → first RPC response (`get_state`), measured in-process.

| Case                                                      | First response        | `get_messages` done | RSS                    |
| --------------------------------------------------------- | --------------------- | ------------------- | ---------------------- |
| New chat (`bun`)                                          | 116–126 ms (first run of a batch 180–207 ms) | n/a                 | n/a                     |
| New chat (compiled binary)                                | 121–126 ms            | n/a                 | n/a                     |
| Resume, 30 turns, 838 KB file                             | 121–136 ms            | 122–138 ms          | 107–110 MB idle        |
| Resume, 200 turns, 5.56 MB file (8 KB page text + 23 KB reply per turn) | 127–177 ms | 147–295 ms          | 110–140 MB idle        |
| Resume among 1,000 session files in the dir (measured from Python, includes its spawn overhead) | 157–158 ms (first 457 ms, cold) | n/a | n/a |
| New id among 1,000 session files                          | 147–148 ms            | n/a                 | n/a                     |
| While streaming a reply (fresh chat)                      | n/a                   | n/a                 | 104–106 MB             |

Conclusions:
- Long histories do not slow respawn noticeably, so **no idle timeout is needed**: exit at `agent_settled`.
- Memory per process is ~105–140 MB, more than the plan's 91 MB.
- `--session-id` lookup reads the header of every `.jsonl` in `--session-dir` (`SessionManager.findById`). 1,000 chats added ~30 ms.

## RPC protocol (pi 1.3.0)

Framing is strict JSONL on stdin and stdout. Split only on `\n`: pi's docs warn that Node `readline` also splits on U+2028/U+2029. Every command takes an optional `id`, and the reply is `{"id","type":"response","command","success",("data"|"error")}`. Events carry no `id`. Closing stdin makes pi exit with code 0 (observed in every scenario).

### `prompt` streaming (`stream.jsonl`)

```
{"id":"r2","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"system","content":"","sections":{…},"toolsAdded":[…]}}   ← first run of a session only
{"type":"message_end","message":{"role":"system",…}}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"hello from freeDia"}],"timestamp":…}}
{"type":"message_end","message":{"role":"user",…}}
{"type":"message_start","message":{"role":"assistant","content":[],"api","provider","model","usage":{…},"stopReason":"pending","timestamp"}}
{"type":"message_update","usage":{…},"assistantMessageEvent":{"type":"text_start","contentIndex":0}}
{"type":"message_update","usage":{…},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"[faux-1] faux "}}
…
{"type":"message_update","usage":{…},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"<full text>"}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"…"}],…,"stopReason":"stop","durationMs":…,"thinkingLevel":"off"}}
{"type":"turn_end","message":{…assistant…},"toolResults":[]}
{"type":"agent_end","messages":[…every message of this run, including the system message on a first run…],"willRetry":false}
{"type":"agent_settled","aborted":false}
```

- Wire `message_update` records are deltas only, with no cumulative `partial`. The UI must accumulate `delta` per `contentIndex`, then replace the result with `text_end.content` / `message_end.message`.
- **A `role: "system"` message is emitted** (with the full system prompt and tool declarations) on a session's first run. Per `docs/session-format.md` it is emitted again whenever the prompt or tools change (not observed). The UI must not render `system` messages, and `get_messages` returns them too.
- Thinking models also emit `thinking_start/_delta/_end` `[NOT VERIFIED here: faux models are non-reasoning]`.
- **End-of-run event: `agent_settled`** (`{"type":"agent_settled","aborted":bool}`). `agent_end` can be followed by retries (see rate limit), so it is not the end.

### Tool events (`tools-readonly.jsonl`)

```
{"type":"message_update",…"assistantMessageEvent":{"type":"toolcall_start","contentIndex":1,"id":"tool:…","toolName":"write"}}
{"type":"message_update",…"assistantMessageEvent":{"type":"toolcall_delta","contentIndex":1,"delta":"{\"path\":\"fre"}}
{"type":"message_update",…"assistantMessageEvent":{"type":"toolcall_end","contentIndex":1,"toolCall":{"type":"toolCall","id":"tool:…","name":"write","arguments":{…}}}}
{"type":"message_end","message":{"role":"assistant",…,"stopReason":"toolUse"}}
{"type":"tool_execution_start","toolCallId":"tool:…","toolName":"write","args":{…}}
{"type":"tool_execution_end","toolCallId":"tool:…","toolName":"write","result":{"content":[{"type":"text","text":"Tool write not found"}],"details":{}},"isError":true}
{"type":"message_start"/"message_end","message":{"role":"toolResult","toolCallId":"tool:…","toolName":"write","content":[…],"isError":true,…}}
{"type":"turn_end",…} {"type":"turn_start"} …next assistant message…
```

An allowed tool (`ls`) ends with `"isError":false,"durationMs":0` and the listing text.

### `abort` (`abort.jsonl`, `prompt-while-streaming.jsonl`)

`{"id":"r2","type":"abort"}`, then: `message_end` (assistant, `"stopReason":"aborted"`, `"errorMessage":"Request was aborted"`, content = the text streamed so far) → `turn_end` → `agent_end` → `{"type":"agent_settled","aborted":true}` → `{"id":"r2","type":"response","command":"abort","success":true}`. **The abort response arrives after `agent_settled`.**

**The partial reply is kept.** It is persisted as an assistant message with `stopReason:"aborted"`. `get_messages` returns it, both in the same process and after a respawn. On the next prompt it is sent to the model as context: after the respawn, the `[[recall]]` reply listed `user:"write something [[long]]", assistant:"[faux-1] Sentence 1 of a deliberately lo", user:"after abort [[recall]]"`. Aborting before any text arrived persisted `content:[{"type":"text","text":""}]`.

A second `prompt` during a run is rejected: `{"id":"r2","type":"response","command":"prompt","success":false,"error":"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."}`. The extension must disable send while a run is active, or send `abort` first.

### `set_model` mid-session (`set-model.jsonl`)

- Success: `{"id":"r2","type":"response","command":"set_model","success":true,"data":{<Model>}}`. No event is emitted. The session file gains a `{"type":"model_change","provider":"faux","modelId":"faux-2"}` entry.
- Unknown model: `{"id":"r3",…,"success":false,"error":"Model not found: faux/does-not-exist"}`.
- The next reply came from `faux-2` and saw the earlier turns: `[faux-2] I can see 3 turns: user:"first on faux-1", assistant:"[faux-1] faux reply to: first on faux-1", user:"second on faux-2 [[recall]]"`.
- **On respawn, `--model` overrides the session's model, and the override sticks once a reply is made** (`model-override-*.jsonl`, chat `c-model-2`):
  1. `set_model faux-2` → `get_state` faux-2. The file has `model_change` entries `[faux-1, faux-2]`.
  2. Resume with `--model faux/faux-1` and no prompt → `get_state` faux-1. No `model_change` is written. A later resume without `--model` → faux-2 (the override was not saved).
  3. Resume with `--model faux/faux-1` and a prompt → the reply comes from faux-1. Still no new `model_change` entry (`[faux-1, faux-2]`).
  4. Resume **without** `--model` after step 3 → `get_state` faux-1, and the next reply also comes from faux-1. The user's `set_model faux-2` is lost for good.
  - Source (`getSessionContextSettings` in pi's bundle): on resume, the model is whichever comes last on the branch, a `model_change` entry or an assistant message's `provider`/`model`. A reply under `--model` therefore becomes the chat's saved model.
  - **Requirement for 1A (and its tests): a resumed spawn must never pass `--model`.** Pass it only when the chat has no session file yet. Test: create a chat, `set_model` to B, settle, exit; respawn (fake pi or real faux) and assert the spawn args contain no `--model` and that `get_state` reports B.

### `get_available_models`

`{"…","command":"get_available_models","success":true,"data":{"models":[<Model>…]}}`. A Model is `{id,name,api,provider,baseUrl,reasoning,input,cost,contextWindow,maxTokens,(compat),(thinkingLevelMap),type?}`. It lists only providers that have credentials:
- Faux only: `faux/faux-1`, `faux/faux-2`.
- No credentials and no extension: `"models":[]`.
- With `GROQ_API_KEY` in the env: the Groq catalog.

### `get_messages`

`{"…","command":"get_messages","success":true,"data":{"messages":[…]}}`. The array includes the `system` message, `user`, `assistant` (with `stopReason`, `errorMessage`, `usage`, `model`) and `toolResult` messages.

### `get_state`

`data` = `{model, thinkingLevel, isStreaming, isCompacting, steeringMode, followUpMode, sessionFile, sessionId, sessionName?, autoCompactionEnabled, messageCount, pendingMessageCount}`. With no usable model, `model` is a placeholder: `{"id":"unknown","name":"unknown","api":"unknown","provider":"unknown",…}`.

### RPC `bash` (`bash-command.jsonl`)

It exists and **runs a shell even with `--tools read,grep,find,ls --no-extensions`.** The marker file was created. Output:

```
{"type":"bash_execution_update","id":"r1","delta":"done\n"}
{"id":"r1","type":"response","command":"bash","success":true,"data":{"output":"done\n","exitCode":0,"cancelled":false,"truncated":false}}
```

The helper must drop it, as the plan says.

### Full RPC command list (from `docs/rpc-commands.md`, pi 1.3.0)

`prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`, `get_state`, `get_messages`, `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels`, `set_steering_mode`, `set_follow_up_mode`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash`, `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `get_last_assistant_text`, `set_session_name`, `get_commands`, plus `extension_ui_response`. Malformed JSON gets `{"type":"response","command":"parse","success":false,"error":"Failed to parse command: …"}` (from docs; not exercised).

## Errors

### Not signed in (observed)

Not-signed-in is **not an event**. The `prompt` command itself fails, and no run starts (no `agent_start`, no `agent_settled`):
- No credentials and no `--model`: `get_state.model.id` is `"unknown"`, `get_available_models` is `[]`, and `prompt` → `{"id":"r3","type":"response","command":"prompt","success":false,"error":"No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n  <pi>/docs/providers.md\n  <pi>/docs/models.md"}`.
- `--model anthropic/claude-sonnet-4-5` with no credentials: `get_state` succeeds with the Anthropic model, and `prompt` → `success:false`, `"error":"No API key found for anthropic.\n\nUse /login …"`.
- Preflight without RPC: `pi auth check --provider anthropic --json` prints `{"status":"not_ready","provider":"anthropic","reason":"credentials_not_configured"}` and exits 1. Same for `openai-codex` and `groq`. With `GROQ_API_KEY` set, it prints `{"status":"ready","provider":"groq","authType":"api_key"}` and exits 0. `pi --list-models` with no credentials prints `No models available. Use /login …`.

### Provider rejected (observed, real network call)

Invalid `ANTHROPIC_API_KEY` (`provider-rejected-401.jsonl`): the prompt is accepted, then `message_end`/`turn_end` carry an assistant message with `"content":[]`, `"stopReason":"error"`, `"errorMessage":"401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"},\"request_id\":\"req_…\"}"` → `agent_end` → `agent_settled{aborted:false}`. There was no retry.

### Rate limit (simulated with faux; retry behaviour observed, the real provider body comes from source)

- Faux returned `stopReason:"error"` with `errorMessage` `429 {"type":"error","error":{"type":"rate_limit_error",…}}`. That body is the Anthropic error shape, modelled on the real 401 above.
- pi treats it as retryable. The patterns are in `pi-ai/dist/utils/retry.js`, including `rate.?limit`, `too many requests`, `429`, `overloaded`, `5xx`. Quota/billing texts are non-retryable: `insufficient_quota`, `quota exceeded`, `billing`, `subscription_sharing_usage_limit_exceeded`, `Monthly usage limit reached`.
- Observed sequence (`rate-limit.jsonl`, 14.1 s total):
  1. `message_end` (assistant, `stopReason:"error"`) → `turn_end` → `agent_end`.
  2. `{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"429 …"}` → `{"type":"entry_appended","entry":{"type":"context_edit",…,"replacement":null}}`.
  3. `agent_start` … repeats for attempts 2 (4000 ms) and 3 (8000 ms).
  4. `{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"429 …"}` → `{"type":"agent_settled","aborted":false}`.
- `abort` during the retry wait (`rate-limit-abort.jsonl`): `{"type":"auto_retry_end","success":false,"attempt":1,"finalError":"Retry cancelled"}` → `{"type":"agent_settled","aborted":true}` → abort response. **The stop button works during retries.**
- The session file keeps every failed assistant message plus a `context_edit` entry that removes it from model context.
- The real wire text for OpenAI/Google 429s was not observed `[NOT VERIFIED]`. The UI should classify on `stopReason:"error"`, plus `auto_retry_start`/`auto_retry_end` for "retrying…".

## Sessions (`--session-dir` + `--session-id`)

### Files

- **Naming:** `<session-dir>/<ISO timestamp, ':' and '.' → '-'>_<sessionId>.jsonl`, e.g. `2026-10-19T23-01-40-792Z_c-resume-1.jsonl`. The dir is flat (no per-cwd subfolder when `--session-dir` is given). The timestamp contains no `_`, so the id is everything after the first `_`, minus `.jsonl`.
- **Created lazily:** no file exists until the first message is persisted. Runs that only did `get_state` or `bash` left no file, although `get_state.sessionFile` already reports the future path.
- **Header line:** `{"type":"session","version":3,"id":"<sessionId>","timestamp":"…","cwd":"/Users/aaron/.freedia"}`. It is followed by `model_change`, `thinking_level_change` and `message` entries (system, user, assistant, toolResult), plus `session_info` / `context_edit` entries.

### Resume and cwd

- **Resume after exit with full context:**
  - Chat `c-resume-1` was created, the process exited, and the chat was respawned with the same `--session-id`.
  - `get_state.messageCount` was 3 (system + user + assistant). The next reply saw both earlier turns: `I can see 3 turns: user:"remember the word pineapple", assistant:"…", user:"what word? [[recall]]"`.
  - The same held in the compiled binary.
- **cwd matters.** `SessionManager.findById` scans `--session-dir` and, for a custom session dir, requires `header.cwd === spawn cwd`. Respawning the same id from `$TMPDIR` printed the "No project session found" warning and gave an empty session (`messageCount 0`, `get_messages` → `[]`). That run made no prompt, so it wrote no file; a prompt would have created a second file with the same id `[INFERENCE from lazy creation + create path]`. pi's cwd must stay fixed at `~/.freedia`, and the helper must never let it change.

### Title (for `chat.list`)

- pi's own session list (`buildSessionInfo`) uses the latest `session_info.name` if present, otherwise the text of the first user message. `modified` is the latest message `timestamp`, falling back to the header timestamp, then file mtime.
- Because freeDia's first user message starts with URL/title/quotes/page text, the first-message fallback would make every title "URL: …".
- **`set_session_name`** (`session-name.jsonl`) is the clean way to set a title:
  - `{"type":"set_session_name","name":"Example Domain"}` → `{"type":"session_info_changed","name":"Example Domain"}` → `{"…","command":"set_session_name","success":true}`.
  - It persists a `{"type":"session_info",…,"name":"Example Domain"}` entry, and `get_state.sessionName` reports it.
  - `--name <name>` does the same at launch.

### Session id characters

pi rejects bad ids at startup: the process exits with code 1 before any RPC output, and stderr reads `Error: Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character`.
- Accepted: `c_01JABCDEF`, `c-01JABCDEF`, `c.01J`, `01JABCDEFGHJKMNPQRSTVWXYZ0`.
- Rejected: `-lead`, `trail-`, `has space`, `a/b`, `ü-unicode`.
- **No length limit in pi.** Ids of any length pass the character check, but the session file name `<24-char timestamp>_<id>.jsonl` hits the macOS 255-byte file-name limit:
  - Ids up to 224 characters worked: the file was written.
  - At 225 and 300 characters, `get_state` and `prompt` still succeed (`disposition:"started"`). The run then ends with an assistant `message_end` `stopReason:"error"`, `errorMessage: "ENAMETOOLONG: name too long, open '<session-dir>/<timestamp>_<id>.jsonl'"` (empty content, zero usage) → `agent_settled{aborted:false}`. No file is written, so the chat is lost on exit (`session-id-too-long.jsonl`). `[INFERENCE]` The model was not called, given the zero usage.
  - The helper must cap chatId length itself.
- The plan's `c_01J…` (underscore + ULID) is therefore valid. Proposed format: `c_` + 26-char Crockford ULID, validated by the helper with `^c_[0-9A-HJKMNP-TV-Z]{26}$` (28 chars, well under 224). It sorts by creation time and splits unambiguously out of the file name.

## Read-only tools

- With `--tools read,grep,find,ls --no-extensions`, the system prompt's `<tools>` section lists only `read`, `grep`, `find`, `ls`. The preamble still says "executing commands, editing code, and writing new files", so the freeDia `--append-system-prompt` should state the agent is read-only.
- A faux `write` tool call got `tool_execution_end … "isError":true … "Tool write not found"`, and `~/.freedia/freedia-should-not-exist.txt` was not created. `ls` ran normally.
- `--no-extensions` disables discovered, configured and built-in extensions (MCP included) per `docs/cli.md`, but explicit `-e` paths still load (the faux extension relies on this). Blocking MCP with a configured MCP server was **[NOT VERIFIED]**: none is configured in `~/.freedia/pi-agent`. Adding `--no-mcp` is free and makes it explicit.
- The RPC `bash` command bypasses all of this (see above).

## Faux provider for e2e

- pi has no built-in CLI flag for faux. It works as an extension: `-e <repo>/packages/helper/test/fixtures/pi/faux-extension.ts --model faux/faux-1 --offline`.
- The extension imports `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`, which pi's extension loader resolves from its bundle. That was observed working with pi installed in `~/.freedia/pi` and the extension living in the repo.
- Combined with `--no-extensions`, only the explicit `-e` loads.
- Provider/model id: `faux/faux-1`, `faux/faux-2`. Auth needs nothing: the provider resolves an empty auth, so the "No API key" check passes.
- Streaming speed is controlled by `FREEDIA_FAUX_TPS` in pi's env. The helper must pass its env through to pi.
- For e2e, the helper needs a test-only way to add `-e <faux-extension>` and `--offline` to the pi launch (see amendments).

## Env keys

pi resolves provider API keys from the environment. `GROQ_API_KEY` from the user's shell made Groq models appear and Groq became the default model, even with an empty `auth.json`.
- `[INFERENCE]` Chrome launches the native host with the browser's (launchd) environment, not a login shell, so shell-exported keys will usually not be present. Behaviour could still differ between `freedia doctor` run from a terminal and real use.
- Preflight and docs should say sign-in goes through `~/.freedia/pi-agent` (pi `/login`).

## Contract amendments

Proposed changes to `plans/freedia-plan.md` (not applied):

1. **Environment prerequisites:**
   - Replace "`bun add` currently 404s on `@aws-sdk/credential-provider-http@3.972.77`" with "`bun add @earendil-works/pi-coding-agent@1.3.0` works with Bun 1.4.3 (re-tested 2026-10-19)".
   - Change "idle pi RPC process ~91 MB RSS; spawn → first RPC response ~180 ms" to "~105–140 MB RSS (idle or streaming); spawn → first RPC response ~120 ms warm, ~180–210 ms first run; resuming a 200-turn 5.6 MB session ~130–180 ms".
   - In task 1A Installer, drop the "vendor `dist/bundle`" fallback.
2. **Forwarded commands table:**
   - Add `set_session_name` ("chat title, shown in history; also used by pi's own session list").
   - Keep `prompt`, `abort`, `set_model`, `get_available_models`, `get_messages`, `get_state`.
3. **"Blocked on purpose":** the final list is every other pi 1.3.0 command:
   - `bash`, `abort_bash`, `steer`, `follow_up`, `clear_queue`, `new_session`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `export_html`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `set_steering_mode`, `set_follow_up_mode`, `cycle_model`, `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels`, `get_session_stats`, `get_last_assistant_text`, `get_commands`, `extension_ui_response`.
   - State that S1 observed RPC `bash` executing a shell with `--tools read,grep,find,ls`.
4. **chatId format:**
   - Replace "(letters, numbers, `-`; …)" with "`c_` + 26-char ULID (`^c_[0-9A-HJKMNP-TV-Z]{26}$`). pi accepts `[A-Za-z0-9._-]`, starting and ending alphanumeric, and exits with code 1 otherwise. pi has no length limit, but ids over 224 characters fail with `ENAMETOOLONG` on the first save and the chat is never written. The helper validates format and length before spawning and answers `helper.error` `spawn_failed` for an invalid id."
5. **Chats = pi sessions:**
   - Add: "Session file = `~/.freedia/chats/<timestamp>_<chatId>.jsonl` (flat dir, created on the first message, so a chat that never got a message has no file and is not listed). `chat.list` reads each file's header (`id`) and entries:
     - `title` = latest `session_info.name`, else the first user message's question line;
     - `updatedAt` = latest message `timestamp`.
   - `chat.delete` removes the file matching `*_<chatId>.jsonl`. Deleting a chat whose pi process is running: the helper aborts and stops that process first."
   - Add: "pi matches `--session-id` against the session header's `cwd`. A different cwd silently starts an empty chat with the same id, so the fixed `~/.freedia` cwd is load-bearing."
6. **pi launch:**
   - Pass `--model <id>` **only when the chat's session file does not exist yet. A resumed spawn must never pass `--model`.** Otherwise `--model` overrides the session's model, and after one reply it replaces the user's `set_model` choice permanently (see the `set_model` section). 1A must test this.
   - Add `--no-mcp` and `--no-themes`.
   - Set `env BUN_BE_BUN=1` (required: without it the compiled helper re-runs itself).
   - Test-only: the helper accepts extra pi args from `FREEDIA_PI_EXTRA_ARGS` (or a test config) so e2e can add `-e <faux-extension.ts> --offline --model faux/faux-1`. Keep it unset in production.
7. **Run lifecycle / pool:**
   - Exit trigger is `agent_settled` (`{"type":"agent_settled","aborted":bool}`), not `agent_end`.
   - The `abort` response arrives after `agent_settled{aborted:true}`. The helper must forward it and only then close pi's stdin, which makes pi exit with code 0.
   - No idle timeout needed (respawn of a 200-turn session ≈ 130–180 ms).
   - Memory line: "~105–140 MB per pi process, so at most 3 × ~140 MB ≈ 0.4 GB".
8. **Stop a reply:**
   - Replace "Whether the half-finished reply is kept in the session is checked in S1" with "The partial reply is kept: persisted as an assistant message with `stopReason: "aborted"`, shown by `get_messages`, and sent to the model as context on the next prompt."
   - Add: "`abort` also cancels a pending auto-retry (`auto_retry_end` `finalError: "Retry cancelled"`)."
   - Add: "A `prompt` sent while a run is active is rejected by pi (`success:false`, 'Agent is already processing…'). The UI disables send during a run."
9. **`helper.error` / error handling:**
   - Not-signed-in is a failed `prompt` response (`success:false`, `error` starting `No API key found for …`), not an event. The helper forwards it untouched, and the UI maps that prefix to the not-signed-in fix text.
   - Helper preflight uses `pi auth check --provider <p> --json` (`status: ready|not_ready|invalid`, exit 0/1/2) for `not_signed_in`.
   - Provider rejections and rate limits arrive as an assistant `message_end` with `stopReason:"error"` + `errorMessage` (e.g. `401 {…authentication_error…}`, `429 {…rate_limit_error…}`). Retryable errors are preceded by `auto_retry_start` / `auto_retry_end` events (3 attempts, 2/4/8 s).
10. **UI rendering note (1C):** ignore `role: "system"` messages in events and `get_messages`. Build streaming text from `message_update.assistantMessageEvent` deltas keyed by `contentIndex`, and replace it with `message_end.message`.
11. **Bun:** "Any Bun incompatibility → Node fallback" can be removed. S1 found none with Bun 1.4.3 (plain and compiled `BUN_BE_BUN=1`).
