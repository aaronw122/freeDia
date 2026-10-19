# Spike S2 — browser (shortcuts, Dia detection, Document PiP)

Date: 2026-10-19. Machine: macOS 26.5.2 arm64.

## Setup

- **Chromium:** Playwright 1.64.1 bundled Chromium (Chrome for Testing) **156.0.8078.4**, revision 1248. Runs were headless (`chromium` channel, new headless) and headed (`SPIKE_HEADED=1`).
- **Dia:** `/Applications/Dia.app` 1.52.0 (build 88431), bundle id `company.thebrowser.dia`. Its Chromium engine is `ArcCore.framework`, `CFBundleShortVersionString` **155.0.8059.40**.
- **Spike extension:** a throwaway WXT project in `e2e/spike/extension/`, separate from `packages/extension`, which is untouched. Its manifest has `permissions: ["storage", "tabs"]` and the command `open-chat` with `suggested_key { default: "Ctrl+Shift+E", mac: "Command+Shift+E" }`.
  - The background script logs `chrome.commands.onCommand` to `chrome.storage.local.commands` and forwards the command to the tab.
  - The content script runs on all http/https pages at `document_idle`. It adds a capture-phase `keydown` listener on `window`, and a shadow-DOM host with an "open PiP" button and a "count" button. It writes its state to `<html data-spike-cs="…">`.
- **Build:** `e2e/spike/build.sh` builds with `packages/extension`'s WXT 0.21.4 (it temporarily symlinks that package's `node_modules`). Output: `e2e/spike/extension/.output/chrome-mv3`.
- **Fixture:** `e2e/spike/fixture-server.ts` serves an https page on `https://localhost:<port>` with a throwaway self-signed cert; Playwright uses `ignoreHTTPSErrors`. The page's own script has a page-world PiP button and a document-level `keydown` logger, and writes `data-spike-page`.
- **UA probe:** `e2e/spike/ua-probe.ts` is a plain http server on `127.0.0.1:47801` (localhost is a secure context). It reports `navigator.userAgent`, `userAgentData` (low and high entropy), `window.chrome` keys, the list of `window` globals, and whether `documentPictureInPicture` exists.
- **Run:** `e2e/spike/build.sh && cd e2e && bunx playwright test -c spike/playwright.config.ts`. Add `SPIKE_HEADED=1` for the two OS-keystroke tests, which need a real focused window plus macOS Accessibility permission for `osascript`.

## (a) `chrome.commands` with Command+Shift+E

Observed:

- **Registration:** in a fresh Chromium 156 profile, `chrome.commands.getAll()` returns `[{"name":"open-chat","description":"Open freeDia chat","shortcut":"⇧⌘E"}]`. The suggested key was assigned, so Chromium had no conflict.
- **Playwright cannot fire extension commands.** `page.keyboard.press("Meta+Shift+E")` in both headless and headed mode left `commands` empty (`[]`). The keydown for `KeyE` with `meta:true, shift:true` reached both the content script and the page instead. Playwright key events go straight to the renderer, so browser-level accelerators never see them.
- **A real OS keystroke does fire the command.** In headed Chromium, `osascript` (System Events `keystroke "e" using {command down, shift down}`, sent only when "Google Chrome for Testing" was frontmost) produced:
  - `commands: [{"command":"open-chat","tabId":…}]`
  - Content script `commandsReceived: ["open-chat"]`
  - Content script `keys: []`: the page and content script got **no** keydown, because the browser consumed the accelerator.
- **PiP from the command works.** The content script received the command message from the service worker, and `navigator.userActivation.isActive` was `true` at that moment. `documentPictureInPicture.requestWindow` then opened (`result: "opened"`).
- **Reliability:** observed 2 of 3 headed runs. In the third, Dia was frontmost (the user was using it), so the guard skipped the keystroke. That run is not a failure of the command.

**What can be tested automatically:**
- Manifest registration: `chrome.commands.getAll()` from the service worker. Works headless and in CI.
- The content-side handler, by sending the same message from the service worker. [INFERENCE] Messages sent that way carry no user activation, so PiP from them would be rejected (see the no-activation result in (d)).
- The real accelerator only through OS-level input (`osascript`) on a headed local run. Not suitable for CI.

[NOT VERIFIED] Whether Google Chrome (branded, not Chromium) also assigns ⇧⌘E without a conflict. Chrome is not installed.

## (b) Content-script keydown Cmd+E

Observed in Chromium 156:

- **Playwright `page.keyboard.press("Meta+e")`:**
  - The content script's capture listener on `window` received `{key:"e", code:"KeyE", meta:true, shift:false}`.
  - It called `preventDefault()` + `stopImmediatePropagation()`, and the page's `document` keydown listener logged only `Meta`, never `e`.
  - PiP opened from that keydown (`userActivation:true`, `result:"opened"`).
- **OS-level Cmd+E via `osascript`, headed, two runs:**
  - The content script received the `KeyE` + meta keydown both times. Chromium's own Cmd+E menu item ("Use Selection for Find") did not stop the page from receiving it.
  - The page listener again saw nothing, and PiP opened from the keydown.
  - [NOT VERIFIED] Whether `preventDefault` also suppressed Chromium's "Use Selection for Find" action. The find pasteboard was not inspected.
- [INFERENCE] Page listeners on `window` in the capture phase that were registered before `document_idle` would run before the content script's listener. Registering at `document_start` avoids this.
- **Dia:** not automated (manual by design). Dia's Cmd+E may be a browser-level accelerator. If it is, the (a) result shows the page/content script will **not** receive the keydown at all, the same way Chromium swallows ⇧⌘E. Manual check B decides this.

## (c) Dia detection via `navigator.userAgentData.brands` / UA

**Dia, observed** by opening the probe in the user's running Dia with `open -a Dia http://127.0.0.1:47801/?from=dia`:

```json
{
  "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  "vendor": "Google Inc.",
  "brands": [{"brand":"Chromium","version":"155"},{"brand":"Not(A:Brand","version":"24"}],
  "fullVersionList": [{"brand":"Chromium","version":"155.0.8059.40"},{"brand":"Not(A:Brand","version":"24.0.0.0"}],
  "platform": "macOS", "platformVersion": "26.5.2", "architecture": "arm",
  "chromeKeys": ["app","csi","loadTimes"],
  "hasDocumentPictureInPicture": true, "isSecureContext": true
}
```

**Playwright Chromium 156, headed, for comparison:** same UA shape (`Chrome/156.0.0.0`), `brands: [{"Not:A-Brand","8"},{"Chromium","156"}]`, same `chromeKeys`. Headless differs only by `HeadlessChrome/` in the UA.

**Findings:**
- Dia has **no Dia brand** and **no "Google Chrome" brand**. Its UA string is a stock Chrome UA.
- The `window` globals present only in Dia were `SENTRY_RELEASE`, `_sentryDebugIdIdentifier`, `_sentryDebugIds`, `bitcoin`, `cardano`, `effect/GlobalValue`, `midnight`, `webpackChunklace_extension`. [INFERENCE] These come from extensions installed in the user's Dia profile (wallet extensions), not from Dia itself. The profile was not isolated, so this is not a usable signal.
- Globals present only in Chromium: `IdentityCredential`, `IdentityCredentialError`, `IdentityProvider`, `NavigatorLogin` (FedCM). [INFERENCE] This could be a Dia build flag or the 155→156 version gap. It is not a reliable detector either way.
- **Result: Dia cannot be detected from brands/UA.** The only brand-based heuristic is "has `Chromium` but no `Google Chrome` brand" ⇒ "Chromium-based, not Chrome". That also matches Arc, Brave without its brand, Chromium, etc.
- An isolated Dia launch was tried and failed: `/Applications/Dia.app/Contents/MacOS/Dia --user-data-dir=/tmp/… --remote-debugging-port=9333 --load-extension=…` produced no CDP endpoint, no files in the new user-data dir, and no log output. [INFERENCE] The flags are ignored or handed to the already-running instance. Dia was not quit to retry, to avoid disrupting the user.
- [INFERENCE, NOT VERIFIED] **Helper-side detection:** the browser launches the native-messaging host, so the helper's parent process (`ppid` → executable path) would be `/Applications/Dia.app/...` versus Chrome. That would make Dia detection exact. Needs a check in 1A.
- **Native messaging path:** Dia's user-data dir is `~/Library/Application Support/Dia/User Data/` (observed: it contains `Default`, `Profile 2`, `Local State`, `RunningChromeVersion -> 155.0.8059.40`). It is **not** `~/Library/Application Support/Dia/`. `NativeMessagingHosts/` does not exist there yet.
  - `strings` on `ArcCore` shows the literal `NativeMessagingHosts` plus the system paths `/Library/Google/Chrome/NativeMessagingHosts` and `/Library/Application Support/Chromium/NativeMessagingHosts`.
  - [INFERENCE] Chromium resolves the per-user host dir as `<user-data-dir>/NativeMessagingHosts`, so Dia's would be `~/Library/Application Support/Dia/User Data/NativeMessagingHosts/`. [NOT VERIFIED] Whether Dia reads it.

## (d) Document Picture-in-Picture

Observed in Chromium 156 (headless and headed, same results), on the https fixture:

| Trigger | World | Result |
|---|---|---|
| Click on the content-script button inside shadow DOM | isolated | `opened` (`userActivation:true`) |
| Content-script capture `keydown` Cmd+E (Playwright) | isolated | `opened` |
| Content-script `keydown` Cmd+E (real OS keystroke) | isolated | `opened` |
| `chrome.commands` ⇧⌘E (real OS keystroke) → SW → `tabs.sendMessage` → content script | isolated | `opened` (`userActivation:true`) |
| Click on a page button | page (main) | `opened` |
| `setTimeout` after load, no gesture | page (main) | `NotAllowedError: Failed to execute 'requestWindow' on 'DocumentPictureInPicture': Document PiP requires user activation` |

- **Moving the UI into PiP:**
  - The content script moved its shadow-DOM host into the PiP document with `pipWindow.document.body.append(host)`, and `host.ownerDocument === pipWindow.document` held.
  - Clicking the "count" button **inside the PiP window** ran the content script's listener: `clicks` went to 1 and was reported on the opener page. Listeners and closures from the isolated world keep working after the move.
- **Tab switches:**
  - With PiP open, opening a second tab, navigating it, and bringing it to front left the PiP open (`isClosed() === false`).
  - Switching back left it open.
- **Opener navigation:** a full navigation of the opener tab (`page.goto`) **closed** the PiP.
- **Second PiP:** opening a PiP from a second tab while the first tab's PiP was open **closed the first** (its `pagehide` fired and the host returned to the opener page, `hostBackInPage:true`), and the second stayed open. Only one Document PiP window can be open at a time.
- **Dia:** `documentPictureInPicture` is present (`hasDocumentPictureInPicture:true` on a secure page). Opening it from an extension in Dia is not verified; see manual check D.
- [NOT VERIFIED] In-page SPA navigations (pushState) were not tested.

### PiP verdict: **GO (conditional on manual check D in Dia)**

Evidence: in Chromium, Document PiP opens from the content script's isolated world on every user-activated trigger freeDia uses (click, Cmd+E keydown, ⇧⌘E command). The live content-script UI can be moved into it and stays interactive, and it survives tab switches. Constraints for 2.2:
- Only one PiP at a time across the browser.
- PiP closes when the opener tab navigates.
- PiP needs a user gesture.

If manual check D fails in Dia, PiP should be Chrome-only rather than dropped.

## Manual checks for Aaron in Dia

Prep (once):

1. In a terminal: `cd /Users/aaron/code/personal/Projects/freeDia/.claude/worktrees/spike-s2 && e2e/spike/build.sh`. The unpacked extension is at `/Users/aaron/code/personal/Projects/freeDia/.claude/worktrees/spike-s2/e2e/spike/extension/.output/chrome-mv3`.
2. In Dia, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the folder above. Confirm "freeDia spike S2" appears enabled.
3. Open `chrome://extensions/shortcuts` in Dia. **Observe and record:** does "freeDia spike S2 → Open freeDia chat" show **⇧⌘E** or is it blank (blank means Chromium dropped it because of a conflict)?
4. Open `https://example.com` in a normal Dia tab. Open DevTools (⌥⌘I) → Console. Read state with `JSON.parse(document.documentElement.dataset.spikeCs)`. `world` should be `"isolated"` and `hasPipApi` should be `true`. Two small buttons, "content-script: open PiP" and "count", appear at the bottom of the page.

A. Content-script click → PiP (baseline):

1. Click **content-script: open PiP**.
2. **Observe:** a small "freeDia spike PiP" window appears with both buttons in it, and they are gone from the page. In the console, the last `pip` entry has `result: "opened"`. If it shows `error: …`, copy the text.

B. Cmd+E (Dia's chat shortcut) vs the content script:

1. Close any PiP window. Click on the example.com page body (not the address bar) and select a few words.
2. Press **Cmd+E**.
3. **Observe:**
   - (i) Does Dia's own chat bar or sidebar open?
   - (ii) Does the freeDia spike PiP open?
   - (iii) In the console, `keys` contains an entry `{code:"KeyE", meta:true, shift:false}`, and `pip` has a `trigger: "cs-keydown-cmd-e"` entry.
   - If `keys` has no `KeyE` entry, Dia consumed Cmd+E before the page (the content script cannot win). If it has one and Dia's chat **also** opened, `preventDefault` cannot block Dia.
4. If Dia has a setting to change or disable its Cmd+E shortcut, turn it off, repeat steps 1–3, and note the setting's exact location.

C. Cmd+Shift+E (extension command) in Dia:

1. Close any PiP. Click the example.com page body.
2. Press **Cmd+Shift+E**.
3. **Observe:**
   - (i) Does Dia's own sidebar or another Dia feature open?
   - (ii) Does the spike PiP open?
   - (iii) Console: `commandsReceived` contains `"open-chat"`.
   - (iv) On `chrome://extensions`, click the extension's **service worker** link. In that console run `await chrome.storage.local.get("commands")` and expect an `open-chat` entry with a timestamp.
4. If ⇧⌘E was blank in Prep step 3, assign **⇧⌘E** (and separately try **⌘E**) on `chrome://extensions/shortcuts`, then repeat. Note whether Dia warns about or rejects the binding.

D. PiP lifetime in Dia:

1. Open the PiP with the page button (A1). Click **count** inside the PiP window twice. Back on the page, run the console state command: `clicks` should be `2`.
2. Press Cmd+T, open `https://example.org`, and stay there 5 seconds. Then switch back with Ctrl+Tab. **Observe:** the PiP window stays open the whole time.
3. Switch to another Dia window or space and back. **Observe:** PiP still open.
4. Open the PiP again from a **second** example.com tab. **Observe:** the first tab's PiP closes and the second's opens. This is Chromium's one-PiP-at-a-time behavior.
5. In the opener tab, click the "More information…" link (full navigation). **Observe:** PiP closes.
6. Report any deviation from Chromium: PiP not opening, closing on tab switch, or opening in a Dia-styled panel instead of a floating window.

E. Cleanup: on `chrome://extensions`, remove "freeDia spike S2".

## Contract/plan amendments (proposed; plan not edited)

1. **Dia detection:** drop "Dia detected via `navigator.userAgentData.brands`/UA" from 1B and notes ("Dia detected, or chosen at first run").
   - Observed: Dia 1.52.0 reports only `Chromium` + GREASE brands and a stock Chrome UA.
   - Make the first-run "Using Dia?" toggle the source of truth.
   - Optional 1A follow-up [INFERENCE]: add a `browser` field to `helper.hello`'s reply, derived from the helper's parent process path. That would give exact detection if confirmed.
2. **Native host path for Dia (1A installer):** `~/Library/Application Support/Dia/User Data/NativeMessagingHosts/com.freedia.helper.json`, not `~/Library/Application Support/Dia/NativeMessagingHosts`. [INFERENCE] Based on the observed user-data dir; must be verified when 1A first connects from Dia.
3. **Content-script key handler (1B):**
   - Register a capture-phase `keydown` listener on `window` at `run_at: "document_start"`, match `metaKey && code === "KeyE" && !shiftKey`, and call `preventDefault()` + `stopImmediatePropagation()`.
   - Match on `event.code`, not `key`. Observed: `key` was `"e"` without Shift and `"E"` with it.
   - Whether this works in Dia depends on manual check B.
4. **Command → UI path (1B):** the service worker forwards `chrome.commands` `open-chat` to the tab via `tabs.sendMessage`. Observed: the content script still has user activation at that point, enough for `requestWindow`.
5. **E2E (2.3, ENSURE 13):**
   - Playwright cannot trigger `chrome.commands` accelerators. Test the ⇧⌘E path as registration (`chrome.commands.getAll()` shows `⇧⌘E`) plus a content-side handler test via SW message.
   - Cmd+E is testable with `page.keyboard.press("Meta+e")`.
   - The real accelerator stays manual, or a headed local-only `osascript` test (needs Accessibility permission; not for CI).
6. **PiP (2.2 stays stretch, now GO):**
   - Open PiP only inside a user-gesture handler (button click, Cmd+E keydown, or command message), and move the existing shadow-DOM chat host into `pipWindow.document`. No new UI instance or port is needed.
   - Re-attach the host to the page on PiP `pagehide`.
   - Document the limits: one PiP browser-wide (opening a second tab's float closes the first), and it closes on full navigation of its tab.
   - ENSURE 9: E2E is automatable in Playwright Chromium (button click → `context.waitForEvent("page")` → `about:blank` PiP page).
7. **Manifest (1B):** `suggested_key { default: "Ctrl+Shift+E", mac: "Command+Shift+E" }` is accepted by Chromium 156 without a conflict. Whether Dia needs it unbound depends on manual check C.
