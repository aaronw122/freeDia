# freeDia — Initial Implementation Plan

Spec: `notes/freedia.md` · Architecture: `diagrams/initial-pi-ai-integration.md` · Commits and PRs follow `CONTRIBUTING.md`.

Repo: `freeDia/` (new, bun workspaces monorepo). Packages:

```
freeDia/
  packages/helper/     # Bun native-messaging host (compiled binary): pipe to pi, process pool, installer (bunx freedia install)
  packages/extension/  # WXT + React + Tailwind MV3 extension (UI only)
  e2e/                 # Playwright: Chromium + unpacked extension + real helper + pi faux provider
```

Principle: **the extension is UI only and the helper is a plain pipe.** pi owns the conversation (context, follow-ups, model switching, compaction, sessions, tools). freeDia adds only what pi doesn't have: routing per chat, a process pool, and listing/deleting chats.

Defaults decided here: page text = main content as markdown, excerpt sized to 10% of the model's context window and centered on any highlight, full page available to pi as a temporary file (see Page text); macOS first.

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

## Environment prerequisites

- Bun ≥ 1.4 for development. Bun 1.2.16 crashes pi on startup (`webidl.util.markAsUncloneable is not a function`). Measured in S1 under Bun 1.4.3 with pi 1.3.0: ~105–140 MB RSS per pi process (idle or streaming); spawn → first RPC response ~120 ms warm, ~180–210 ms first run; resuming a 200-turn, 5.6 MB session ~130–180 ms. pi also runs from inside the `bun build --compile` helper with `BUN_BE_BUN=1`.
- No Node at runtime and no Node fallback: S1 found no Bun incompatibility (plain and compiled). Local Node is 21.7.3, too old for pi anyway.
- pi pinned at 1.3.0. `bun add @earendil-works/pi-coding-agent@1.3.0` works with Bun 1.4.3 (the earlier 404 is gone, re-tested 2026-10-19). Signed in to at least one provider for manual testing.
- Chrome is not installed; Dia is. Automated tests use Playwright's bundled Chromium. Dia used for manual Cmd+E checks.

## Contract (frozen after Bucket 0)

Transport: extension service worker ↔ helper over `chrome.runtime.connectNative("com.freedia.helper")` (length-prefixed JSON, 1 MB host→extension message limit). Content script/UI ↔ service worker over `chrome.runtime.Port`.

**Envelope.** Every message carries the chat it belongs to; the body is a pi RPC record, unchanged.

```jsonc
// ext → helper
{ "chatId": "3f2a9c1e-8b4d-4e6f-a0b1-c2d3e4f5a6b7", "rpc": { "id": "r1", "type": "prompt", "message": "…" } }
// helper → ext (pi responses and events, untouched)
{ "chatId": "3f2a9c1e-8b4d-4e6f-a0b1-c2d3e4f5a6b7", "rpc": { "type": "message_update", … } }
```

**Forwarded pi RPC commands (allowlist; everything else is dropped):**

| pi command                           | Used for                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                             | Send a message (first message or follow-up). pi keeps all earlier turns.                                                                          |
| `abort`                              | Stop the current reply                                                                                                                            |
| `set_model` / `get_available_models` | Model picker, switch mid-chat                                                                                                                     |
| `get_messages`                       | Render a reopened chat                                                                                                                            |
| `get_state`                          | Status (model, streaming, etc.)                                                                                                                   |

Blocked on purpose: every other pi 1.3.0 command: `bash`, `abort_bash`, `steer`, `follow_up`, `clear_queue`, `new_session`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `export_html`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `set_steering_mode`, `set_follow_up_mode`, `cycle_model`, `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels`, `get_session_stats`, `get_last_assistant_text`, `get_commands`, `extension_ui_response`. RPC `bash` is the dangerous one: S1 saw it run a real shell even with `--tools read,grep,find,ls`. `set_session_name` is also blocked for the extension; only the helper sends it, for chat titles.

**Helper's own commands (no `rpc` field; pi has no equivalent):**

Requests from the extension carry a string `id`; the helper echoes it on the reply (or on a `helper.error` answering that request). Pushes carry no `id`.

| type                               | Payload → reply                                                         | Purpose                                        |
| ---------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| `helper.hello`                     | `{ id, maxConcurrent }` → `{ id, helperVersion, piVersion }`            | Detect missing/outdated helper; passes the user's concurrency setting |
| `chat.list`                        | `{ id }` → `{ id, chats: [{ chatId, title, updatedAt }] }`              | History panel. `updatedAt` is an ISO 8601 string. `title` is the freeDia title (see Chat titles), else the first 8 words of the first question |
| `chat.delete`                      | `{ id, chatId }` → `{ id, chatId }`                                     | Delete a chat                                  |
| `chat.status` (helper → ext, push) | `{ chatId, state }`, where `state` is `starting` or `queued`            | Loading indicator before pi's own events begin |
| `helper.error` (helper → ext)      | `{ id?, chatId?, code, message, fix }`; `id` set when it answers a request | `pi_missing`, `not_signed_in`, `spawn_failed`. Provider errors (rejected, rate limited) arrive as pi's own error events, untouched. |
| `page.put`                         | `{ id, chatId, markdown }` → `{ id, chatId }`                           | Write/replace the chat's temporary full-page file (see Page text) |
| `page.clear`                       | `{ id, chatId }` → `{ id, chatId }`                                     | Delete it (new chat, tab closed). `chat.delete` also deletes it |

Exact JSON for each is pinned in `packages/helper/src/protocol.test.ts`.

**Chats = pi sessions.** `chatId` is the pi session ID: there is one ID, not two. The extension generates it with `crypto.randomUUID()` when a chat starts (a lowercase UUID v4, `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`) and the helper rejects anything else, since the ID reaches pi's command line and the sessions directory. pi's own generated IDs are UUID v7; pi accepts any ID matching its `assertValidSessionId`, which v4 does, and `--session-id` creates the session on first use. Sessions live in `~/.freedia/chats` (pi's `--session-dir`) as `<timestamp>_<chatId>.jsonl`, separate from the user's own pi coding sessions. No freeDia chat file format; no IndexedDB cache. pi is always launched with the same working directory (`~/.freedia`), because pi resolves sessions relative to its working directory; a fixed one keeps IDs resolving on resume. To open a freeDia chat in pi directly: from `~/.freedia`, `PI_CODING_AGENT_DIR=~/.freedia/pi-agent pi --session-dir ~/.freedia/chats --session <chatId or its first 8 chars>`, or `-r` for pi's picker.

**pi launch (one process per active chat):**

```sh
env -i HOME=… PATH=… PI_CODING_AGENT_DIR=~/.freedia/pi-agent BUN_BE_BUN=1 \
<bun> <pi>/dist/bundle/cli.js --mode rpc \
  --session-dir ~/.freedia/chats --session-id <chatId> \
  [--model <id>] \
  --tools read,grep,find,ls \
  --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp --no-themes \
  --append-system-prompt "<freeDia rules>"
```

`--session-id` creates the session if new and resumes it if it exists, so "open", "resume" and "reopen from history" are the same operation. `<bun>` is the helper's own runtime (`process.execPath`); `BUN_BE_BUN=1` is required, or the compiled helper re-runs itself instead of pi. The freeDia rules: answer about the page the user is on; the message carries a page excerpt, and the full page is at `~/.freedia/pages/<chatId>.md` (read it with `read`/`grep` when the excerpt isn't enough); read-only; only read `~/.freedia/chats` when the user explicitly asks about previous chats.

- **`--model` only when the chat has no session file yet. A resumed spawn never passes `--model`.** On resume, `--model` overrides the chat's model, and after one reply under it the override sticks: the user's `set_model` choice is lost for good (S1, fixtures `model-override-*`). Model changes mid-chat go through `set_model` only.
- **Clean environment.** pi reads provider API keys from its environment (S1: `GROQ_API_KEY` from the shell made Groq models appear), so the helper starts pi with only the variables above and no `*_API_KEY` / provider tokens. freeDia uses only its own sign-ins in `~/.freedia/pi-agent`, as decided for "separate pi setup".
- **Fixed cwd `~/.freedia`.** pi matches `--session-id` against the `cwd` stored in the session file; a different cwd silently opens an empty chat with the same ID (S1).
- **Test hook:** e2e sets `FREEDIA_PI_EXTRA_ARGS` (e.g. `-e <faux-extension.ts> --offline --model faux/faux-1`) to run pi against the faux provider. Unset in production; never set by the extension.

**Page context is part of the message text.** The extension builds the `prompt` message: URL, title, highlighted quotes, page excerpt (only when re-sent, see Page text), then the question under a fixed `## Question` heading, so the helper can find it for titling. pi stores it like any message, so follow-ups and resumed chats keep it. The full page goes to the helper with `page.put`, never into the message.

**Chat titles.** Set once, by the helper, after the chat's first reply settles; never renamed later. Shown only in the history panel, never in the chat window.
1. The helper runs a one-shot pi with the chat's model and `--no-session` (no session file is created, verified 2026-10-20): "Title this chat in 8 words or fewer", given the page title and the first question only, not the page text.
2. It writes the result with pi's `set_session_name` (stored as a `session_info` entry; no user message is added, verified 2026-10-20): on a short-lived spawn of the chat's session if it's idle, or as the first command on its next spawn if the user already sent another message. Never with `--model` (resume rule).
3. Over 8 words → cut to 8. Title call fails → no name is written, and `chat.list` falls back to the first 8 words of the first question.

**Stop a reply.** The stop button sends pi's `abort` command; the helper forwards it to that chat's pi process. pi emits `agent_settled` with `aborted: true`, then the `abort` response; the helper forwards both and only then closes pi's stdin (pi exits 0). The half-finished reply is kept: saved as an assistant message with `stopReason: "aborted"`, returned by `get_messages`, and sent to the model as context on the next prompt. `abort` also cancels a pending auto-retry. A `prompt` sent while a run is active is rejected by pi (`success: false`, "Agent is already processing…"), so the UI disables send during a run.

**Errors from pi (forwarded untouched; the UI maps them to fix text):**
- Not signed in: the `prompt` response fails with `success: false` and an `error` starting `No API key found for …`. It is a response, not an event.
- Provider rejected or rate limited: an assistant `message_end` with `stopReason: "error"` and `errorMessage` (e.g. `401 {…authentication_error…}`, `429 {…rate_limit_error…}`). Retryable errors come after `auto_retry_start` / `auto_retry_end` events: 3 attempts, 2 / 4 / 8 s.

**Session files.** `~/.freedia/chats/<timestamp>_<chatId>.jsonl`, one flat folder, created only when the first message is saved: a chat with no message has no file and isn't listed. `chat.list` reads each file's header (`id`) and entries: `title` = latest `session_info.name`, else the first 8 words of the first question; `updatedAt` = latest message timestamp. `chat.delete` stops that chat's pi first (abort, wait for exit), then deletes `*_<chatId>.jsonl`.

## Multiple chats at once

| Need                                   | How                                                                                                                                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Several chats running at the same time | One pi process per active chat (pi runs one session per process). The helper routes by `chatId`.                                                                                                                                                |
| Keep running when you switch tabs      | The process lives in the helper, not the tab. Events keep arriving and the UI catches up when you return.                                                                                                                                       |
| Limit load                             | Max **3** chats generating at once (setting). Extra prompts wait as `queued` and start when a slot frees.                                                                                                                                       |
| Pause / resume later                   | No warm pool. A chat's pi process exits as soon as its reply finishes (`agent_settled`, not `agent_end`: retries can follow `agent_end`) or is stopped. The session file stays. The next command respawns pi with `--session-id`, which reloads the full context. Respawn costs ~120–180 ms even for a 200-turn chat, small next to the model's own first-token delay, so no idle timeout. |
| Survive browser restart                | Same as resume: sessions are files; the tab → chatId map is in `chrome.storage.local`.                                                                                                                                                          |

Memory: ~105–140 MB per pi process, only while a chat is generating, so at most 3 × ~140 MB ≈ 0.4 GB. Nothing stays resident between messages.

## Updates (one package, both pieces stay current)

- **Install:** `bunx freedia install` installs the helper and pi, then gets the extension installed from the Web Store: it opens freeDia's Store page in Chrome/Dia (one "Add" click, works immediately) and writes Chrome's External Extensions file as a backup (Enable prompt on next browser start). Needs the Store listing to exist; during development the extension is loaded unpacked.
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
4. **Full page (temporary, never in the chat):** sent with `page.put`; the helper writes `~/.freedia/pages/<chatId>.md`, which pi can read with its read-only tools.
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
8. **Pages freeDia can't read (v1):** PDFs (Chrome's PDF viewer runs no content scripts), YouTube (Readability finds nothing; the transcript needs its own fetch), canvas-rendered pages such as Google Docs, and non-web pages (`chrome://`, new tab). The chat still works: no excerpt or file is sent, the UI shows "freeDia can't read this page yet", and the prompt tells pi no page text is available. Highlights still work where the page allows selection. PDF and YouTube support are follow-ups (see Out of scope).
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
- [ ] **0.3 Spike S2 — browser** (Playwright Chromium + manual Dia), recorded in `notes/spike-browser.md`: (a) `chrome.commands` `Command+Shift+E` fires; (b) content-script keydown Cmd+E in Dia reaches the page before Dia's chat; (c) Dia detection via `navigator.userAgentData.brands`/UA; (d) Document Picture-in-Picture opened from a content-script click/keydown on an https page, and whether it survives tab switches. Sets PiP go/no-go. Chromium side done; Dia manual checks B–D in `notes/spike-browser.md` still open.

Spike outcomes are folded into the Contract and the tasks below (2026-10-20). Dia checks B–D are still manual.

### Bucket 1 — parallel (3 agents)

- [ ] **1A Helper** (`packages/helper`)
  - Native messaging framing (stdin/stdout, 4-byte LE length).
  - Router: envelope → pi process for `chatId`; allowlist check; pi stdout lines → envelope back, untouched.
  - Process pool: spawn on demand for a `chatId` on any command (prompt, `get_messages` for a reopened chat, etc.), max `maxConcurrent` (default 3) generating + queue, `chat.status` pushes. Exit each process on `agent_settled`; after an `abort`, forward the `abort` response first, then close stdin. Launch exactly as in the Contract: `--model` only for a new chat, clean environment, fixed cwd, `FREEDIA_PI_EXTRA_ARGS` test hook. Clean shutdown when the extension disconnects (let in-flight runs finish saving, then exit).
  - Model list: when no chat process is running, answer `get_available_models` from a short-lived pi process and cache the result until the helper exits.
  - `helper.hello`, `chat.list`, `chat.delete` over `~/.freedia/chats` (see Session files). `chat.delete` stops a running pi for that chat before deleting. pi always launched with cwd `~/.freedia`.
  - Chat titles (see Contract): one-shot `--no-session` title call after the first reply, `set_session_name` on the chat's session, 8-word cut and fallback.
  - Page files: `page.put` / `page.clear` over `~/.freedia/pages/<chatId>.md`; delete after 60 min unused, on `chat.delete`, and clear the folder on startup.
  - Preflight: pi missing → `helper.error` `pi_missing`; not signed in → `not_signed_in` via `pi auth check --provider <p> --json` (`status: ready | not_ready | invalid`, exit 0/1/2). Both with `fix` text.
  - Self-update: on `helper.hello`, at most once a day, check the npm registry for a newer `freedia`; download the new binary next to the old one, swap it after in-flight chats finish, and keep the protocol backward compatible with the previous extension version. pi version is pinned per helper release and updated with it.
  - Distribution: `bun build --compile` single binary (macOS arm64/x64 first), published to the npm registry and installed with `bunx freedia install`. Users need Bun only to run the installer; the helper binary carries its own Bun, which also runs pi, so the user's Bun version doesn't matter after install.
  - Installer `freedia install`: copies the binary to `~/.freedia/bin/freedia-helper`; writes **one** native host manifest at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.freedia.helper.json` (creating the folder if Chrome isn't installed) with the absolute binary path and every freeDia extension ID in `allowed_origins`. Dia reads native host manifests only from Chrome's folder, never from its own user-data dir (observed in Dia 1.52.0, `notes/research-dia-detection.md`), so this one file serves both browsers. Installs pi 1.3.0 into `~/.freedia/pi` with `bun add` (pinned as a dependency of the `freedia` package); runs pi sign-in through the helper binary against `~/.freedia/pi-agent`; installs the extension (see Updates); `freedia uninstall`; `freedia doctor`.
  - Tests (fake pi replaying the S1 fixtures in `packages/helper/test/fixtures/pi/`): framing round-trip; allowlist rejects `bash`, every other blocked command and unknown types; launch flags and clean environment (no `*_API_KEY` reaches pi); **a resumed spawn never passes `--model`**; routing two chats concurrently without cross-talk; queue when over the limit; process exits on `agent_settled` and the next message respawns and resumes; abort ordering (`agent_settled` → `abort` response → stdin closed); `chat.delete` stops a running chat first; installer writes the manifest to Chrome's folder, creating it when missing (temp HOME).
- [ ] **1B Extension shell** (`packages/extension`, no chat UI)
  - Manifest: `nativeMessaging`, `storage`, `scripting`, `activeTab`; command `open-chat` (`Ctrl+Shift+E` / mac `Command+Shift+E`) as a backup that always works, rebindable at `chrome://extensions/shortcuts`. The service worker forwards `open-chat` to the tab with `tabs.sendMessage`; the content script still has user activation there (S2), which PiP needs.
  - Content script (tiny, all http/https pages): selection capture, the user's chosen shortcut (default **⌘E**; capture-phase `keydown` on `window` at `document_start`, matched on `event.code`, `preventDefault` + `stopImmediatePropagation`), lazy-load the chat UI into a shadow-DOM root on first open.
  - Page context (see Page text): Readability → markdown with `innerText` fallback, fingerprint, excerpt sized to 10% of the model's context window and centered on highlights, `page.put`/`page.clear`, re-send rules (fingerprint change, 30-min quiet, reconnect); URL + title; builds the `prompt` message text.
  - Service worker: native port lifecycle and reconnect, `helper.hello` with the concurrency setting, relay between tab ports and the helper by `chatId`, `helper_missing` detection, new `chatId` generation, tab → chatId map in `chrome.storage.local`.
  - Onboarding + settings: **no browser detection and no "Using Dia?" question.** First run shows a shortcut picker, default **⌘E**: keep it or press another combination. Changeable later in settings. Onboarding notes that Dia uses ⌘E for its own chat ("turn it off in Dia → Settings → Shortcuts, or pick another shortcut here") and that ⇧⌘E always works too. Settings also hold max concurrent chats.
  - Typed client API for the UI: `send()`, `abort()`, `newChat()`, `addQuote()`, `setModel()`, `listChats()`, `openChat(chatId)`, `deleteChat()`, event subscription.
  - Tests: extraction + fallback, excerpt layout (no highlight, one, several, overlapping, not found, page under budget), re-send rules, prompt text built correctly (first message vs follow-up), chosen shortcut opens the chat and the default is ⌘E, relay routing per tab.
  - Delete `e2e/spike/` once this task is done; its useful checks move into `e2e/specs` with real assertions in 2.3.
- [ ] **1C Chat UI** (`packages/extension/src/ui`, built against a mock client implementing 1B's API)
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

- [ ] **2.1 Integration wiring**: UI uses the real 1B client; end-to-end through helper + pi.
- [ ] **2.2 PiP float mode (stretch, GO in Chromium; Dia check D pending)**: "Float" opens a Document PiP window only inside a user-gesture handler (button click, ⌘E keydown, or the `open-chat` message) and moves the existing shadow-DOM chat host into it; no new UI instance or port. On PiP `pagehide`, move the host back to the page. Limits (S2): one PiP window across the browser (opening one from another tab closes the first), and it closes when its tab navigates.
- [ ] **2.3 E2E** (Playwright Chromium, unpacked extension, real helper, pi faux provider via `FREEDIA_PI_EXTRA_ARGS`): ENSURE 1–8, 10–12, 14. Playwright can't press browser-level shortcuts, so ⇧⌘E is tested as registration (`chrome.commands.getAll()`) plus the content-side handler via a service-worker message; ⌘E is tested with `page.keyboard.press("Meta+e")`. ENSURE 13 manual in Dia; ENSURE 9 automatable (button click → `context.waitForEvent("page")`).
- [ ] **2.4 Docs**: README (install, sign-in, shortcuts, privacy), CHANGELOG.

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

- **pi RPC details** → settled by S1 (Contract): event shapes, `agent_settled`, abort partials, session naming, error shapes.
- **pi's protocol is the extension's protocol** → a pi release could change events. pi is pinned per helper release; the helper self-updates, and a version check in `helper.hello` catches skew.
- **⌘E clashes in both browsers.** Dia: ⌘E opens Dia's own chat and may win over the content script (manual check B); onboarding tells the user to turn Dia's off or pick another shortcut. Chrome: ⌘E is "Use Selection for Find"; whether the content script's `preventDefault` stops it is unverified, so check in 1B. Either way ⇧⌘E still works.
- **Shortcut needs a content script**, so it doesn't work on pages where content scripts can't run (`chrome://`, the Web Store, the PDF viewer). freeDia can't read those pages anyway (Page text step 8).
- **PiP from extension** → GO in Chromium (S2); Dia check D pending. Stays a stretch goal.
- **Native messaging on macOS**: Chrome launches the host with a minimal PATH → manifest points to the absolute binary path; pi path resolved at install time.
- **Helper lifetime**: Chrome closes the helper's stdin when the service worker's port drops → in-flight replies could be cut. Service worker keeps the port open while any chat is running; helper finishes in-flight runs before exiting.
- **pi under Bun is off pi's documented path** (`engines.node >=22.19`) → S1 found no incompatibility (plain and compiled); a pi upgrade must re-run the S1 recorder before shipping.
- **Memory** (~105–140 MB per pi process) → only while generating; max 3 at once.
- **Provider keys in the environment** → pi would pick up the user's shell keys; the helper starts pi with a clean environment (Contract).
- **Model picker needs a pi process** for `get_available_models` when no chat is running → helper spawns a short-lived one and caches the list for the session.
- **Compiled binary size** (~60 MB per platform) → acceptable for a one-time install.
- **Provider terms** (Anthropic subscription via pi-ai in a Store extension): accepted by user; not a build blocker.

## Out of scope (v1)

Open in new tab, pop-out window, side panel, @-mention tabs, write tools, Windows/Linux installers, Web Store submission.

Follow-ups after v1: PDF text (download the PDF and extract it with pdf.js, ~1 MB in the extension); YouTube transcripts (fetched separately, as Brave and Firefox do); canvas-rendered pages such as Google Docs.
