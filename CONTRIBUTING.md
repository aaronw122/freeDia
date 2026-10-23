# Contributing — freeDia

## Commit messages

One line, `type(scope): description`, **10 words max** for the whole message. No body. Rationale goes in the PR description or `plans/`/`notes/`.

```
feat(helper): queue prompts past max concurrent chats
fix(extension): reconnect native port after service worker restart
docs: document bunx install flow
test(helper): pin allowlist rejection of rpc bash
chore: scaffold bun workspaces
```

- `feat` adds a feature, `fix` fixes a bug; `docs`, `test`, `refactor`, `chore`, `build` cover the rest.
- Scopes: `helper`, `extension`, `ui`, `installer`, `e2e`.
- Breaking change: add `!` after the type, e.g. `feat(helper)!: drop helper.hello v1 fields`.

## PR description structure

Every non-trivial PR uses this structure. Keep **What** and **Why** to ~150 words each — concrete changes and reasoning only. No commit SHAs, ticket IDs, or rollout history in the description.

### What

What this PR does. Describe concrete behavior changes (in the chat bar, in the helper, on install), not a list of files.

### Why

Why this change exists and why this approach over alternatives. If other approaches were considered, name them and say why this one wins (fewer changes, simpler state, less logic in the extension, etc.). For bug fixes, identify the root cause — don't just describe the patch.

### Before / After

Evidence depends on the surface:

- **Chat UI / extension behavior:** screenshots or a short video of any change a user can see, in Chromium and (for shortcut or Dia-specific changes) in Dia. Non-visual changes get a one-line note of what to verify instead.
- **Helper / omp pipe:** the exact envelope and omp RPC records before and after (captured from a real omp run or the recorded spike fixtures), plus the numbers that changed (processes spawned, queue depth, respawn time, memory).
- **Contract / wire format:** the exact JSON, pinned in a helper test and reflected in the Contract section of `plans/freedia-plan.md`.
- **Installer:** the files written (native host manifest, `~/.freedia/bin`, omp install) on a clean `HOME`, and the browser connecting (`helper.hello` answered).
- **Docs / provenance only:** state what claim changed and what observation backs it.

### Test results

List the commands you ran and their outcome. Baseline: `bun test`, `bunx biome check`, `bun run build` for the extension, `bun build --compile` for the helper, and the Playwright e2e suite for anything that touches the chat flow. No screenshots of passing output required.

## Checklist

- [ ] Before/after evidence per surface (screenshots, RPC records + numbers, or pinned JSON)
- [ ] `bun test` and `bunx biome check` pass
- [ ] Extension builds and the helper compiles to a single binary
- [ ] E2E run for any change to the chat flow (send, stop, follow-up, model switch, history)
- [ ] Contract section of `plans/freedia-plan.md` updated for any envelope or helper-command change
- [ ] Read-only guarantees intact: omp launch flags unchanged or justified, helper allowlist still blocks `bash`
- [ ] No source comments; rationale in the PR description or `plans/` / `notes/`
- [ ] Follows existing patterns in `CLAUDE.md` / `AGENTS.md`
