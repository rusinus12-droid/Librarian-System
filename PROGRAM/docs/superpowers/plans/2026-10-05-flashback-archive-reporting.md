# Archive/local repair reporting boundary

Status: reporting-only candidate. No archive worker, adoption, merge, live RisuAI/provider validation or full portable-restore closure is claimed.

## API count contracts

`reembedAllRecords` continues executing the existing durable local queue only. Its primary `reason` is exactly the local outcome, including `profile_changed`, `scope_changed` and other authority refusals. `localReason` repeats that outcome; `archiveReason` reports a separate boundary.

- `pending` and `localPendingSources` count local source groups. `pendingUnit` is `source_groups`. Never add archived record counts to either value.
- `archivePending` is the legacy full-route compatibility alias for excluded archive records. `archivePendingMeaning` is `excluded_archive_records`. It is not a pending-job count. Complete archive inspection is now required for a numeric value; refused, failed, incomplete, foreign or changed inventory returns null.
- `archiveRecordsNeedingEmbedding` is a measured record count from complete, current read-only inspection, including aggregate episodes. Compatible archives report 0. Unknown inventory reports null.
- `archiveCoverage.execution` is always `unsupported`. Its `inspection` is `complete` or `unknown`; the corresponding `excludedRecords` and `recordsNeedingEmbedding` are independent record counts or null. It confers no write/repair capability.
- `archiveReembedded` stays 0 and `archiveRefUpdated` stays false. Local durable completion and request receipts survive any later archive-inspection failure. `partialSuccess` retains local partial outcomes and qualifies completed local work when archived mismatches remain or coverage is unknown.

`progressivelyReembedRecords` remains a local queue API. No archive execution or sum is added.

The existing internal `reembedArchiveRecords` inspector used by automatic maintenance retains its distinct legacy `pending` / `archivePending` values as measured mismatched record counts, explicitly marked `pendingUnit: records`, `archivePendingMeaning: mismatched_archive_records`, and `execution: unsupported`. It does not create pending jobs or submit requests. This intentionally does not reinterpret that helper's legacy alias as the full/physical route's excluded-record alias.

`inspectMemoryMaintenance` now exposes `archiveInspectionComplete`; archive row/mismatch counts are null when archive inventory is incomplete or outside server-snapshot coverage. Existing strict failures still refuse instead of exposing untrusted values. GUI diagnostics retain that unknown state rather than formatting null as zero. Existing local known counts and independent integrity evidence remain separate.

## Physical action and GUI

The advanced selection is labelled `로컬 미완료 벡터 복구`. Entry help, denied preview, confirmation and result describe the same already-durable current-profile local-pending boundary. Failed, uncertain, blocked/migration-required groups and linked archives remain excluded. The legacy physical `counts.archivePending` is the linked reference's excluded-record count, not measured mismatches or pending jobs; the warning and result make this explicit. No extra archive inventory is required to execute an otherwise authorized local action. `finalVerification.healthy` remains null.

If no eligible local group exists and a verified local manifest links an archive, preview returns `archive_repair_unsupported` after the existing owner/authority/credential checks. A complete inspection with zero local vector, source-change, cleanup, index, adoption or integrity work establishes the archive-only boundary even when already-ready local rows are present. Unknown or nonzero local-work fields cannot satisfy that shortcut. Archive-only automatic/advanced maintenance refuses with `FLASHBACK_ARCHIVE_REPAIR_UNSUPPORTED` after current approval, authority and integrity checks and before an unnecessary provider connection probe. Existing unresolved physical operations remain blocked; no shortcut unlocks them.

## Preserved boundary

No durable reservation, outcome, currentness, owner or immutable-archive fence is weakened. No dormant archive helper is activated. No persistent schema or new saved data is introduced. No dependency install, live provider request, credential handling, fallback/autostart restoration or adoption is part of this change. The original 643-row portable test is unmodified and remains an open archive-worker acceptance gate. Exact frozen input/output pins, commands, new public-path tests and broad regression failures live in the candidate handoff.
