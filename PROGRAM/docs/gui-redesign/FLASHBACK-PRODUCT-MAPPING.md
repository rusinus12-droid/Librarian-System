# Flashback mockup-to-product mapping

Scope: implement the exact six-route structure and visual system in `flashback.html` using the real Flashback GUI state, storage APIs, and handlers. The static mockup examples and `assets/suite.js` behavior are not product behavior and are excluded.

| Existing capability group | Mockup destination | Product data/action/readback binding | Preservation notes |
|---|---|---|---|
| Recall overview and current-frame evidence | `lab` | `Runtime.lastRecall`, `currentScopeStats`, `renderLastRecallPanel`; current recall query, selected records, provenance, score, delivery stage and actual returned-fragment count | Display only evidence available from the same current scope. Unknown delivery is never labeled as injected. |
| Stored memory/source records and manual response editor | `vault` → `resp` | `refreshStoragePanel`, `renderManualEditorPanelHtml`, `#storageRows`, `#manualEditorPanel`, `data-open-manual-editor` | Permanent session-history/source records remain protected from deletion. |
| Worldline/branch continuity | `vault` → `wl` | `refreshFlashbackWorldlinePanel`, `#fbWorldlineContent`, `#fbWorldlineRefresh` | Read-only lineage and excluded-turn inspection. |
| Scope inventory, classification, selection, cleanup, deletion | `vault` → `scopes` | `refreshStoragePanel`, `#storageRows`, `#storageManagementView`, `#storageScopeFilter`, existing scope batch/confirmation handlers | Current scope, inherited ancestors, unknown ownership and referenced scopes retain existing protection. Selection and eligibility are recalculated at execution. |
| Diagnostic, maintenance plan, consented recovery, outcomes | `care` | `maintenanceInspectBtn`, `maintenanceAutoBtn`, `maintenanceMode`, maintenance execution ledger/status/details/cancel IDs | Diagnosis is read-only; cost/consent, operation eligibility, partial/error/unknown outcomes and readback remain product-owned. |
| Source edit synchronization and reanalysis | `care` → source-edit section | `buildFlashbackSourceEditCard`, `getFlashbackSourceInput`, `refreshFlashbackSourceEditPanel`, existing source IDs/actions | Current source comparison and explicitly selected ranges remain bound to product source identities. No summary-model call is introduced. |
| Portable JSON backup and restore | `care` → backup/restore section and restore confirmation flow | `[data-portable-backup-host="flashback_memory"]`, `__FlashbackPortableMemoryBackup`, file inspection and existing restore API | Restore is only enabled for inspected eligible modes and the inspected target; removal counts and confirmation are recalculated before execution; rollback/readback semantics remain. |
| Embedding provider, credentials, vector profile, pending work, tests | `connect` → `emb` | `buildProviderTab`, existing provider/settings fields, `testEmbedBtn`, `clearEmbeddingKeyBtn`, embedding-work renderer | Credential values stay masked and real provider tests remain explicit user actions. No API key is used during UI verification. |
| Verified same-space vector/profile migration and multilingual probe | `connect` → `mig` | `previewVerifiedEmbeddingMigration`, `applyVerifiedEmbeddingMigration`, multilingual probe status/run/cancel controls | Migration is preview-first and API-call-free when the existing proof permits it; multilingual validation remains an explicit potentially billable operation. Not run during this task. |
| Storage/compute server connection panel | `connect` → `srv` | `MemorySuiteStorageBridge.mountConnectionPanel` and `MemorySuiteComputeBridge` | Server-mode transitions remain in the shared SDK’s validated flow; no direct mode toggle is introduced. |
| Session activity, swallowed diagnostic errors and warnings | `log` | `Runtime.activityLog`, `renderLastActionLogs`, `renderSwallowedDiagHtml`, existing clear/reset actions | Session-only data remains session-only; no sample log rows are shown. |

## Unavoidable visual detail flows

The six mockup routes provide explicit inner flows for the vault (`resp`, `wl`, `scopes`), connection (`emb`, `mig`, `srv`), and log subtabs. Care already reserves cards for source reanalysis and backup/restore. Existing source-edit, restore, migration, and server actions therefore fit these named destinations; this mapping does not require a seventh route or an old-GUI accordion.


## Verification scope

See [GUI-APPLICATION.md](GUI-APPLICATION.md) for current source hashes, regression summaries and host limits. Raw execution logs, mock/model transcripts and screenshots are kept out of this publication. Existing SDK-owned panels retain their ownership boundary.
