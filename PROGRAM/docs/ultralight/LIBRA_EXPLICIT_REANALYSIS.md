# LIBRA explicit reanalysis and optional input rules

This isolated candidate removes LIBRA's source-edit tracker, task journal, tracking modes, review tickets, edit-history suppression, and settled-task readmission. HAYAKU and Flashback keep their existing separate source-edit SDK.

## User flow

1. Open “원문 재분석”. The selection area starts collapsed.
2. Choose an internal page: **정본**, **미크로**, or **렌즈**.
3. Inspect stored summaries and open “원문 보기” to read the current source. Choose turns or record ranges; select-all and clear-selection apply only to the current page.
4. Use “바로 재분석”. A single U+A turn also offers “확인 후 재분석”, with source selection, tag extraction/editing, input preview, and verified rule persistence before dispatch. Multiple turns and multi-turn lens ranges offer direct reanalysis only.

| Page | Selection / actual analysis unit | Publication |
| --- | --- | --- |
| 정본 | Source turns within complete five-turn batches. Selected batches are deduplicated. | Existing canonical pipeline, one base call per five-turn batch. Missing and failed slots are selectable. |
| 미크로 | One completed U+A turn, including turns before a five-turn canonical batch is complete. | Explicitly analyzes and replaces the selected Micro; this is separate from failure recovery and works on already verified Micro. |
| 렌즈 | Choose a lens, then its exact stored record ranges. Failed ranges and uncovered source ranges are also selectable. | Existing lens pipeline replaces the same record key. An empty response preserves its prior record. Uncovered ranges use up to five consecutive turns per call. |

The selected analysis ranges and estimated base calls appear above the run actions. Additional provider retries or derived work can increase usage. Micro and lens actions do not launch a canonical job or explicitly reanalyze each other's memories. Canonical analysis retains its existing follow-up behavior, including scheduled lenses.

Switching a page or lens discards its current selection and unsaved review; navigation is disabled during dispatch and rule persistence. A partial Micro/lens failure keeps completed publications and removes those units from the remaining UI selection. Refreshing the list resets selection.

Micro replacement leaves the current work/head readable during provider execution. It publishes only a validated successful result, and restores the prior work/head if publication fails. Scope, worldline, storage/restore boundaries, exact raw source and input rules remain guarded. Lens review also pins the selected instruction revision. Calls use the current native receipt and lens engines in plugin-only, mirror and server-only storage.

A successfully committed replacement becomes that selected range's canonical version. Prior canonical bodies remain in history. A failed replacement keeps the previous canonical version. State or embedding follow-up warnings are reported separately after a successful canonical commit. Unselected ranges are not automatically reanalyzed.

Editing the text or optional tag policy does not hide an intact, approved canonical whose exact source slots still match. Chat/scope/worldline changes, deleted or reordered turns, different message identities, incomplete ranges, corrupt stored bodies and in-flight meaningful source changes remain guarded. Legacy fallback identities preserve only the existing unchanged-slot policy; they do not become native identity proof.

## Optional analysis-input rules

“분석할 내용” presents the existing three semantics in one list:

- 내용 전체 제외: remove the matching delimiters and their content
- 태그만 제거: remove delimiters and keep content
- 이 안만 분석: select one complete, nonempty matching region

Tag names and standard XML examples infer closing tags. Custom delimiters remain explicit. One “적용” saves the current list, including an entered new row. Editing/deleting rows does not save until Apply. The local preview reads the last current-chat message only on request, makes no model call, and never stores or logs its sample. Invalid or ambiguous source selection preserves the original input and shows a warning.

Saved categories, legacy ignored-tag configuration, unknown fields, and the difference between absent rules and explicitly empty rules are preserved. The historical settings key remains for compatibility; tracking mode/epoch fields are inert and are not request-admission requirements. Settings changes do not rewrite prior canonical data. Unknown external tags/content remain unless a configured rule handles them. Mandatory Suite envelope sanitation remains.

Review rules are shared by LIBRA's three analysis kinds and apply to future analysis after saving. There is no per-turn-only exclusion mode. Reviewing compares normalized rule semantics while preserving additional stored metadata.

## Canonical provenance

Analysis consumes normalized receipt text and captures exact immutable raw references. A tag-only host edit or newer raw capture may coexist with that operation when the normalized source and exact message topology still match. The operation revalidates its originally consumed immutable capture; it never silently substitutes a newer active raw reference. Raw corruption, unavailable consumed bytes, changed message topology, and substantive analysis-input changes still prevent publication.

## Build ownership

`MemorySuiteSourceInput.libra.source.js` owns LIBRA's pure projection plus input-settings adapter/editor. Its projection prefix is checked against the unchanged shared source-edit SDK. `sync_source_edit_consent.cjs` synchronizes the detached LIBRA profile and retains the full shared tracker for HAYAKU/Flashback. `check_sdk_sync.cjs` and `sync_source_review.cjs` understand the separate LIBRA marker.

## Qualification

See the candidate's review handoff and immutable checkpoint for exact test counts, hashes, failures and limits. This document does not claim deployment, full-suite success, external-model qualification, live DATA testing or performance improvements. Socket-dependent mirror/server-only tests require a separately authorized integration lane; they are not bypassed in the strict offline lane.
