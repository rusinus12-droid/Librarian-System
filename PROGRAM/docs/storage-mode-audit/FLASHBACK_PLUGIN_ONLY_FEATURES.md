# Flashback — Plugin-Only Feature Inventory

> Task 10 of `Librarian-System-0.3.60-STORAGE-MODE-FEATURE-PARITY-PLAN.md`.
> Source: `PROGRAM/plugins/Flashback_Memory.js` (v1.0.97, `PLUGIN_STORAGE_ID='vector_rag_memory'`).
> Storage authority: `MemorySuiteStorageBridge` (namespace `flashback`); scope prefix
> `vector_rag_memory:scope:<keyHash>` and vector sidecars `vector_rag_memory:local-vector-shard:v1:...`.

## Groups (20 required)

| # | Feature ID | Entry points | Storage class | plugin_only | mirror | server_only |
|---|---|---|---|---|---|---|
> Status columns are published from `support_matrix.json` (measured); the feature list and entry points are the Task 11 inventory.

| 1 | `FLASHBACK-UA-CAPTURE` | `beforeRequest`, `afterRequest`, `capturePendingTurnForMessages` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 2 | `FLASHBACK-PENDING-CAPTURE-JOURNAL` | `persistPendingCaptureJournalEntry`, `recoverPendingCapturesFromJournal` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 3 | `FLASHBACK-RECORD-NORMALIZATION` | `buildRecordsFromSources`, `cleanRecordForMemory` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 4 | `FLASHBACK-EMBEDDING-GENERATION` | `embedTexts`, `embedTextsIsolated`, `hashEmbeddingBatch` | owner_derived | verified_supported | verified_supported | verified_supported |
| 5 | `FLASHBACK-VECTOR-SIDECARS` | `persistFlashbackVectorShard`, `hydrateFlashbackVectorRecords` | owner_derived | verified_supported | verified_supported | verified_supported |
| 6 | `FLASHBACK-HYBRID-RECALL` | `prepareFlashbackRecall`, `recallRecords`, `reciprocalRankFusion` | owner_derived | verified_supported | verified_supported | verified_supported |
| 7 | `FLASHBACK-RECALL-GATES` | `applyRecallHardGates`, `applyCurrentStateValidityAging` | owner_derived | verified_supported | verified_supported | verified_supported |
| 8 | `FLASHBACK-EPISODE-INDEX` | `buildEpisodeIndexRecords`, `maybeRebuildEpisodeIndex` | owner_derived | verified_supported | verified_supported | verified_supported |
| 9 | `FLASHBACK-FILM-ARCHIVE-BROWSER` | `buildStorageTab`, `listScopeStorageStats` | owner_derived | verified_supported | verified_supported | verified_supported |
| 10 | `FLASHBACK-SCOPE-CLASSIFICATION` | `classifyScopeForManagement`, `scopeHasEmptyPayloadOnly` | owner_derived | verified_supported | verified_supported | verified_supported |
| 11 | `FLASHBACK-SCOPE-DELETE-CLEANUP` | `deleteSelectedScopeStorages`, `deleteScopeStorage` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 12 | `FLASHBACK-TURN-WORLDLINE` | `synchronizeFlashbackTurnWorldline`, `retireExternalRecordsForScope` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 13 | `FLASHBACK-NATIVE-BRANCH-CLONE` | `cloneScopeStorage`, `ensureScopeStorageReady` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 14 | `FLASHBACK-SESSION-HANDOFF` | `adoptSessionHandoff`, `ensureFlashbackArchiveForHandoff` | archive_reference | verified_supported | verified_supported | verified_supported |
| 15 | `FLASHBACK-PORTABLE-BACKUP` | `doExport`, `doRestoreFile`, `restorePortableByMode` | owner_authoritative | verified_supported | unverified | unverified |
| 16 | `FLASHBACK-COLDSTART-MAINTENANCE` | `ingestLiveChatColdStart`, `runMemoryMaintenance` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 17 | `FLASHBACK-EMBEDDING-MIGRATION` | `applyVerifiedEmbeddingMigration`, `progressivelyReembedRecords` | owner_derived | verified_supported | verified_supported | verified_supported |
| 18 | `FLASHBACK-SERVER-COMPUTE` | `MemorySuiteStorageBridge`, `createMemorySuiteSearchClient` | owner_authoritative | verified_supported | unverified | unverified |
| 19 | `FLASHBACK-DIAGNOSTICS-LOG` | `pushActivityLog`, `exportDebugLogPayload` | diagnostic | verified_supported | verified_supported | verified_supported |
| 20 | `FLASHBACK-GUI-MUTATIONS` | `buildUiHtml`, `bindManualEditorEvents`, `bindStorageDeleteEvents` | owner_authoritative | verified_supported | verified_supported | verified_supported |

## Coverage gaps requiring focused work

- `FLASHBACK-EPISODE-INDEX`: `rebuildEpisodeIndex`, `maybeRebuildEpisodeIndex`,
  `buildEpisodeIndexRecords`, `detectEpisodeBoundaries` have no direct test hits. Add a focused
  rebuild test.

## Special parity gates (Task 15)

- No `source_empty` in a valid mirror/server-only native branch.
- Vector sidecar/readback parity.
- Orphan classification must not depend on incomplete local-only chat metadata.
- Retained retired local data is never recalled in server_only (R02).
