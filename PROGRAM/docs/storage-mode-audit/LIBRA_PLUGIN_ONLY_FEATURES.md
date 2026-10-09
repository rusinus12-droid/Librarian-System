> 2026-10-02 retirement status: LIBRA uses Classic memory recall. GRADIA/SGA, Planner and InputWriter executors, model settings and delivery controls are retired. Existing raw memory, historical receipts, drafts and physical storage keys are preserved. Helper descriptions below are historical evidence, not active operational instructions.

# LIBRA — Plugin-Only Feature Inventory

> Task 8 of `Librarian-System-0.3.60-STORAGE-MODE-FEATURE-PARITY-PLAN.md`.
> Source: `PROGRAM/plugins/LIBRA.js` (v2.3.130). Storage authority: `MemorySuiteStorageBridge`
> (`libra:v1:` plugin prefix; scope key `libra:v1:scope:<scopeKey>:<suffix>`).
> Mode status in `feature_inventory.json` is only `verified_supported` when a test directly
> executes the entry point and reads back durable owner state.

## Groups (20 required)

| # | Feature ID | Entry points | Storage class | plugin_only | mirror | server_only |
|---|---|---|---|---|---|---|
> Status columns are published from `support_matrix.json` (measured); the feature list and entry points are the Task 11 inventory.

| 1 | `LIBRA-CANONICAL-CAPTURE` | `captureCommittedOutputEvent`, `scan`, `completeBatchStarts` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 2 | `LIBRA-ARIADNE-ITO-PIPELINE` | `executeUnifiedStage`, `runUnifiedStateAfterCommit` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 3 | `LIBRA-CANONICAL-REVISION-ADOPT` | `saveCanonicalEditDraft`, `resolveCanonicalCandidate`, `commitCanonicalAdoptionTransaction` | owner_authoritative | verified_supported | unverified | unverified |
| 4 | `LIBRA-WORLD-MANAGER-STATE` | `loadContinuityState`, `unifiedStateReadProjection` | owner_derived | verified_supported | verified_supported | verified_supported |
| 5 | `LIBRA-STATE-CORRECTION-JOURNAL` | `appendStateCorrection`, `rollbackStateWorldline` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 6 | `LIBRA-DUAL-WORLDLINE` | `hostWorldlineMetaForNativeBranch`, `loadStateWorldlineMeta` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 7 | `LIBRA-RECALL-ENGINE` | `recall`, `shortlistRecallCatalog`, `classicCanonicalProvenanceRescueFromHead` | owner_derived | verified_supported | unverified | unverified |
| 8 | `LIBRA-EMBEDDING-VECTOR-LIFECYCLE` | `embedMemory`, `startEmbeddingRebuild`, `cleanupQuarantinedVectors` | owner_authoritative | verified_supported | unverified | unverified |
| 9 | `LIBRA-PLANNER-RESPONSE-CONTEXT` | `runTurnPlanner`, `attachUnifiedResponseContext` | transient_cache | verified_supported | unverified | unverified |
| 10 | `LIBRA-GRADIA-SGA` | `runSgaPipeline`, `runSgaPrivateAnalysis` | transient_cache | verified_supported | verified_supported | verified_supported |
| 11 | `LIBRA-INPUT-WRITER` | `runExplicitLibraInputWriter`, `dispatchLibraInputWriterDelivery` | transient_cache | verified_supported | verified_supported | verified_supported |
| 12 | `LIBRA-RAG-LORE-CBS` | `buildUnifiedResponseLoreMaterial`, `rerankMemoryLoreForStage` | transient_cache | verified_supported | verified_supported | verified_supported |
| 13 | `LIBRA-CONFIG-PERSISTENCE` | `readRuntimeSettings`, `saveLibraProviderConfig` | local_configuration | verified_supported | intentionally_unsupported | intentionally_unsupported |
| 14 | `LIBRA-MANUAL-RECOVERY` | `startManualColdStart`, `startFailedRetry` | owner_authoritative | verified_supported | unverified | unverified |
| 15 | `LIBRA-SOURCE-EDIT-CONSENT` | `createMemorySuiteSourceEditConsent`, `assertLibraStateSourceEditPermission` | owner_authoritative | verified_supported | unverified | unverified |
| 16 | `LIBRA-WORLD-ADDITIONAL-RETIRED` | `purgeLegacyWorldAdditionalData` | diagnostic | verified_supported | verified_supported | verified_supported |
| 17 | `LIBRA-STORY-NARRATIVE-COMPAT` | `getStoryArc`, `storyArcCompatibilityProjection` | archive_reference | verified_supported | verified_supported | verified_supported |
| 18 | `LIBRA-PORTABLE-HANDOFF` | `createEnvelope`, `restoreEnvelope`, `adoptSessionHandoff` | archive_reference | verified_supported | unverified | unverified |
| 19 | `LIBRA-MAINTENANCE-DIAGNOSTICS` | `getServerScopeHealth`, `previewUnifiedRetention` | diagnostic | verified_supported | verified_supported | verified_supported |
| 20 | `LIBRA-GUI-OWNER-WRITES` | `saveLibraProviderConfig`, `addWorldManagerCorrection` | local_configuration | verified_supported | verified_supported | verified_supported |

## Intentionally-local, excluded from canonical parity

- `LIBRA-CONFIG-PERSISTENCE` — provider/prompt/runtime settings (`libra:v1:memory-settings`,
  `provider-presets`, `runtime-settings`, `prompt-overrides`). Not canonical owner data.
- Credentials (`libra:v1:provider-secrets`, `backend-hosting-token`) are excluded from the
  storage bridge and portable backup entirely.

## Special parity gates (Task 13)

- Canonical 5-turn cadence identical in all modes.
- State Worldline and Host Worldline remain separate.
- Current State Head/replay does not use stale local state in server_only.
- Recall reads only the active revision/worldline.
- Vector space/model migration never deletes canonical memory.
- Manual cold start never becomes automatic because a server is connected.
