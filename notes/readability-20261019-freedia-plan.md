# Readability review — freedia-plan

Date: 2026-10-19. Scope: `git diff origin/main...origin/feat/freedia-plan-integration`. Files reviewed: 31 (full target-ref contents, findings limited to added/changed regions).

Refs reviewed: base `90fbc8006323dcb3863c7a4b5e8a0025bc0f53ec`; target `15f5f0f04c13543f749167fa210306eea4ad9799`. `git fetch origin` was attempted first but failed because the sandbox denied writing the shared worktree's `FETCH_HEAD`; remote-ref freshness is unverified.

Excluded recorded pi JSONL transcripts, the lockfile, and notes prose. Reviewed all eight files under `e2e/spike/` lightly as throwaway code; no findings there warranted inclusion. Read CONTRIBUTING.md for conventions. No code was executed or modified.

## Summary

The protocol scaffold reads clearly: explicit request/reply types, short guards, and table-driven tests make the contract easy to follow. The fixture recorder carries most of the cognitive load, especially its multi-phase model-resume scenario, stream pump, and bottom-of-file orchestration. Four findings follow (0 HIGH, 3 Medium, 1 Low); all proposals preserve behavior, wire formats, prompts, and output strings.

## Findings by File

### /Users/aaron/code/personal/Projects/freeDia/.claude/worktrees/integration/packages/helper/test/fixtures/pi/record.ts

| # | Principle | Severity (HIGH/Medium/Low) | Issue (with lines) | Proposed Change |
|---|---|---|---|---|
| 1 | Chunking | Medium | Lines 351–438: `modelOverrideOnResume` interleaves session-file discovery/parsing with five process lifetimes and snapshots of persisted model changes. Understanding which observation belongs to which resume phase requires retaining the whole sequence. | Extract narrowly named phase functions for setting the model, probing a resume without a prompt, and resuming with a prompt; return named observations to the scenario. Keep the phase order, exact requests, waits, close/save points, and result keys unchanged. Move session-file reading into a separately named helper. |
| 2 | Consistent abstraction level | Medium | Lines 99–129: `pump` performs byte decoding, line framing, stderr recording, JSON parsing, and waiter dispatch inside nested loops. The transport mechanics obscure how a complete record reaches its waiting request. | Keep decoding/framing in `pump`; extract complete-line handling and matching-waiter dispatch into named private methods. Preserve parse-error propagation, the waiter-array snapshot and removal order, timestamp placement, and current trailing-buffer handling. |
| 3 | Newspaper ordering | Medium | Lines 744–784: the scenario registry, CLI selection, timing/error collection, and cleanup appear only after the transport class and every scenario implementation. A reader must reach the end of a 784-line script to discover its execution model. | Put a named `main` function and scenario registry near the top after configuration, followed by the transport implementation and scenario functions. Retain the actual `await main()` invocation after all required class/constant initializations so reordering does not change initialization or execution order. Preserve cleanup boundaries and scenario order. |
| 4 | Predictable patterns | Low | Lines 12–13: S1 calls its open JSON object `Json` and its RPC record `PiRecord`, while the scaffold defines the identical RPC shape as `PiRpcRecord` in the protocol module (lines 14–18). The duplicate vocabulary suggests a distinction that does not exist. | Use a type-only import of `PiRpcRecord` for the identical shape and rename the local `Json` alias to `JsonObject`. Keep the recorder's `isPiRecord` predicate local and behaviorally unchanged; it does not have the same acceptance rules as the scaffold guards. |

## Systemic Patterns

- Cross-agent naming and type-guard check: finding 4 is the actionable vocabulary divergence. S1 and S2 both narrow unknown values with object/null/property checks; the scaffold additionally excludes arrays. Do not unify those predicates by changing their accepted inputs. Function declarations versus arrow functions alone do not warrant a finding.
- Cross-agent script structure: S1's execution map is buried beneath implementation (finding 3); S2's Playwright hooks and named cases make its experiment sequence easier to scan. The faux extension similarly puts registration after its response factory, but at 90 lines this is a minor navigation cost, not a separate finding.
- Cross-agent error/log phrasing: S1 emits aggregate JSON results, S2 emits labeled observations, and the UA probe logs server activity. These serve different consumers; normalizing their strings or output formats would exceed a behavior-preserving readability review.
- Cross-agent config style: formatting and workspace script names are broadly consistent. S2's bare WXT config differs from the scaffold's `defineConfig` wrapper, but this small throwaway config does not justify a separate finding or shared-config abstraction.
- What reads well: the protocol's explicit unions and short guard clauses, the tests' named groups and data tables, and the faux provider's early-return dispatch expose intent without source comments. The changed plan contract is explicit about request IDs and chat-ID constraints.

## Suggested Fix Order

1. Split the model-resume scenario into named phases (1), preserving the experiment's exact sequence.
2. Separate stream framing from record handling and waiter dispatch (2).
3. Expose recorder orchestration near the top while keeping invocation after initialization (3).
4. Align the duplicate RPC type vocabulary with the scaffold (4).
