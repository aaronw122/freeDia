# Page-text cap research (primary evidence)

Pinned sources: brave-core `ddcec722ed2ac7f5bebf8d3a5d071a8f44a9a725` (2026-10-19) · chromium `dccf6b1d5179305842f58015bf6f24e414536999` · firefox `main` (SHA in /tmp/freedia-textcap/ff/SHA) · page-assist `ad6ef90a9b4b860bbdfc81ee82111c8e04502c65` · Dia.app 1.52.0 (build 88431), ArcCore Chromium 155.0.8059.40.

## 1. Brave Leo (brave-core, `components/ai_chat/…`)
- **Cap is per model, in UTF-8 bytes, server-supplied.** `max_associated_content_length` is set per model in `core/browser/model_service.cc`: 180,000 (automatic, claude-sonnet: L110, L136); 64,000 (qwen, glm-flash, claude-3-haiku, kimi: L163, L190, L296, L322); 1,200,000 / 1,088,000 (gpt-5.6/grok bedrock: L217, L243, L268). The remote model list can override it (`remote_models_serialization.cc` L151-199).
- **Custom (BYO) models:** `(context_size − 300 − 400) × 4` (`model_service.cc` L718-738; `constants.h` L76-79: `kDefaultCharsPerToken=4`, `kReservedTokensForPrompt=300`, `kReservedTokensForMaxNewTokens=400`). Default custom context is 4,000 tokens, so the cap is 13,200 (`model_validator.h` L31-32). Allowed range goes up to 2,000,000.
- **Truncation is head-only.** `GetContentBlockFromAssociatedContent` → `base::TruncateUTF8ToByteSize(content, remaining)` (`engine/oai_message_utils.cc` L97-116), so it keeps the first N bytes. With several tabs it walks newest-first and the oldest tab gets truncated (L158-191). UI shows `content_used_percentage` (`associated_content_manager.cc` L480-510). Title generation uses only 1,200 chars (`constants.h` L83).
- **Extraction (default path):** an AX-tree snapshot with `max_nodes=9000` and a 4 s timeout (`renderer/page_text_distilling.cc` L161-166). It keeps main/article roots and heading/paragraph/note nodes and skips nav/banner/footer/button/etc. (L48-75). If that yields nothing, it falls back to `document.body.innerText` (L194-197). Per-site distiller scripts are on by default (`features.cc` L118; `resources/custom_site_distiller_scripts/`). Chromium AnnotatedPageContent extraction exists but is gated by `kAIChatDetailedPageContentExtraction`, which is **disabled by default** (`features.cc` L100-101; `associated_web_contents_content.cc` L94-100). AIPageContentAgent is used only as an empty-content fallback (L263-268). Brave does not use Readability.
- **PDF:** handled through PDFDocumentHelper text (`associated_web_contents_content.cc` L204-218, `pdf_text_helper.cc`). **YouTube:** fetches the InnerTube transcript (`renderer/page_content_extractor.cc` L49-68, L145-160). TED uses VTT tracks (L95-99). Transcripts share the same byte budget.
- **Selection/highlight:** sent as a separate `PageExcerptContentBlock` from `selected_text`, **with no truncation applied** (`oai_message_utils.cc` L446-450).

## 2. Dia 1.52.0 (strings over `MacOS/Dia`, `ArcCore`, `libAIInfra`, `libContentConversion`, `Resources/agent-server-resources`)
- **No numeric page-context cap found** in strings or JSON/YAML resources. Swift integer constants don't show up in `strings`, so a hard-coded cap can't be ruled out: `unknown`.
- **Budget/packing machinery exists:** `TabDataProvider` + `truncatingTextContent(totalCharacterBudget:)`, "Expected a character limit for each tab content", `TabDataTruncation`, `formattedForLLM(truncateToTokens:isPlaceholder:)`, `ContextWindowBuilder`/`ContextWindow+Impl.swift` with "squish iterations", `canTruncateToLength`/`canOmit`/`omissionMessage`, and telemetry keys `supertab.prompt_packing.token_budget`/`largest_slot_chars`/`discarded_entries`. [INFERENCE] Dia packs tabs into a token budget and squishes the largest slots. The budget value isn't in the binary strings, so it's likely runtime/server config, but that's unverified.
- **Extraction:** `ADK/BrowserContext+PageContentExtraction.swift` and `ArcExtractedPageContent`/`ArcContentNode` (ObjC bridge). ArcCore contains `AnnotatedPageContentRequest::RequestAnnotatedPageContentSync`, `…::RequestPdfText`, `GetAIPageContent SYNC`, and `enablePageContentExtraction` (a feature flag). [INFERENCE] Dia uses Chromium's AnnotatedPageContent (APC) plus PDF text, not Readability. The "readability" hits are Chromium Reading Mode metrics or prompt prose. `setReadabilityHandler:` is an unrelated ObjC selector. `maxContextLength`/`minContextLength` sit beside `maxNewTokens`/`numBeams`/`input_ids`, which is on-device model config, not page text.
- **Highlight:** `selectedText`, `selectedTextAttachmentID`, `hasSelectedText`, `SelectedTextPopover`. Selected text is its own attachment; no cap string found.
- Agent tools: `read_tabs(contentPaneIDs, includeFullTextContent)` takes no char-limit parameter (`resources/tool-schemas/dia.json`). `get_figma_file.maxCharacters` defaults to 100,000 (max 200,000), but that's Figma only. The ask-on-page skill says "If content appears truncated, acknowledge…" (`prompts/skills/ask-on-page/SKILL.md` L23), so Dia's own pipeline does truncate.

## 3. Other open sources
| Product | Cap | Method | Cite |
|---|---|---|---|
| Chrome Gemini (glic) | innerText **20,000 bytes** default; PDF 64 MiB; APC optional | innerText / APC | `chrome/browser/resources/glic/glic_api/glic_api.ts` L1802, L1805; `chrome/browser/glic/host/glic.mojom` L384-389 |
| Chrome Compose | 12,000 chars trimmed innerText, 4,000-char header + window around caret; 1 MiB raw | innerText | `components/compose/core/browser/config.h` L49-53; `chrome/browser/compose/compose_session.cc` L1126-1131 |
| Firefox AI Window `get_page_content` | **10,000 chars**; YouTube transcript 65,536 | Reader mode (Readability) if `isProbablyReaderable`, else DOMExtractor | `browser/components/aiwindow/models/Tools.sys.mjs` L1090, L1097, L1423-1426; `toolkit/components/pageextractor/PageExtractorChild.sys.mjs` L467-500 |
| Firefox AI search tool | 15,000 chars | DOMExtractor, no boilerplate removal | `Tools.sys.mjs` L836, L1030-1032 |
| Firefox Smart Form Fill | 10,000 chars split across tabs | reader mode | `SmartFormFillParent.sys.mjs` L125, L805 |
| Firefox truncation rule | head, then back up to the last `.` within 100 chars, else hard cut + `…` | n/a | `PageExtractorParent.sys.mjs` L230-243 |
| Page Assist | 4,028 chars default (`useMessage.tsx` L95, `.slice(0,…)` L358-363); 7,028 in `services/kb.ts` L17 | Defuddle | `src/parser/default.ts` L1 |

## 4–5. Measurement (`/tmp/freedia-textcap/measure.ts`, bun + @mozilla/readability 0.6 + linkedom; tokens = **js-tiktoken o200k_base**, a real tokenizer)
"innerText" here means body `textContent` with script/style/noscript/template/svg removed and whitespace collapsed. linkedom has no layout, so hidden text is included. % kept = share of the Readability text that a head cap retains.

| Page | Readability chars | innerText chars | Readability tokens | chars/token | 8k | 16k | 32k |
|---|---|---|---|---|---|---|---|
| Guardian news article | 3,544 | 6,068 | 690 | 5.14 | 100% | 100% | 100% |
| Wikipedia "World War II" | 168,913 | 192,215 | 44,407 | 3.80 | 5% | 9% | 19% |
| MDN Array reference | 55,103 | 41,861* | 14,300 | 3.85 | 15% | 29% | 58% |
| GitHub README (mozilla/readability) | 6,572 | 10,302 | 1,354 | 4.85 | 100% | 100% | 100% |
| HN thread (368 comments) | 151,859 | 176,851 | 31,809 | 4.77 | 5% | 11% | 21% |
| Paul Graham "How to Do Great Work" | 66,518 | 66,518 | 13,570 | 4.90 | 12% | 24% | 48% |
| react.dev useEffect (SPA docs) | 35,084 | 40,032 | 7,786 | 4.51 | 23% | 46% | 91% |
| Substack (ACX book review) | 46,920 | 47,352 | 10,419 | 4.50 | 17% | 34% | 68% |
| apple.com MacBook Pro (product) | 3,389 | 65,655 | 793 | 4.27 | 100% | 100% | 100% |
| YouTube watch page | **NULL** | 151 | – | – | – | – | – |

\*On MDN the Readability text is longer than my approximation, which strips `<svg>`/`<template>` before counting; Readability keeps text from those elements. URLs and full JSON are in `/tmp/freedia-textcap/results.json` (fetched 2026-10-19).
- Only 3 of 9 parsed pages fit in 8k, and the same 3 fit in 16k. At 32k, 3 fit fully and react.dev keeps 91%. Median Readability length is 46,920 chars (~10.4k tokens).
- Measured chars/token: 3.80–5.14, median 4.5. "4 chars/token" is a conservative (over-counting) rule of thumb.
- **Failure modes:** YouTube returns NULL (server HTML is a JS shell, and the transcript has to be fetched separately, as Brave and Firefox both do). On the apple.com product page Readability kept 5% of the text (3.4k of 65.7k), dropping the specs/pricing grids. PG's essay fails `isProbablyReaderable`, yet `parse()` succeeds, so Firefox's gate would have sent it to the DOM extractor instead.

## Recommended default + rationale
- **Cap: 32,000 chars (≈7–8.5k tokens at the measured 3.8–4.5 chars/token), as a setting.** 8k is the most conservative cap in this survey: Page Assist's ~4k is smaller, Firefox AI Window and Chrome glic sit at 10k chars / 20 KB, and Brave goes to 64k–180k bytes on current models. pi drives large-context models, and with 8k only 3 of 9 real pages survive while long-form pages keep 5–23%. 32k fully covers typical articles and docs pages (react.dev 91%) at a cost of ~8k tokens. [INFERENCE] Going to Brave-like 64k+ is reasonable if pi's model context is ≥128k; make it configurable rather than hard-coded.
- **Truncation: head-first, as Brave, Firefox, glic and Page Assist all do.** Use Firefox's refinement: cut at the last sentence end within ~100 chars of the cap, append a visible `[truncated: kept N of M chars]` marker, and pass the original length so the agent can say the page was cut off (Dia's skill prompt does this). Chrome Compose's head + window-around-focus is the only alternative in source. It's worth mirroring only when a highlight exists: head + ~4k chars around the selection.
- **Fallback when Readability returns null, or keeps <~20% of innerText** (the apple.com case, 5%): use `document.body.innerText`, which Brave also falls back to, capped the same way. YouTube needs a transcript extractor (InnerTube or timedtext). Without one, send metadata only and say there's no transcript.
- **Highlight-in-full holds:** Brave sends `selected_text` untruncated as its own block, and Dia treats it as a separate attachment. Add a sanity ceiling (e.g. 32k, same as page) only to guard against a select-all, and count it against the total budget before the page text.
