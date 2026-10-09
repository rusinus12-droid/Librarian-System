# LIA — Plugin-Only Feature Inventory

> Task 11 of `Librarian-System-0.3.60-STORAGE-MODE-FEATURE-PARITY-PLAN.md`.
> Source: `PROGRAM/plugins/LIA_Persona_Linker.js` (v0.26.80, namespace `lia`). Storage authority:
> `MemorySuiteStorageBridge`; split store index `liaPersonaLinkerLivePersonaIndexV2` and shard
> prefix `liaPersonaLinkerLivePersonaScopeV2::<hash>`.

## Groups (12 required)

| # | Feature ID | Entry points | Storage class | plugin_only | mirror | server_only |
|---|---|---|---|---|---|---|
> Status columns are published from `support_matrix.json` (measured); the feature list and entry points are the Task 11 inventory.

| 1 | `LIA-PERSONA-CREATE` | `runLLMRewrite`, `upsertGeneratedPersona` | owner_authoritative | verified_supported | unverified | unverified |
| 2 | `LIA-PERSONA-BIND` | `PersonaBindingManager.bindLive`, `PersonaSelectionManager.setDynamic` | owner_authoritative | verified_supported | unverified | unverified |
| 3 | `LIA-LIVE-REFRESH` | `checkLivePersonaSync`, `applyLivePersonaPrompt` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 4 | `LIA-LIVE-CHECKPOINT` | `validateLivePersonaLedger`, `livePersonaBatchRevisionSnapshot` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 5 | `LIA-SAME-CHAT-RECOVERY` | `readLivePersonaBindingByScopeKey`, `resumeLivePersonaBindingChange` | owner_authoritative | verified_supported | unverified | unverified |
| 6 | `LIA-BRANCH-INHERIT` | `ensureInheritedLivePersonaForCurrentChat`, `projectNativeBranchPersonaState` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 7 | `LIA-BRANCH-STORAGE-MIGRATE` | `prepareMemorySuiteNativeBranchTargetStorage` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 8 | `LIA-SESSION-HANDOFF` | `adoptLivePersonaHandoff`, `registerLiaHandoffIpc` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 9 | `LIA-SOURCE-REVALIDATE` | `verifyLivePersonaBatchStillCurrent`, `revalidateNativePersonaFork` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| 10 | `LIA-PERSONA-RESTORE` | `restoreOriginalLivePersona`, `exportPersonaVisualAssetBundleZip` | owner_authoritative | verified_supported | unverified | unverified |
| 11 | `LIA-UI-PERSONA-OPS` | `renderPersonaSidePanel`, `saveEditedResultToCurrentPersona` | owner_authoritative | verified_supported | unverified | unverified |
| 12 | `LIA-DIAG-INSPECT` | `buildDebugExportSnapshot`, `getPersonaProofSnapshot` | diagnostic | verified_supported | unverified | unverified |

## Special parity gates (Task 16)

- Persona content and binding identity verified separately.
- No `no_inherited_live_owner` for a valid server-only native branch.
- User explicit child mode remains unchanged.
- Same-chat Persona change does not invent a Host Branch.
- Reload restores correct binding and latest validated Persona.
