# LIBRA 2.3.59 — saved memory to State projections

## Observed failure

The supplied 2.3.58 diagnostic reports one T1–T5 memory committed, 13 accepted entities, 36 accepted facts, 15 rejected facts, and only two retained State bindings. The State result is `state_bindings_pending`, with a null Head. Character, world and narrative readers consequently have no rows.

Record admission already isolated bad memory records, but incomplete-prefix State replay still discarded an entire candidate whenever any pending field existed. State also relied on redundant model bindings for destinations already fixed by validated claim kinds.

## Changes

- Derive missing State bindings locally from accepted, confirmed current-sequence typed facts. Preserve canonical artifacts, hashes, admission receipts and raw provider diagnostics unchanged. Explicit malformed optional bindings cannot remap a fact to a different field.
- Retain valid State fields from partial replay candidates. Actual missing canonical ranges still stop prefix replay; source, scope, worldline, digest and storage readback checks remain required.
- Resolve identities referenced by confirmed current facts, including events. Ambiguous identity allocation remains pending. Identity-only cards do not assert locations or conditions.
- Keep quarantined updates, conflicting fields and dependent updates pending. Never promote an older value when its later update was quarantined.
- Add an evidence-backed event chronology to narrative State. Keep at most 60 recent events in the Head and display the last 20 in the almanac. Complete history remains in canonical memory. Events do not create unresolved threads or override narrative summaries.
- Preserve chronology through normal snapshot normalization. Pending State journals from earlier versions use the same local replay after reload; no AI request or canonical regeneration is needed.

## Validation boundaries

New full-plugin KV tests cover omitted/malformed bindings, sparse bindings plus rejected records, chronology, reported-fact exclusion and previous pending-journal recovery with identical canonical bytes and zero new provider calls. A local HTTP/SQLite test covers partial commit and restart. A production GUI-builder test covers event-only, mixed event/thread and empty displays using DOM substitutes. Existing gap, changed-source, rollback, dependency, correction and replay tests remain relevant. These checks do not establish live RisuAI GUI or external-model behavior.

The workspace source also contained 20 corrupt joined-line deletions before this patch. Only those spans were restored from the previously syntax-checked 2.3.58 delivery; three independent quick-settings style changes were retained. Restoration evidence is in `review_artifacts/libra_state_cards_20260908/source_repair.json` outside the installable package.
