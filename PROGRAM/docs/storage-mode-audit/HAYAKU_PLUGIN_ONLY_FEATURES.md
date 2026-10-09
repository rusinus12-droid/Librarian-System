# HAYAKU — Plugin-Only Feature Inventory

> Task 9 of `Librarian-System-0.3.60-STORAGE-MODE-FEATURE-PARITY-PLAN.md`.
> Source: `PROGRAM/plugins/HAYAKU_Locator_Continuity.js` (v3.0.133). Storage authority:
> `MemorySuiteStorageBridge` (namespace `hayaku`); ledger key `hayaku.v2.ledger.<scopeKey>`.

## Groups (18 required)

| # | Feature ID | Entry points | Storage class | plugin_only | mirror | server_only |
|---|---|---|---|---|---|---|
> Status columns are published from `support_matrix.json` (measured); the feature list and entry points are the Task 11 inventory.

| 1 | `HAYAKU-INPUT-RECOGNITION` | `RequestKindCore.classify`, `resolveHayakuCurrentTurn` | transient_cache | verified_supported | unverified | unverified |
| 2 | `HAYAKU-PACKET-CAPTURE` | `captureHayakuOutput`, `persistCapturedPackets` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 3 | `HAYAKU-SPEAKER-TURN-BOUNDARY` | `recoveryBoundaryIndex`, `buildPacketRecoveryDebt` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 4 | `HAYAKU-CONTINUITY-PACKET-STORAGE` | `loadStorageLedger`, `writeStorageLedgerDirect`, `ingestPacket` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 5 | `HAYAKU-TURN-WORLDLINE` | `reconcileTurnWorldline`, `bindStorageLedgerToSnapshot` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 6 | `HAYAKU-MISSING-PACKET-DETECTION` | `detectPacketRecovery`, `exactHayakuTurnCoverage` | owner_derived | verified_supported | verified_supported | verified_supported |
| 7 | `HAYAKU-MANUAL-RECOVERY` | `runNativeMissingTurnBatch`, `runNativeTargetedRegeneration` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 8 | `HAYAKU-FAILED-ONLY-RECOVERY` | `saveFailedAnalysisArtifact`, `listFailedAnalysisArtifacts` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 9 | `HAYAKU-RECOVERY-VAULT-SHARDS` | `loadRecoveryVault`, `writeRecoveryVaultDirect` | owner_authoritative | verified_supported | unverified | unverified |
| 10 | `HAYAKU-RECOVERY-LEASE-APPROVAL` | `acquireRecoveryDebtLeaseForNativeRepair`, `resolveRecoveryJournalBackgroundConfirmation` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 11 | `HAYAKU-SOURCE-EDIT-SYNC-CONSENT` | `assertHayakuSourceEditConsent`, `filterHayakuSourceEditTransport` | owner_authoritative | verified_supported | unverified | unverified |
| 12 | `HAYAKU-PACKET-DELETE-MAINTENANCE` | `tombstoneStorageSlot`, `removeOrphanedStorageRecords` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 13 | `HAYAKU-ARCHIVE-HANDOFF-EXCLUSION` | `ensureHayakuSharedArchive`, `adoptBridgeSessionHandoff` | archive_reference | verified_supported | verified_supported | verified_supported |
| 14 | `HAYAKU-BACKUP-EXPORT-IMPORT-RESTORE` | `exportEnvelope`, `importEnvelope` | owner_authoritative | verified_supported | unverified | unverified |
| 15 | `HAYAKU-LARGE-HISTORY-PACKET-SIZE` | `pruneStorageRecords`, `buildNativeColdStartBatches` | owner_authoritative | verified_supported | unverified | unverified |
| 16 | `HAYAKU-JSON-XML-ARTIFACT-PROTECTION` | `isStructuredOutputOnlyPrompt`, `stripHayakuBlocks` | transient_cache | verified_supported | unverified | unverified |
| 17 | `HAYAKU-DIAGNOSTICS-AUDIT-LOGS` | `pushOperationLog`, `loadStorageReconciliationJournal` | diagnostic | verified_supported | verified_supported | verified_supported |
| 18 | `HAYAKU-GUI-DURABLE-MUTATIONS` | `bindLedgerViewerUi`, `viewerRunNativeRepair`, `cleanupLedgerViewerOrphans` | owner_authoritative | verified_supported | verified_supported | verified_supported |

## Coverage gaps requiring focused work

- `HAYAKU-PACKET-DELETE-MAINTENANCE`: `tombstoneStorageSlot`, `restoreStorageSlot`, and
  `removeOrphanedStorageRecords` have **zero direct test references**. A focused runtime test
  must be added before the mirror/server_only promotion.
- `HAYAKU-PACKET-CAPTURE`: `validateCapturedPacketGroup`/`captureHayakuOutput` have no direct
  test; existing coverage is via `output_listener_capture_contract_test.cjs`.

## Special parity gates (Task 14)

- Large Recovery Vault uses shard/index structure in server modes.
- Recovery failure never becomes "no active debt".
- Packet skeleton/empty packet handling is mode-independent.
