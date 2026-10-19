# Dia chat UI — verified facts for freeDia 1C

Sources: **B** = `strings -n 6 /Applications/Dia.app/Contents/MacOS/Dia` (dump: `/tmp/freedia-diaui/dia-strings.txt`, cited as `B:<line>`); **M** = live menu bar read via System Events (`/tmp/freedia-diaui/menus.txt`; AX modifiers 0=⌘, 1=⇧⌘, 2=⌥⌘, 4=⌃⌘, 8=no ⌘); **W** = web-chat bundle `Contents/Resources/web-chat-resources/dist/app/immutable/**`; **CL** = official changelog URL. The bundle ships no app `.strings`/`.xcstrings` (only Sparkle's). Swift stores strings of ≤15 bytes inline in code, so short labels like "Sidebar" don't show up in `strings`. Their localizer comments do, and those are what get cited here.

## 1. Version
- `Info.plist` CFBundleShortVersionString **1.52.0**, CFBundleVersion **88431**. The Dia menu shows `Install Update…, 1.53.0 (88760)` pending (M).

## 2. Shortcuts
- M: `File | Chat… | E | 0` → **⌘E**. `File | Focus Chat | E | 4` → **⌃⌘E**. `File | Open Command Bar | L | 0` → ⌘L.
- These are defaults, not customizations: the copied `~/Library/Application Support/Dia/User Data/keyboard_shortcuts_database.db` has empty `keyboard_shortcuts` and `action_priorities` tables.
- Action IDs (B:75126-75129): `toggleAskOnPage`, `newAskOnPage`, `focusAskOnPage`, `steerChatPrompt`. Descriptions: "Open or close Dia's chat." (B:75334-5); "Start a new Chat." (B:75210); "Focus your cursor on the Chat text box." (B:75212); "Send Chat Prompt Now … Stop the current Chat response and send the prompt now, ahead of queued prompts." (B:75330-2).
- **No ⌘⇧E anywhere** in Dia's Dia/File/Edit/View/Tabs/Bookmarks/History/Extensions/Window/Help menus (M). New Chat and Send Now don't appear in the menu bar either, so their default keys are unknown.
- Rebindable: "If you're curious about our other shortcuts (or want to make a few of your own) head to **Dia → Settings → Shortcuts** … If a combination doesn't feel natural, you can change it." — https://www.diabrowser.com/release-notes/1-21-0-before-you-reach-for-it. B:78357 "Select an action to customize its keyboard shortcut."; B:78361 "(not remappable)"; B:78358 "This shortcut conflicts with another shortcut:".

## 3. Chat surface
- Three placements (B:83945-7, `AssistantPanel/AssistantPanelHeaderView.swift`): "Title for menu action to open assistant in **sidebar view**" / "… in **floating view**" / "… in **a new tab**". Nearby SF Symbols: `inset.filled.bottomtrailing.rectangle`, `inset.filled.rightthird.rectangle` (B:83939-40).
- Resizable/draggable floating view: **no string found** → unverified.
- Prior pass said "sidebar, not floating overlay". **That's wrong**; the floating view exists.

## 4. Header / composer controls
- Header: personalization button, "Tooltip for personalization button when active/inactive" (B:83943-4). CL 0.44.0: "Temporarily disable Personalization … by clicking the signature button on the top right corner." https://www.diabrowser.com/changelog/mac/0-44-0. The view-mode menu (§3) also lives in `AssistantPanelHeaderView`.
- Model choice is in the **composer toolbar**, not the header: `BoostCommandBar … ModelSelection … ToolbarViewModel` (B:22601-5). Labels: "Most capable Claude model", "Advanced reasoning & coding", "Great for most tasks" (B:57392-5); "Continue with high reasoning" (B:79387).
- Composer: placeholders "Ask a question" / "Ask a question about this page" / "Ask another question" (B:82228-31); "Add a tab or file" (B:79378); "Send (Enter)" (W `aria-label`).
- History: `ChatHistoryPanel` with "Title for list of recent chats" (B:84948); "Delete this chat?" (B:85502); "Clear All Chat History" (B:85500).
- A header **"+" or close button: no string found** (could be inline short labels) → unverified.

## 5. Highlighted text
- An attachment type: `DynamicTextSelectionAttachmentDataSource` (B:16592) with label "Selected Text" (B:16680). Prompt capability: "Selected text on page — The user is referencing the selected text on the page which should be attached." (B:57042-3).
- Commands `PCAskAboutSelectionCommand` / `ask_about_selection` (B:6883, 6978); attachment chip type `PCAttachmentChip` (B:6881).
- In-thread quoting of *responses*: `HeaderQuoteAttachmentButton` tooltip **"Ask about this"** (B:83139-40).
- What a selection chip looks like on screen → [INFERENCE] attachment chip in the composer; not observed.

## 6. Page context
- Current tab auto-attached: `isAutoAttachedForTab` (B:68468). Prompt capability: "The user is referencing the current webpage which should be attached." (B:57047).
- Other tabs are added manually: "Type @ to mention a tab" / "Mention tabs to add context" (B:82158-9). CL 1.53.0: "When you ask about the page you're on or @-mention a tab, Dia reads it right away" https://www.diabrowser.com/changelog/mac/1-53-0.
- Behavior after navigating: **no source found** → unknown.

## 7. Chat scope and history
- Page-anchored chats: Library filter "page-anchored chats (Ask on Page)" (B:85743); `tabChats`, "No chats with tabs" (B:85756, 85784); context menu "Chat With This Tab … open a new Dia chat for this tab" (B:85325-6).
- Library: "Your chats and files", "Chats you start and files Dia makes will show up here." (B:85777-81); search placeholder (B:85802); "This chat will be permanently deleted." (B:85760).
- CL 1.50.0: "Dia can search and read past chat sessions by date window, chat titles, or keywords from old chats." https://www.diabrowser.com/changelog/mac/1-50-0. This is search by the agent (tool), not necessarily a UI search box.
- Per-tab *window* binding (one chat panel per tab) → [INFERENCE]; not directly stated.

## 8. Loading, streaming, stop, queue
- W: `role="status">Thinking…`; `aria-label="Loading response"`; `aria-label="Thinking"` (pending dots); "Working notes"; "Writing"; "Analyzing".
- Queue/steer: "Send now and skip the queue" (B:79383); "Stop the current response and send now" (B:82295); "Button that deletes a queued prompt" / "edits a queued prompt" (B:83463-4); "Header shown when the queued prompt drawer is paused" (B:83466).
- CL 1.51.0: "Queue multiple chat messages and steer Dia mid-response without cancelling in-flight tool calls." CL 1.52.0: "'Send now' interrupts immediately, while clearer queue and stop controls make it easier to steer the conversation." https://www.diabrowser.com/changelog/mac/1-52-0
- CL 1.50.0: "Stop and resume AI responses — Pause an AI response mid-stream and resume it"; "Continue response" (B:79377); "Generation cancelled" (B:82306).
- Closing mid-response: "Cancel this response? … The assistant is still responding. Closing this tab will cancel the in-progress response." (B:82219-21).
- "Starting…" (prior pass): **not found**.

## 9. Errors (user-facing)
- Usage: "You've reached your usage limit. Please try again later." / "… Please try again in %@." (B:82336-8); "You are nearing your usage limit." (B:79128); "Button title for resending a Chat query after usage resets" (B:82497).
- Network: "There was a network error. Please check your connection and try again." (B:36181).
- Integrations: "Your connection to %@ expired. Reconnect to keep using it in Chat." (B:64053).
- Enterprise policy: "Chat is restricted on this page by your organization" (B:83791).
- B:56439-49 ("LLM rate limited", "Assistant response failed while offline") look like analytics event names, not UI copy.

## 10. Message rendering
- Markdown types: `Markdown … BlockQuote … CustomBlock` (B:7227-31); Highlightr syntax highlighting (`Highlightr_Highlightr.bundle`, B:22006-25); "Copy code button title" (B:82322).
- Citations: "Inline source pill label for Slack integrations." (B:82709).
- Tool receipts: "Title for an in-progress/completed <tool> tool call" (B:82861-904).
- Per-message actions (W): "Copy", "Copy as text", "Copy as image", "Edit message", "Helpful", "Needs improvement". Rich blocks (W): `table`, `imageCarousel`, `webContentCarousel`, `video`.

## Spec vs Dia
| 1C spec item | Dia (sourced) | Recommendation |
|---|---|---|
| Floating window | Floating is one of 3 modes: sidebar, floating, new tab (§3) | **Match** floating; sidebar/new tab stay out of v1 |
| Drag/resize/expand persisted | No source | Keep (freeDia need, ENSURE 8) |
| Header: model picker | Model picker sits in the composer toolbar (§4) | **Diverge from spec / match Dia**: move it into the composer |
| Header: "+", history, close, expand | History panel + delete exist; "+" and close unverified; view-mode menu in header (§3-4) | Keep "+"/history/close; "expand" ≈ Dia's view-mode switch |
| Quote chips + re-highlight | Selection is an attachment ("Selected Text") (§5) | **Match** as composer chips |
| Page context on every message | Current tab auto-attached; other tabs via @ (§6) | **Match** auto; @tab stays out of scope |
| Loading "Starting…" / "Waiting…" | Dia shows "Thinking…" / "Loading response" (§8); "Starting…" not found | Keep freeDia states (process spawn/queue are freeDia-specific); use "Thinking…" while waiting for the first token |
| Stop button | Stop + resume + "Send now" queue (§8) | Match stop; queue/steer stay out of v1 |
| Error states | Usage-limit-with-reset-time, network, reconnect copy (§9) | Match tone; add retry-after where pi provides it |
| Markdown + code | Markdown, highlighted code, copy code (§10) | **Match**; add copy-code button |
| History list/reopen/delete | Recent chats panel, delete confirm, Library search (§4, §7) | Match list/delete + confirm dialog |
| Shortcut Cmd+E (Dia) | ⌘E = Chat… default, rebindable (§2) | freeDia Cmd+E **will clash** with Dia's default |
| Cmd+Shift+E (Chrome default) | Not bound in any Dia menu (§2) | Safe in Dia too |

## Proposed 1C amendments
1. **Risks:** strike "Dia's own Cmd+Shift+E opens Dia's sidebar". No Dia menu item binds ⌘⇧E (§2, M). Note instead that Dia's default ⌘E is "Chat…" (toggleAskOnPage), rebindable in Dia → Settings → Shortcuts.
2. **1B/first-run copy:** in Dia mode, tell users to unbind or rebind Dia's "Chat…" (⌘E) in Dia → Settings → Shortcuts if S2 shows Dia wins (§2 rebindable quote).
3. **1C header:** move the model picker from the header into the composer toolbar beside Send, matching `BoostCommandBar/ModelSelection` (§4).
4. **1C composer:** placeholder "Ask a question about this page" before the first message, then "Ask another question" (B:82228-31); Send tooltip "Send (Enter)" (§4).
5. **1C quotes:** show the highlight as a composer attachment chip labeled "Selected Text" with a remove control (§5). Re-highlight adds another chip.
6. **1C loading:** add "Thinking…" (W) between `prompt` accepted and the first delta, keeping "Starting…" / "Waiting for another chat to finish…" for helper states (§8).
7. **1C stop:** confirm before closing the overlay mid-stream, using Dia's copy pattern ("Cancel this response?", B:82219) — or let it continue in the background. One of these needs a decision; ask the user.
8. **1C rendering:** add a copy-code button to code blocks and per-message "Copy" (§10).
9. **1C history:** use a "Delete this chat?" confirm (B:85502).
10. **1C errors:** for rate limits, include the reset time when pi gives one ("Please try again in %@", B:82338).
