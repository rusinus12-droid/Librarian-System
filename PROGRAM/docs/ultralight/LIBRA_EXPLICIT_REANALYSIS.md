# LIBRA explicit reanalysis and optional input rules

This isolated candidate removes LIBRA's source-edit tracker, task journal, tracking modes, review tickets, edit-history suppression, and settled-task readmission. HAYAKU and Flashback keep their existing separate source-edit SDK.

## User flow

1. Edit the current chat.
2. Open the range selector and choose “선택 구간 재분석”. Any complete five-U+A range can be selected.
3. Click “선택한 구간 재분석” once. The current source at that action is analyzed through the existing canonical pipeline.

A successfully committed replacement becomes that selected range's canonical version. Prior canonical bodies remain in history. A failed replacement keeps the previous canonical version. State or embedding follow-up warnings are reported separately after a successful canonical commit. Unselected ranges are not automatically reanalyzed.

Editing the text or optional tag policy does not hide an intact, approved canonical whose exact source slots still match. Chat/scope/worldline changes, deleted or reordered turns, different message identities, incomplete ranges, corrupt stored bodies and in-flight meaningful source changes remain guarded. Legacy fallback identities preserve only the existing unchanged-slot policy; they do not become native identity proof.

## Optional analysis-input rules

“분석할 내용” presents the existing three semantics in one list:

- 내용 전체 제외: remove the matching delimiters and their content
- 태그만 제거: remove delimiters and keep content
- 이 안만 분석: select one complete, nonempty matching region

Tag names and standard XML examples infer closing tags. Custom delimiters remain explicit. One “적용” saves the current list, including an entered new row. Editing/deleting rows does not save until Apply. The local preview reads the last current-chat message only on request, makes no model call, and never stores or logs its sample. Invalid or ambiguous source selection preserves the original input and shows a warning.

Saved categories, legacy ignored-tag configuration, unknown fields, and the difference between absent rules and explicitly empty rules are preserved. The historical settings key remains for compatibility; tracking mode/epoch fields are inert and are not request-admission requirements. Settings changes do not rewrite prior canonical data. Unknown external tags/content remain unless a configured rule handles them. Mandatory Suite envelope sanitation remains.

## Canonical provenance

Analysis consumes normalized receipt text and captures exact immutable raw references. A tag-only host edit or newer raw capture may coexist with that operation when the normalized source and exact message topology still match. The operation revalidates its originally consumed immutable capture; it never silently substitutes a newer active raw reference. Raw corruption, unavailable consumed bytes, changed message topology, and substantive analysis-input changes still prevent publication.

## Build ownership

`MemorySuiteSourceInput.libra.source.js` owns LIBRA's pure projection plus input-settings adapter/editor. Its projection prefix is checked against the unchanged shared source-edit SDK. `sync_source_edit_consent.cjs` synchronizes the detached LIBRA profile and retains the full shared tracker for HAYAKU/Flashback. `check_sdk_sync.cjs` and `sync_source_review.cjs` understand the separate LIBRA marker.

## Qualification

See the candidate's review handoff and immutable checkpoint for exact test counts, hashes, failures and limits. This document does not claim deployment, full-suite success, external-model qualification, live DATA testing or performance improvements. Socket-dependent mirror/server-only tests require a separately authorized integration lane; they are not bypassed in the strict offline lane.
