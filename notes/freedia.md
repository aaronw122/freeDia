---
title: "freeDia"
author: "human:Aaron"
version: 1
created: 2026-10-19
---

# freeDia

A free, Dia-style "chat with your tab" for Chrome (and Dia). It runs on the user's own AI subscriptions or keys through a local pi harness, with no freeDia servers.

Architecture and decision log: `diagrams/initial-pi-ai-integration.md`.

## WANT

- **Chat bar on any page.** Highlight text, press the shortcut, and a Dia-style chat bar opens with the highlight quoted.
- **Page context on every message:** page URL + highlighted text + readable page text.
- **Streaming replies** and **follow-up questions** in the same conversation, keeping the original page and highlight.
- **Re-highlight:** with a chat open, highlighting new text and pressing the shortcut adds it to the current chat as another quote.
- **New chat:** "+" button in the chat bar header starts a fresh chat on the same tab.
- **Model picker** in the chat bar. Lists every model pi has access to (Claude Sonnet/Opus/Haiku, GPT/Codex, Gemini, local models, ...). Default: Claude Sonnet. Switching mid-chat keeps the history.
- **Any provider:** sign-in and provider support come from pi-ai (subscriptions, API keys, local models). Adding a provider requires no freeDia code changes.
- **Shortcuts:** Chrome default Cmd+Shift+E (Ctrl+Shift+E on Windows/Linux); Dia default Cmd+E (Dia detected, or chosen at first run). Both changeable.
- **Window modes (v1):**
  - **Floating chat window (page overlay):** matches Dia's floating chat. Floats over the page; draggable, resizable and expandable. Each chat belongs to its tab.
  - **Stretch: float above other apps** (Document Picture-in-Picture). The "ideal world" goal; depends on an early test.
  - Position and size remembered.
- **Chat history:** list, reopen, delete past chats. Chats are pi sessions stored in `~/.freedia/chats/`; the extension stores no conversation data.
- **Multiple chats at once:** several chats can generate in parallel (default max 3; extra ones queue). Any reply can be stopped. Any chat can be resumed later with full context, including after a browser restart.
- **Ask about previous chats:** the agent can read `~/.freedia/chats`, but only when the user explicitly asks about earlier chats.
- **Install:** Chrome Web Store extension + `bunx freedia install` (Bun-compiled helper binary, includes pi). The extension detects a missing helper and shows the command.

## DON'T

- No freeDia servers, backend, or telemetry. Everything runs locally against the user's own accounts.
- Don't read or send page content unless the user opens or uses the chat. No background reading.
- No write actions in v1: the agent gets only `read`, `grep`, `find`, `ls`. No `bash`, `edit`, `write`, `codemode`, `tool_search` or MCP tools.
- Don't read previous chats unless explicitly asked.
- Never write login tokens or credentials into chat files, exports, or anything sent to a model.
- Don't open a localhost port; extension ↔ helper uses Chrome native messaging only.
- Don't rebuild agent tooling or provider integrations that pi / pi-ai already provide.
- Not in v1: open in new tab, pop-out window, Chrome side panel, @-mentioning other tabs, write tools.

## LIKE

- Dia's Cmd+E chat bar (before the paywall). This is the visual and interaction target.
- pi (`earendil-works/pi`) as the harness.

## FOR

- People who already pay for Claude, ChatGPT or another AI subscription (or have API keys / local models) and want Dia-style chat in Chrome or Dia without another subscription.
- Distributed through the Chrome Web Store, plus a local helper installed with `bunx freedia install`.
- Platforms: macOS first; Chrome and Dia (Chromium). Windows/Linux supported by the shortcut defaults; installer coverage to be confirmed in the plan.
- Stack: WXT + React + Tailwind (extension, chat UI in a shadow DOM, loaded on first open); Bun helper compiled to a single binary; pi in RPC mode run under Bun (Node ≥ 22.19 fallback); pi-ai for sign-in and providers.

## ENSURE

1. On a normal https page, highlighting text and pressing the shortcut opens the chat bar with the highlight quoted.
2. A reply streams in, and the model's answer reflects the page URL, highlight and page text.
3. Follow-up questions keep context: the model can refer to the earlier exchange and the original page.
4. Switching models mid-chat sends the next message to the new model with the history carried over.
5. "+" starts a new chat on the same tab; the previous chat stays in history.
6. Highlighting new text with a chat open and pressing the shortcut adds a second quote to the same chat.
7. Chat history survives a browser restart; chats can be listed, reopened and deleted, and match files in `~/.freedia/chats`.
8. The overlay can be dragged, resized and expanded, and reopens at its last position and size.
9. (Stretch) If Picture-in-Picture works from the extension, the floating window stays above other apps and continues the same chat.
10. Clear, actionable errors when: the helper isn't installed, pi isn't signed in to the selected provider, or the provider rejects the request or hits a rate limit. Each error tells the user how to fix it.
11. The agent cannot write files or run commands. It reads `~/.freedia/chats` only when the user asks about previous chats.
12. Each overlay chat stays with its own tab; switching tabs shows that tab's chat.
13. Cmd+E works in Dia and Cmd+Shift+E works in Chrome, and both can be rebound.
14. Two chats in different tabs can stream at the same time; stopping one doesn't affect the other; after a reply finishes, the next message resumes the chat with full context.

## TRUST

- [ask] All architecture and product trade-offs. The user wants to discuss them together (as done for router, harness, storage, UI stack, shortcuts, window modes).
- [ask] Visual details where Dia's UI is ambiguous.
- [ask] Changing the read-only tool set or adding any write tool.
- [ask] Anything that sends data beyond the current page, current chat, or explicitly requested previous chats.
- [autonomous] Internal code structure, file layout, naming, chat file schema, and dependency versions within the decided stack.
- [autonomous] Test tooling and how each ENSURE item gets verified.

## Open questions (resolve in the plan or early tests)

- Does Document Picture-in-Picture work when opened from an extension's page overlay? If not, the stretch goal is dropped; the page overlay already covers Dia's floating chat.
- Does Cmd+E reach the extension in Dia, and can the extension detect Dia?
- Does Chrome accept Cmd+Shift+E as an extension default without clashes?
- How much page text to send (a size cap, and how to extract it)?
- pi RPC details: streaming events, switching models mid-session, aborting; one pi process per chat vs. starting pi per message.
- Where sign-in happens: the installer running pi `/login`, or a flow started from the extension.
- Store risk: provider terms for subscription use through pi-ai (noted earlier for Anthropic; the user chose to proceed).
