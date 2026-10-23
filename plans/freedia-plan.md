# freeDia — Initial Implementation Plan

Spec: `notes/freedia.md` · Architecture: `diagrams/initial-pi-ai-integration.md` · Commits and PRs follow `CONTRIBUTING.md`.

Repo: `freeDia/` (new, bun workspaces monorepo). Packages:

```
freeDia/
  packages/helper/     # Bun native-messaging host (compiled binary): pipe to omp, process pool, installer (bunx freedia install)
  packages/extension/  # WXT + React + Tailwind MV3 extension (UI only)
  e2e/                 # Playwright: Chromium + unpacked extension + real helper + omp faux provider
```

Principle: **the extension is UI only and the helper is a plain pipe.** omp owns the conversation (context, follow-ups, model switching, compaction, sessions, tools). freeDia adds only what omp doesn't have: routing per chat, a process pool, and listing/deleting chats.

Defaults decided here: page text = main content as markdown, excerpt sized to 10% of the model's context window and centered on any highlight, full page available to omp as a temporary file (see Page text); macOS first.

Decided 2026-10-19:
- **Separate pi setup.** freeDia runs pi with its own agent dir (`PI_CODING_AGENT_DIR=~/.freedia/pi-agent`): its own sign-ins and settings, and none of the user's pi extensions, skills, prompt templates or AGENTS.md files.
- **Thinking level:** pi's default (medium).
- **Tab navigates to a new page:** same chat continues; the new page's URL and text are sent with the next message.
- **Helper/extension version mismatch:** helper auto-updates itself; the extension shows "Update helper" only as a fallback (see Updates).

Decided 2026-10-20:
- **chatId = lowercase UUID v4** from `crypto.randomUUID()`; it is the pi session ID (see Contract).
- **No warm pool (plan A).** pi exits after every reply and is respawned per message with `--session-id`. Dia's agent server does the same with the Claude Agent SDK (`--resume` per request; no model process alive while idle). Revisit only if respawn becomes noticeable.
- **Page text** as in the Page text section: excerpt (10% of context window, 2k–20k tokens, 75/25 or centered on the highlight) kept in the chat; full page as a temporary file. A changed page gets a new excerpt and file; an unchanged page after 30 quiet minutes or a reconnect gets the file only; a new highlight on the same page gets only the window around it.
- **No Dia detection; onboarding picks the shortcut.** First run offers ⌘E as the default shortcut, or the user picks another; ⇧⌘E always works too. The extension can't see which browser it's in (Dia reports itself as Chrome); the helper can, but it isn't needed. Findings in `notes/research-dia-detection.md`.
- **Native host manifest:** one file in Chrome's `NativeMessagingHosts` folder; Dia reads it from there.

Decided 2026-10-23:
- **Replace pi with omp** (`@oh-my-pi/pi-coding-agent`, a pi descendant with the same `--mode rpc` JSONL protocol; `notes/spike-omp-rpc.md` is the evidence record). Reasons: subscription OAuth logins out of the box (ChatGPT/Codex, Claude Pro/Max, GLM Coding Plan, Kimi, …), Bun-native (`engines.bun >=1.3.14`, no Node path at all), `open_session` host-binding designed for embedders, automatic session-model restore on resume, and lossless v2 `rpc_chunk` framing. Supersedes the pi-specific parts of the 2026-10-19/20 decisions: the agent dir is now `~/.freedia/omp-agent`, `chatId` names a per-chat session **directory** (omp generates its own session id), and resume passes no `--model`.

## Environment prerequisites

- Bun ≥ 1.4 for development. omp declares `engines.bun >=1.3.14`; verified under Bun 1.4.3 (omp 18.12.1): the whole spike — five process lifecycles covering stream, resume, abort, unauthenticated `set_model`, and a blocked write tool — ran in ~6 s wall. omp also runs from inside the `bun build --compile` helper with `BUN_BE_BUN=1` (pi-equivalent path verified in S1; re-verified for omp in 3.1). A real omp process streaming against the faux provider measured **86,176 KiB RSS (~84 MiB)**.
- No Node at runtime and no Node fallback: omp is Bun-native and the spike found no incompatibility.
- omp pinned at 18.12.1. `bun add @oh-my-pi/pi-coding-agent@18.12.1` (bin `dist/cli.js`). Signed in to at least one provider for manual testing (`omp login <provider>`).
- Chrome is not installed; Dia is. Automated tests use Playwright's bundled Chromium. Dia used for manual Cmd+E checks.

## Contract (frozen after Bucket 0)

Transport: extension service worker ↔ helper over `chrome.runtime.connectNative("com.freedia.helper")` (length-prefixed JSON, 1 MB host→extension message limit). Content script/UI ↔ service worker over `chrome.runtime.Port`.

**Envelope.** Every message carries the chat it belongs to; the body is an omp RPC record, unchanged.

```jsonc
// ext → helper
{ "chatId": "3f2a9c1e-8b4d-4e6f-a0b1-c2d3e4f5a6b7", "rpc": { "id": "r1", "type": "prompt", "message": "…" } }
// helper → ext (omp responses and events, untouched)
{ "chatId": "3f2a9c1e-8b4d-4e6f-a0b1-c2d3e4f5a6b7", "rpc": { "type": "message_update", … } }
```

**Forwarded omp RPC commands (allowlist; everything else is dropped):**

| omp command                         | Used for                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                             | Send a message (first message or follow-up). omp keeps all earlier turns.                                                                         |
| `abort`                              | Stop the current reply                                                                                                                            |
| `set_model` / `get_available_models` | Model picker, switch mid-chat                                                                                                                     |
| `get_messages`                       | Render a reopened chat                                                                                                                            |
| `get_state`                          | Status (model, streaming, etc.)                                                                                                                   |

Blocked on purpose: every other omp 18.12.1 command: `bash` (verified again under omp 2026-10-23: it runs a real shell even with `--tools read,grep,glob`, and the run is recorded into the session as a user message), `abort_bash`, `steer`, `follow_up`, `remove_queued_message`, `promote_queued_message`, `abort_and_prompt`, `abort_and_restore_queue`, `new_session`, `switch_session`, `open_session` (helper-only: it binds the chat's directory), `branch`, `fork`, `get_branch_messages`, `get_entries`, `get_tree`, `get_messages_page`, `export_html`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode`, `cycle_model`, `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels`, `get_session_stats`, `get_last_assistant_text`, `handoff`, `goal`, `set_fast_mode`, `set_slow_mode`, `set_ask_dialog`, `set_todos`, `set_host_tools`, `set_host_uri_schemes`, `set_subagent_subscription`, `set_event_filter`, `get_subagents`, `get_subagent_messages`, `cancel_subagent`, `steer_subagent`, `predict_word`, `predict_word_feedback`, `btw`, `btw_cancel`, `get_btw_history`, `set_cache_warming`, `login`, `logout`, `get_logout_accounts`, `get_login_providers` (helper-only, for preflight/onboarding), `negotiate_protocol` (helper-internal), and `extension_ui_response`. `set_session_name` is also blocked for the extension; only the helper sends it, for chat titles.

**Helper's own commands (no `rpc` field; omp has no equivalent):**

Requests from the extension carry a string `id`; the helper echoes it on the reply (or on a `helper.error` answering that request). Pushes carry no `id`.

| type                               | Payload → reply                                                         | Purpose                                        |
| ---------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| `helper.hello`                     | `{ id, maxConcurrent }` → `{ id, helperVersion, ompVersion }`          | Detect missing/outdated helper; passes the user's concurrency setting |
| `chat.list`                        | `{ id }` → `{ id, chats: [{ chatId, title, updatedAt }] }`              | History panel. `updatedAt` is an ISO 8601 string. `title` is the freeDia title (see Chat titles), else the first 8 words of the first question |
| `chat.delete`                      | `{ id, chatId }` → `{ id, chatId }`                                     | Delete a chat                                  |
| `chat.status` (helper → ext, push) | `{ chatId, state }`, where `state` is `starting` or `queued`            | Loading indicator before omp's own events begin |
| `helper.error` (helper → ext)      | `{ id?, chatId?, code, message, fix }`; `id` set when it answers a request | `omp_missing`, `not_signed_in`, `spawn_failed`. Provider errors (rejected, rate limited) arrive as omp's own error results/events, untouched. |
| `page.put`                         | `{ id, chatId, markdown }` → `{ id, chatId }`                           | Write/replace the chat's temporary full-page file (see Page text) |
| `page.clear`                       | `{ id, chatId }` → `{ id, chatId }`                                     | Delete it (new chat, tab closed). `chat.delete` also deletes it |
| `helper.chunk` (helper → ext)      | `{ chatId?, chunkId, index, count, data }`; `data` is base64 of a ≤ 700,000-byte slice | Any helper → extension message over 1 MB (e.g. `get_messages` on a long chat) is sent as ordered chunks of its UTF-8 JSON bytes; the extension concatenates the decoded bytes, parses them and handles the result as the original message. `chatId` is copied from the original when it has one |

Exact JSON for each is pinned in `packages/helper/src/protocol.test.ts`.

**Size caps (extension → helper).** Both are refused with `helper.error` `spawn_failed`; no separate error code, since neither happens in normal use. The constants are `MAX_PAGE_BYTES` and `MAX_EXTENSION_MESSAGE_BYTES` in `protocol.ts`.
- `page.put` markdown over **5 MB** (UTF-8 bytes): the error carries the request's `id` and `chatId`, the chat's old page file is deleted, and the fix text says the chat keeps working from the excerpt. The extension still sends the excerpt in the message and skips the full-page file.
- Any native message over **8 MB**: skipped without being buffered, then answered with an error that has no `id` or `chatId` (the message was never parsed) and fix text "Try again with a shorter selection or message." Later messages are decoded normally.

**Chats = omp session directories.** `chatId` names a per-chat directory `~/.freedia/chats/<chatId>/`; omp generates and owns its own session id (UUID v7) inside it. There is still one freeDia ID, not two: the extension generates it with `crypto.randomUUID()` when a chat starts (a lowercase UUID v4, `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`) and the helper rejects anything else, since the ID becomes a path component. The helper binds a process to the chat with the `open_session` RPC command, which creates the session on first use and resumes it afterwards, so "open", "resume" and "reopen from history" are the same operation. Sessions live as `<timestamp>_<uuidv7>.jsonl` inside the chat's directory, separate from the user's own omp sessions. No freeDia chat file format; no IndexedDB cache. The helper never runs two omp processes on one chat directory: omp's cross-process session lease would move the session to a sibling file (it already guarantees one process per chat).

**omp launch (one process per active chat):**

```sh
env -i HOME=~/.freedia/home PATH=… PI_CODING_AGENT_DIR=~/.freedia/omp-agent BUN_BE_BUN=1 \
<bun> <omp>/dist/cli.js --mode rpc --no-ui \
  --cwd ~/.freedia \
  [--model <provider/model>] \
  --tools read,grep,glob \
  --no-extensions --no-skills --no-rules --no-lsp \
  --append-system-prompt "<freeDia rules>"
```

After the `ready` frame the helper sends `{ "id": "…", "type": "negotiate_protocol", "protocolVersion": 2 }` — lossless `rpc_chunk` framing for oversized frames, e.g. `get_messages` on a long chat — and then `{ "id": "…", "type": "open_session", "sessionDir": "~/.freedia/chats/<chatId>" }`. `<bun>` is the helper's own runtime (`process.execPath`); `BUN_BE_BUN=1` is required, or the compiled helper re-runs itself instead of omp. `HOME=~/.freedia/home` (created empty by the installer): omp loads `~/.env` and writes `~/.omp` logs/run state, so a freeDia-owned home keeps the user's real home out of the process; `PATH` stays because omp opens login URLs with `open`. The freeDia rules: answer about the page the user is on; the message carries a page excerpt, and the full page is at `~/.freedia/pages/<chatId>.md` (read it with `read`/`grep` when the excerpt isn't enough); read-only; only read `~/.freedia/chats` when the user explicitly asks about previous chats.

- **`--model` only on a fresh chat, never on resume.** New chat: the model the user picked (or omp's default when omitted). Resumed chat: no `--model` — omp restores the session's saved model itself (verified 2026-10-23: after `set_model faux/faux-1`, a fresh process bound with `open_session` reports the same model), so the pi-era `unknown`-model resume bug and its workaround are gone. Model changes mid-chat go through `set_model` only; omp persists them as `model_change` entries and restores them on every later resume. Exception: if the saved model can no longer be restored (sign-in removed, model renamed), `open_session` fails with `Could not restore model <provider/id>`; the helper surfaces that as a `helper.error`. When the user re-picks a model, the next bind sends `open_session { sessionDir, provider, modelId }`, using omp's recovery override without adding `--model` to the resumed process.
- **Clean environment.** omp eagerly loads `.env` files (project, agent dir, config root, `~/.env`) and reads provider keys from the environment, so the helper starts omp with only the variables above — `HOME` included — and no `*_API_KEY` / provider tokens. freeDia uses only its own sign-ins in `~/.freedia/omp-agent`, as decided for "separate setup".
- **Fixed cwd `~/.freedia`.** omp reads project settings from `<cwd>/.omp/`; a fixed freeDia-owned cwd keeps that settings layer ours and identical for every chat.
- **Test hook:** e2e writes a `models.yml` with a keyless `faux` provider (`baseUrl: http://127.0.0.1:<port>/v1`, `auth: none`) into the e2e agent dir and sets `FREEDIA_OMP_EXTRA_ARGS` (e.g. `--model faux/faux-1`); the faux model is a local OpenAI-compatible HTTP fixture, not an omp extension. Unset in production; never set by the extension.

**Page context is part of the message text.** The extension builds the `prompt` message: URL, title, highlighted quotes, page excerpt (only when re-sent, see Page text), then the question under a fixed `## Question` heading, so the helper can find it for titling. omp stores it like any message, so follow-ups and resumed chats keep it. The full page goes to the helper with `page.put`, never into the message.

**Chat titles.** Set once, by the helper, after the chat's first reply settles; never renamed later. Shown only in the history panel, never in the chat window.
1. The helper runs a one-shot `omp -p --no-session --no-title --no-tools --no-extensions --no-skills --no-rules --no-lsp [--model <provider/model>] "Title this chat in 8 words or fewer …"` under the chat-launch environment (answer text arrives on stdout; no session file), given the page title and the first question only, not the page text. The no-tools and isolation flags prevent page-title or question prompt injection from reaching tools or user customization.
2. It writes the result with omp's `set_session_name` (updated title slot in the session header; no user message is added): on a short-lived spawn of the chat's session if it's idle, or as the first command on its next spawn if the user already sent another message. That spawn follows the resume rule: no `--model`; omp restores the session's own model.
3. Over 8 words → cut to 8. Title call fails → no name is written, and `chat.list` falls back to the first 8 words of the first question.

**Stop a reply.** The stop button sends omp's `abort` command; the helper forwards it to that chat's omp process. omp answers with the `abort` response, then `prompt_result { status: "aborted", sessionSettled: true }`, then `session_settled`; the helper forwards all three and only then closes omp's stdin (omp exits 0). The half-finished reply is kept: saved as an assistant message with `stopReason: "aborted"`, returned by `get_messages`, and sent to the model as context on the next prompt. `abort` also cancels a pending auto-retry. omp queues a second `prompt` sent while a run is active (as a follow-up) instead of rejecting it the way pi did; the UI still disables send during a run, so what the user sees is unchanged.
An `abort` for a chat whose prompt is still `queued` or `starting` never reaches omp: the helper drops the queued prompt (or closes the just-spawned omp before the prompt is written) and answers with omp's own abort response shape, `{ chatId, rpc: { id, type: "response", command: "abort", success: true } }`, and no `prompt_result` / `session_settled`; the UI treats that response as the end of the run.

**Errors from omp (forwarded untouched; the UI maps them to fix text):**
- Not signed in: surfaces at `set_model` — `success: false`, `error: "Model not found: <provider>/<modelId>"` (an unauthenticated provider's models don't resolve) — not at prompt time; with no model configured omp auto-selects an available one, so a prompt can still succeed. Sign-in state therefore comes from `get_login_providers` (each provider reports `authenticated`), not from prompt failures.
- Provider rejected or rate limited: the turn ends with a `prompt_result { status: "error", error: { message, provider?, model?, httpStatus?, retryable } }` plus an assistant `message_end` with `stopReason: "error"` (message shapes are shared with pi; exact omp error shapes to be pinned from fixtures in 3.1). Retryable errors come after `auto_retry_start` / `auto_retry_end` events.

**Session files.** `~/.freedia/chats/<chatId>/<timestamp>_<uuidv7>.jsonl` (omp's own session id), plus a `.lock.os` sidecar while a process owns the session. The file is created only when the first message is saved: a chat with no message has no file and isn't listed. `chat.list` enumerates chat directories and reads each session file's header and entries: `title` = the header's title slot (written by `set_session_name`), else the first 8 words of the first question; `updatedAt` = latest entry timestamp. `chat.delete` stops that chat's omp first (abort, wait for exit), then deletes the whole `<chatId>` directory.

## Multiple chats at once

| Need                                   | How                                                                                                                                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Several chats running at the same time | One omp process per active chat (omp runs one session per process). The helper routes by `chatId`.                                                                                                                                                |
| Keep running when you switch tabs      | The process lives in the helper, not the tab. Events keep arriving and the UI catches up when you return.                                                                                                                                       |
| Limit load                             | Max **3** chats generating at once (setting). Extra prompts wait as `queued` and start when a slot frees.                                                                                                                                       |
| Pause / resume later                   | No warm pool. A chat's omp process exits as soon as its reply settles (`session_settled`, not `agent_end`: retries and compaction can follow `agent_end`) or is stopped. The session file stays. The next command respawns omp and re-binds with `open_session`, which reloads the full context. Respawn cost is on pi's measured order (~120–180 ms even for a 200-turn chat), small next to the model's own first-token delay, so no idle timeout. |
| Survive browser restart                | Same as resume: sessions are files; the tab → chatId map is in `chrome.storage.local`.                                                                                                                                                          |

Memory: measured **~84 MiB RSS per omp process** (86,176 KiB while streaming against the faux provider), only while a chat is generating, so at most 3 × ~84 MiB ≈ 252 MiB. Nothing stays resident between messages.

## Updates (one package, both pieces stay current)

- **Install:** `bunx freedia install` installs the helper and omp, then gets the extension installed from the Web Store: it opens freeDia's Store page in Chrome/Dia (one "Add" click, works immediately) and writes Chrome's External Extensions file as a backup (Enable prompt on next browser start). Needs the Store listing to exist; during development the extension is loaded unpacked.
- **Extension updates:** automatic, from the Web Store. Chrome never installs or updates extensions from a local package on macOS.
- **Helper updates:** automatic, by self-update (task 1A).
- **Skew window:** the Store and the npm registry (where bunx pulls from) update on their own schedules, so for a while one side can be one version ahead. Rule: each side stays compatible with the other's previous version. `helper.hello` reports versions; the "Update helper" prompt appears only if self-update has failed.

## Page text

Modelled on Dia (`notes/research-page-text-cap.md`, `~/code/personal/Projects/notes/dia-decompile-analysis.md` §3): page as markdown, a bounded excerpt in the message, the full page readable on demand. Dia's tab reader cuts start-only: `truncatingTextContent(totalCharacterBudget:)` keeps `prefix(limit − 1) + "…"` and drops the rest; the limit comes from remote config (disassembly in the analysis note). Brave Leo, Firefox and Chrome also keep the start only. **freeDia deliberately differs:** it keeps the end too (75/25), so conclusions survive, and centers on the highlight when there is one, so the model sees the text around the selection instead of only the top of the page.

1. **Extraction (extension, current tab):** Readability → markdown (Turndown). Fall back to visible `innerText` when Readability returns null or keeps < ~20% of it. Compute a fingerprint (hash) of the markdown.
2. **Excerpt (in the message, saved in the chat):** budget = **10% of the selected model's `contextWindow`** (from `get_available_models`), clamped to **2k–20k tokens** (~8k–80k chars at ~4 chars/token). A 200k model gets the full 10%; larger models are capped, because the excerpt stays in the history and is re-sent to the model on every later turn.

   | | Start | Middle | End |
   |---|---|---|---|
   | No highlight | ~75% | dropped: `[… N characters omitted …]` | ~25% |
   | With highlight | ~15% | ~80% centered on the highlight, cut at paragraph boundaries; rest dropped | ~5% |

   Several highlights split the 80%; overlapping windows merge. The highlight is located by normalized text match (markdown syntax and whitespace stripped); not found → no-highlight layout. A page under budget is sent whole.

   **Highlight near the start or end:** the window can't be centered, so the unused share moves to the other side: a highlight in the first part of the page takes everything after it, one near the end takes everything before it. A window that reaches the start or end piece merges with it, so nothing is sent twice and the whole budget is always used. E.g. highlight in the intro → one continuous block from the top of the page plus the ~5% end.
3. **Highlight:** always sent in full as its own block, capped at the same budget against select-all.
4. **Full page (temporary, never in the chat):** sent with `page.put`; the helper writes `~/.freedia/pages/<chatId>.md`, which omp can read with its read-only tools.
5. **When to send what** (the extension keeps each chat's last fingerprint in `chrome.storage.local`, so this survives browser restarts):

   | Situation | Excerpt in the message | Full-page file (`page.put`) |
   |---|---|---|
   | First message of the chat | Full layout (step 2) | Yes |
   | Fingerprint changed (navigation or content change) | Full layout | Yes |
   | Same page, new highlight | **Only the window around the new highlight** (the ~80% piece); start and end are already in the history | No |
   | Same page, chat quiet ≥ **30 min** or extension reconnected | None: the old excerpt is still in the history | **Yes**: the file may be gone |
   | Same page, otherwise | None | No |

   The highlight itself is always sent in full (step 3).
6. **Cleanup:** helper deletes the file after **60 min** unused (longer than the extension's 30, so the extension never assumes a deleted file), on `page.clear` / `chat.delete`, and clears `~/.freedia/pages` on startup.
7. **Reopened chats:** earlier excerpts stay in the history. The next message compares the current page with the chat's stored fingerprint and follows step 5: same page → file only; different page → full excerpt and file.
8. **Pages freeDia can't read (v1):** PDFs (Chrome's PDF viewer runs no content scripts), YouTube (Readability finds nothing; the transcript needs its own fetch), canvas-rendered pages such as Google Docs, and non-web pages (`chrome://`, new tab). The chat still works: no excerpt or file is sent, the UI shows "freeDia can't read this page yet", and the prompt tells omp no page text is available. Highlights still work where the page allows selection. PDF and YouTube support are follow-ups (see Out of scope).
9. **Always sent; no opt-out.** Opening the chat on a page is the user asking about that page, so the page is always included per step 5. There is no per-message "leave the page out" control and no site blocklist.

## Phases

### Bucket 0 — scaffold first, then both spikes in parallel (gate for everything else)

- [x] **0.1 Scaffold** monorepo: bun workspaces, TS strict, Biome, `bun test`, WXT app skeleton, helper skeleton, shared envelope + helper-command types in `packages/helper/src/protocol.ts` (imported by the extension). `bun test` green.
- [x] **0.2 Spike S1 — pi RPC under Bun** (helper side), recorded in `notes/spike-pi-rpc.md`:
  - Run pi under Bun ≥ 1.4, and from inside a `bun build --compile` binary with `BUN_BE_BUN=1`.
  - Event shapes for `prompt` streaming, tool events, `abort`, `set_model` mid-session, `get_available_models`, `get_messages`; error shapes for not-signed-in and rate limits.
  - `--session-dir` + `--session-id`: create, resume after process exit with full context, session file naming (needed for `chat.list`/`chat.delete`), title source.
  - `abort` mid-reply: is the partial reply kept in the session?
  - Respawn time for a resumed session with a long history (the ~180 ms figure was an empty session); memory while streaming. If long sessions reload slowly, add a short idle timeout (e.g. 60 s) instead of exiting immediately.
  - Read-only: `--tools read,grep,find,ls --no-extensions` blocks bash/edit/write and MCP tools via the model (ask it to write a file; must fail). Confirm the RPC `bash` command exists and must be blocked by the helper.
  - pi-ai faux provider usable from pi for e2e.
  - Any Bun incompatibility → fall back to Node ≥ 22.19 for pi only.
  - Superseded 2026-10-23 by the pi → omp swap: the omp record is `notes/spike-omp-rpc.md`, and its outcomes are folded into the Contract above. This item stays as the pi record.
- [ ] **0.3 Spike S2 — browser** (Playwright Chromium + manual Dia), recorded in `notes/spike-browser.md`: (a) `chrome.commands` `Command+Shift+E` fires; (b) content-script keydown Cmd+E in Dia reaches the page before Dia's chat; (c) Dia detection via `navigator.userAgentData.brands`/UA; (d) Document Picture-in-Picture opened from a content-script click/keydown on an https page, and whether it survives tab switches. Sets PiP go/no-go. Chromium side done; Dia manual checks B–D in `notes/spike-browser.md` still open.

Spike outcomes are folded into the Contract and the tasks below (2026-10-20). Dia checks B–D are still manual.

### Bucket 1 — parallel (3 agents)

- [x] **1A Helper** (`packages/helper`)
  - Native messaging framing (stdin/stdout, 4-byte LE length).
  - Router: envelope → pi process for `chatId`; allowlist check; pi stdout lines → envelope back, untouched.
  - Process pool: spawn on demand for a `chatId` on any command (prompt, `get_messages` for a reopened chat, etc.), max `maxConcurrent` (default 3) generating + queue, `chat.status` pushes. Exit each process on `agent_settled`; after an `abort`, forward the `abort` response first, then close stdin. Launch exactly as in the Contract: `--model` = the chat's own model, clean environment, fixed cwd, `FREEDIA_PI_EXTRA_ARGS` test hook. Clean shutdown when the extension disconnects (let in-flight runs finish saving, then exit).
  - Model list: when no chat process is running, answer `get_available_models` from a short-lived pi process and cache the result until the helper exits.
  - `helper.hello`, `chat.list`, `chat.delete` over `~/.freedia/chats` (see Session files). `chat.delete` stops a running pi for that chat before deleting. pi always launched with cwd `~/.freedia`.
  - Chat titles (see Contract): one-shot `--no-session` title call after the first reply, `set_session_name` on the chat's session, 8-word cut and fallback.
  - Page files: `page.put` / `page.clear` over `~/.freedia/pages/<chatId>.md`; delete after 60 min unused, on `chat.delete`, and clear the folder on startup.
  - Preflight: pi missing → `helper.error` `pi_missing`; not signed in → `not_signed_in` via `pi auth check --provider <p> --json` (`status: ready | not_ready | invalid`, exit 0/1/2). Both with `fix` text.
  - Self-update: on `helper.hello`, at most once a day, check the npm registry for a newer `freedia`; download the new binary next to the old one, swap it after in-flight chats finish, and keep the protocol backward compatible with the previous extension version. pi version is pinned per helper release and updated with it.
  - Distribution: `bun build --compile` single binary (macOS arm64/x64 first), published to the npm registry and installed with `bunx freedia install`. Users need Bun only to run the installer; the helper binary carries its own Bun, which also runs pi, so the user's Bun version doesn't matter after install.
  - Installer `freedia install`: copies the binary to `~/.freedia/bin/freedia-helper`; writes **one** native host manifest at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.freedia.helper.json` (creating the folder if Chrome isn't installed) with the absolute binary path and every freeDia extension ID in `allowed_origins`. Dia reads native host manifests only from Chrome's folder, never from its own user-data dir (observed in Dia 1.52.0, `notes/research-dia-detection.md`), so this one file serves both browsers. Installs pi 1.3.0 into `~/.freedia/pi` with `bun add` (pinned as a dependency of the `freedia` package); runs pi sign-in through the helper binary against `~/.freedia/pi-agent`; installs the extension (see Updates); `freedia uninstall`; `freedia doctor`.
  - Tests (fake pi replaying the S1 fixtures in `packages/helper/test/fixtures/pi/`): framing round-trip; allowlist rejects `bash`, every other blocked command and unknown types; launch flags and clean environment (no `*_API_KEY` reaches pi); **a resumed spawn passes the session's own latest model, never another**; routing two chats concurrently without cross-talk; queue when over the limit; process exits on `agent_settled` and the next message respawns and resumes; abort ordering (`agent_settled` → `abort` response → stdin closed); `chat.delete` stops a running chat first; installer writes the manifest to Chrome's folder, creating it when missing (temp HOME).
- [x] **1B Extension shell** (`packages/extension`, no chat UI)
  - Manifest: `nativeMessaging`, `storage`; command `open-chat` (`Ctrl+Shift+E` / mac `Command+Shift+E`) as a backup that always works, rebindable at `chrome://extensions/shortcuts`. The service worker forwards `open-chat` to the tab with `tabs.sendMessage`; the content script still has user activation there (S2), which PiP needs. The lazy-loaded UI bundle is a web-accessible resource with `use_dynamic_url`, so pages can't probe for freeDia by its fixed ID.
  - Content script (tiny, all http/https pages): selection capture, the user's chosen shortcut (default **⌘E**; capture-phase `keydown` on `window` at `document_start`, matched on `event.code`, `preventDefault` + `stopImmediatePropagation`), lazy-load the chat UI into a shadow-DOM root on first open.
  - Page context (see Page text): Readability → markdown with `innerText` fallback, fingerprint, excerpt sized to 10% of the model's context window and centered on highlights, `page.put`/`page.clear`, re-send rules (fingerprint change, 30-min quiet, reconnect); URL + title; builds the `prompt` message text.
  - Service worker: native port lifecycle and reconnect, `helper.hello` with the concurrency setting, relay between tab ports and the helper by `chatId`, `helper_missing` detection, new `chatId` generation, tab → chatId map in `chrome.storage.local`.
  - Onboarding + settings: **no browser detection and no "Using Dia?" question.** First run shows a shortcut picker, default **⌘E**: keep it or press another combination. Changeable later in settings. Onboarding notes that Dia uses ⌘E for its own chat ("turn it off in Dia → Settings → Shortcuts, or pick another shortcut here") and that ⇧⌘E always works too. Settings also hold max concurrent chats.
  - Typed client API for the UI: `send()`, `abort()`, `newChat()`, `addQuote()`, `setModel()`, `listChats()`, `openChat(chatId)`, `deleteChat()`, event subscription.
  - Tests: extraction + fallback, excerpt layout (no highlight, one, several, overlapping, not found, page under budget), re-send rules, prompt text built correctly (first message vs follow-up), chosen shortcut opens the chat and the default is ⌘E, relay routing per tab.
  - Delete `e2e/spike/` once this task is done; its useful checks move into `e2e/specs` with real assertions in 2.3.
- [x] **1C Chat UI** (`packages/extension/src/ui`, built against a mock client implementing 1B's API)
  - Dia-style floating chat window (strings from `notes/research-dia-ui.md`): header ("+" new chat, history, expand, close; no chat title, no model picker), message list with streaming markdown (react-markdown + code highlighting), composer, stop button.
  - Composer: **model picker in the composer toolbar beside Send**, as in Dia; placeholder "Ask a question about this page", then "Ask another question". Send is disabled while a reply is running (pi rejects a second `prompt` mid-run).
  - Highlights: shown as a composer attachment chip labelled **"Selected Text"**, as in Dia (`DynamicTextSelectionAttachmentDataSource`); re-highlighting adds another chip. Dia's exact chip visuals weren't observed: match them from a screenshot during 1C.
  - Loading states: "Starting…" / "Waiting for another chat to finish…" from `chat.status`, then **"Thinking…"** (Dia's string) from `prompt` accepted until the first text delta; streaming and done come from pi's own events.
  - Copy, as in Dia: copy button on code blocks ("Copy code") and **"Copy"** on each assistant message. Dia's "Copy as image", "Edit message" and feedback buttons are out of scope.
  - **Closing mid-reply cancels it.** Closing the chat window while a reply streams shows Dia's confirm, "Cancel this response?"; confirming sends `abort` and closes. The reply never finishes in the background. Tab closed or navigated away mid-reply: the service worker sends `abort` (no confirm possible). The partial reply stays in the history with `stopReason: "aborted"`.
  - Drag, resize, expand; position/size persisted (`chrome.storage.local`).
  - History panel: list with titles, reopen, delete (with a "Delete this chat?" confirm, as in Dia).
  - Error states with fix text for every `helper.error` code and for pi's own errors: not signed in (failed `prompt` response, `No API key found for …`), provider rejected and rate limited (`message_end` with `stopReason: "error"`; show "retrying" during `auto_retry_start` / `auto_retry_end`). "Install helper" card with a copyable command.
  - Rendering pi's events: ignore `role: "system"` messages (events and `get_messages`); build streaming text from `message_update.assistantMessageEvent` deltas keyed by `contentIndex`, then replace it with `message_end.message`. A reply with `stopReason: "aborted"` renders as stopped.
  - Tests: "Selected Text" chip add, new chat resets, model switch updates selection, send disabled mid-reply, "Thinking…" before the first delta, copy (code and message), close mid-reply → confirm → `abort`, stop, queued state, error rendering (each pi error shape above), streaming deltas replaced by `message_end`.

### Bucket 2 — after Bucket 1

- [x] **2.1 Integration wiring**: UI uses the real 1B client; end-to-end through helper + pi.
- [ ] **2.2 PiP float mode (stretch, GO in Chromium; Dia check D pending)**: "Float" opens a Document PiP window only inside a user-gesture handler (button click, ⌘E keydown, or the `open-chat` message) and moves the existing shadow-DOM chat host into it; no new UI instance or port. On PiP `pagehide`, move the host back to the page. Limits (S2): one PiP window across the browser (opening one from another tab closes the first), and it closes when its tab navigates.
- [x] **2.3 E2E** (Playwright Chromium, unpacked extension, real helper, pi faux provider via `FREEDIA_PI_EXTRA_ARGS`): ENSURE 1–8, 10–12, 14. Playwright can't press browser-level shortcuts, so ⇧⌘E is tested as registration (`chrome.commands.getAll()`) plus the content-side handler via a service-worker message; ⌘E is tested with `page.keyboard.press("Meta+e")`. ENSURE 13 manual in Dia; ENSURE 9 automatable (button click → `context.waitForEvent("page")`). `bun run e2e` (20 specs) and `bun run demo` (walkthrough with screenshots).
- [x] **2.4 Docs**: README (install, sign-in, shortcuts, privacy), CHANGELOG.

### Bucket 3 — pi → omp swap (2026-10-23)

Buckets 1–2 were built and verified against pi 1.3.0; this bucket swaps the helper's engine to omp 18.12.1 (evidence and shapes: `notes/spike-omp-rpc.md`). User-visible behavior (ENSURE 1–14) is unchanged.

- [x] **3.1 Helper engine swap** (`packages/helper`): `pi.ts` → `omp.ts` (launch per Contract: `--mode rpc --no-ui --cwd ~/.freedia`, `--tools read,grep,glob`, clean env with `HOME=~/.freedia/home`, `--model` fresh-only); `negotiate_protocol` v2 + `rpc_chunk` reassembly; `open_session` binding; run lifecycle on `prompt_result`/`session_settled`; allowlist per the omp command set (`bash` still blocked — verified executing); `chats.ts` enumerates per-chat directories, reads the header title slot, deletes directories; titles via one-shot `omp -p --no-session --no-title`; preflight `not_signed_in` via `get_login_providers`; `helper.hello` reports `ompVersion`; installer installs `@oh-my-pi/pi-coding-agent@18.12.1` into `~/.freedia/omp` and creates `~/.freedia/home`; `FREEDIA_OMP_EXTRA_ARGS` test hook. omp fixtures regenerated from the spike (`packages/helper/test/fixtures/omp/`), faux provider = local OpenAI-compatible server + `models.yml`. Tests updated to the new launch/allowlist/session-layout expectations.
- [x] **3.2 Extension adjustments**: error mapping (`Model not found` on `set_model`, `prompt_result { status: "error" }`), stop-button lifecycle (`abort` response → `prompt_result` → `session_settled`), unknown frame types ignored (already the case). No UI redesign.
- [x] **3.3 E2E**: faux server fixture + `models.yml` in the e2e agent dir, updated launch-flag and readonly specs, full `bun run e2e` + `bun run demo`.
- [x] **3.4 Docs**: README/CHANGELOG updated for omp; omp memory figures measured and recorded in the Contract.

## ENSURE → validation

| # | ENSURE | Validation |
|---|---|---|
| 1 | Highlight + shortcut opens chat with quote | E2E: select text, trigger command, assert quote chip |
| 2 | Streaming reply reflects page context | E2E with faux provider asserting the prompt contains URL/highlight/page text; deltas arrive incrementally |
| 3 | Follow-ups keep context | E2E: second message; faux provider sees prior turns (pi's job; verifies we don't break it) |
| 4 | Model switch mid-chat | E2E: `set_model`, send; history carried |
| 5 | "+" new chat | E2E + UI unit test |
| 6 | Re-highlight adds quote | E2E |
| 7 | History survives restart | E2E: relaunch browser; list/reopen/delete; session files in temp `~/.freedia/chats` |
| 8 | Drag/resize/expand persisted | E2E: drag, reload, assert position |
| 9 | (Stretch) PiP float | E2E in Chromium (S2 showed it's automatable: button click → `context.waitForEvent("page")`); manual in Dia (check D) |
| 10 | Actionable errors | Helper unit tests per `helper.error` code; UI tests mapping pi error events to fix text; E2E for `helper_missing` |
| 11 | Read-only agent; previous chats only on ask | S1 verification + helper test that `bash` is blocked and launch flags are set |
| 12 | Chat per tab | E2E: two tabs, separate chats |
| 13 | Shortcut ⌘E by default, user-changeable at onboarding and in settings; ⇧⌘E backup | E2E: `Meta+e` opens the chat; a changed shortcut opens it and ⌘E no longer does; manifest assertion for ⇧⌘E. Manual in Dia: ⌘E reaches freeDia once Dia's own ⌘E is turned off |
| 14 | Multiple chats at once; stop; resume later | E2E: two tabs streaming at once; abort one; after a run its process has exited; next message resumes with context |

## Risks

- **Engine RPC details** → settled: pi by S1, omp by the 2026-10-23 spike (`notes/spike-omp-rpc.md`): event shapes, `prompt_result`/`session_settled`, abort partials, `open_session` binding, resume model restore, error shapes.
- **omp's protocol is the extension's protocol** → an omp release could change events. omp is pinned per helper release; the helper self-updates, and a version check in `helper.hello` catches skew.
- **⌘E clashes in both browsers.** Dia: ⌘E opens Dia's own chat and may win over the content script (manual check B); onboarding tells the user to turn Dia's off or pick another shortcut. Chrome: ⌘E is "Use Selection for Find"; whether the content script's `preventDefault` stops it is unverified, so check in 1B. Either way ⇧⌘E still works.
- **Shortcut needs a content script**, so it doesn't work on pages where content scripts can't run (`chrome://`, the Web Store, the PDF viewer). freeDia can't read those pages anyway (Page text step 8).
- **PiP from extension** → GO in Chromium (S2); Dia check D pending. Stays a stretch goal.
- **Native messaging on macOS**: Chrome launches the host with a minimal PATH → manifest points to the absolute binary path; omp path resolved at install time.
- **Helper lifetime**: Chrome closes the helper's stdin when the service worker's port drops → in-flight replies could be cut. Service worker keeps the port open while any chat is running; helper finishes in-flight runs before exiting.
- **omp under Bun** is its documented path (`engines.bun >=1.3.14`); the spike found no incompatibility (plain Bun; compiled-helper spawn re-verified in 3.1). An omp upgrade must re-run the spike recorder before shipping.
- **Memory** measured at **86,176 KiB RSS (~84 MiB) per omp process** while streaming against the faux provider; only while generating; max 3 at once (~252 MiB).
- **Provider keys in the environment** → omp would pick up shell keys and `.env` files; the helper starts omp with a clean environment and `HOME=~/.freedia/home` (Contract).
- **Model picker needs an omp process** for `get_available_models` when no chat is running → helper spawns a short-lived one and caches the list for the session.
- **Compiled binary size** (~60 MB per platform) → acceptable for a one-time install.
- **Provider terms** (subscription OAuth via omp in a Store extension: ChatGPT/Codex, Claude, GLM, Kimi, …): accepted by user; not a build blocker. Anthropic subscription auth specifically still draws from extra usage rather than plan limits (research 2026-10-22); users pick providers at their own risk.

## Out of scope (v1)

Open in new tab, pop-out window, side panel, @-mention tabs, write tools, Windows/Linux installers, Web Store submission.

Follow-ups after v1: PDF text (download the PDF and extract it with pdf.js, ~1 MB in the extension); YouTube transcripts (fetched separately, as Brave and Firefox do); canvas-rendered pages such as Google Docs.
