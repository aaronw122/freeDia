# freeDia

freeDia adds a page-aware AI chat to Dia and Chrome. Press a shortcut on any web page, then ask about the page from the **Ask about this page** chat.

The browser extension is UI only. A native helper acts as a plain pipe between the extension and [omp](https://github.com/can1357/oh-my-pi), and omp owns the conversation, including context, follow-ups, models, and sessions.

## Install

Run:

```sh
bunx freedia install
```

The installer:

- installs the compiled helper at `~/.freedia/bin/freedia-helper`;
- installs omp 18.12.1 under `~/.freedia/omp`;
- writes the Chrome native-host manifest used by Chrome and Dia; and
- guides you through installing the extension.

For development, build the extension and load `packages/extension/.output/chrome-mv3` as an unpacked extension from `chrome://extensions` with Developer mode enabled.

## Sign in

Sign-in providers come from omp's `omp login` flow. The installer starts this flow when no provider is configured. To run it again later:

```sh
bunx freedia login
```

omp supports subscription OAuth providers such as ChatGPT Plus/Pro Codex, Claude Pro/Max, GLM Coding Plan, Kimi, and OpenRouter, as well as API-key providers. The available choices are shown by omp and may change with its provider catalog.

Check the helper, native-host manifest, omp installation, and provider sign-in with:

```sh
~/.freedia/bin/freedia-helper doctor
```

## Shortcuts

- **⌘E** is the default. The onboarding shortcut picker lets you keep it or choose another combination, and you can change it later in settings.
- **⇧⌘E** always works as the backup shortcut.
- **Dia users:** turn off Dia's own ⌘E shortcut in Dia → Settings → Shortcuts, or choose another freeDia shortcut.

## Privacy and local data

freeDia has no telemetry. Page text is sent to the model provider you signed in to so that the model can answer questions about the page.

All helper and omp state is kept under `~/.freedia`:

```text
~/.freedia/
├── bin/                         # compiled freedia-helper
├── omp/                         # pinned omp installation
├── omp-agent/                   # freeDia-specific omp configuration and sign-ins
├── home/                        # isolated home used while omp runs
├── chats/<chatId>/              # one omp session directory per chat
└── pages/<chatId>.md            # temporary full-page text, 60-minute unused TTL
```

The page file is also removed when its chat is cleared or deleted, and the pages directory is cleared when the helper starts. The installer writes the native-host manifest to Chrome's `NativeMessagingHosts` directory so Chrome and Dia can start the helper.

## Development

This repository is a Bun workspaces monorepo:

- `packages/helper` — native-messaging helper, installer, and omp process management
- `packages/extension` — WXT/React MV3 extension
- `e2e` — Playwright tests using Chromium, the real helper, and a local faux provider

Install dependencies, then use the repository checks:

```sh
bun test
bunx biome check
bun run typecheck
bun run build
bun run e2e
bun run demo
```
