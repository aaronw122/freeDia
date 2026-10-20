# Readability review brief — freedia-plan (Bucket 0)

REPORT-ONLY. Do not edit any source file, do not commit, do not switch branches or run `git checkout`. The only file you write is the report below.

## Scope

`git diff origin/main...origin/feat/freedia-plan-integration` (run `git fetch origin` first). Read full changed files for context; critique only changed/added regions.

Skip: `packages/helper/test/fixtures/pi/*.jsonl` (recorded transcripts), lockfiles, `notes/*.md` prose. `e2e/spike/` is throwaway spike code; review it lightly (at most 3 findings) and say so.

## The 7 principles (assign every finding to exactly one)

1. **Newspaper ordering** — public API / entry points near the top, private helpers below.
2. **Naming as narrative** — names tell the story without comments; if a name needs a comment, the name is wrong.
3. **Chunking** — related logic grouped; long functions broken into named steps.
4. **Guard clauses over nesting** — early returns flatten deep conditionals.
5. **Signal-to-noise** — no dead code, no redundant comments, every line earns its place.
6. **Consistent abstraction level** — one altitude per function.
7. **Predictable patterns** — similar things look similar; new code matches surrounding idioms.

## Cross-agent consistency check

Three agents wrote this independently: scaffold (`packages/helper/src/protocol.ts`, tests, configs), spike S1 (`packages/helper/test/fixtures/pi/record.ts`, `faux-extension.ts`), spike S2 (`e2e/spike/`). Flag gratuitous divergence between them: naming, type-guard style, error/log phrasing, script structure, config style.

## Constraints

- Behavior-preserving proposals only; no logic or contract (wire format) changes.
- Project rule: no source comments (CONTRIBUTING.md). Don't propose adding comments. Don't flag the absence of comments.
- Don't propose changing product copy or prompt text wording.
- Prefer a few high-impact findings over nitpicks. Note what reads well.

## Output

Write `notes/readability-20261019-freedia-plan.md`, under ~100 lines:

- Header: date, scope, files reviewed count
- **Summary** — 2–3 sentences
- **Findings by File** — per-file table: `# | Principle | Severity (HIGH/Medium/Low) | Issue (with lines) | Proposed Change`
- **Systemic Patterns**
- **Suggested Fix Order**
