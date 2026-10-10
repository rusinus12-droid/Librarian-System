# WM SQLite cross-physical backup import v1

Current v2 backup extension: [Paged backup contract](PAGED-BACKUP-CONTRACT.md) adds compact streaming components, same-physical restore and fresh-target rebasing. The v1-only backup limitations below describe the prior checkpoint; production qualification remains open.

Current extension: [Import/recovery/restart-selection controls](CROSS-STORE-IMPORT-CONTROLS.md) supplies the explicit manager/UI path and bounded same-ID recovery. The UI/adoption/interrupted-stage gaps below describe the original 18:00 UTC API checkpoint. Actual writer activation, native mapping, active-authority cutover and replacement of an already-selected target remain unsupported.

Status: IMPLEMENTED_PROVISIONAL_FEATURE_FIRST. This is an explicit fresh-target product API with basic synthetic evidence. It is not a live server replacement, native owner implementation, activation, or production-qualified restore.

## Entry point and authority

`server/wm/backup.cjs` exports `createWmBackupImport({targetPath, importEnabled:false})`; its implementation is `server/wm/cross_store_import.cjs`. The trusted offline coordinator selects an absolute destination SQLite path and enables the provider only within its separately qualified/authorized context. The default is closed. Request JSON cannot qualify the provider.

The destination must be a never-created file without SQLite sidecars or a restore journal. No existing data is merged, replaced, adopted, or removed. A source backup from any admitted WM physical identity may be imported. The original live source remains unchanged and is not fenced: the imported target is deliberately `recovery_required`, so this is not a route cutover between two active writers.

`capabilities()` identifies `wm.cross-store-import.v1`, `target:'fresh_sqlite_file'`, `liveServerReplacement:false`, `nativeOwner:false` and recovery admission. Existing service `backupCapabilities().crossPhysicalRestore:false` and existing `stageWmRestoreFile` same-physical checks remain correct for the old replacement route. The separate new import API does not relax those contracts.

## Prepare and confirmation

`prepare({operationId, component, backupRoot, targetDatasetId, targetBackendId})` accepts only the existing exact `wm.backup-component.v1` DTO. Unknown/newer component, SQLite, manifest and item versions reject. Source verification includes file digest, exact SQLite schema/triggers, FK/integrity, every blob in bounded 256-KiB reads, generation/Prepared/intent hashes and expected-Head graph, all six inventory domains/dependencies, staged evidence and independently materialized handoff chunks. Missing or corrupt closure rejects before reserving or publishing the target.

The returned durable `wm.import-plan.v1` binds the operation, complete source component/digest, source directory, target path, expected absence, target dataset/backend and explicit `IMPORT <planId>` confirmation. The provider creates fresh authorityId, storeId, writerEpoch, routeGeneration and incarnation once and stores them with the plan. These are target authority, never copied source proofs or leases. The immutable 11-key Head shape is unchanged.

The initial plan uses an exclusive target-side reservation. Same operation and exact input returns the same plan, even after completion. Any different operation or changed intent for the reserved target rejects. `apply({planId,confirmation,requestFingerprint})` requires all three exact values. `status({planId,operationId,requestFingerprint})` queries the same durable identity. A timeout is never permission to choose a new ID or target.

## Rebase and publication

1. Reverify and copy the source component to a new unpublished target-side stage using no-clobber copying and exact byte/hash verification.
2. Rebase every generation, current/expected Head, revision, Prepared and generation operation ID into the new target authority; regenerate all manifest/intent/Prepared hashes. Retain the entire historical generation graph, not only current Heads. Raw/canonical payload bytes, item descriptors, origin scopes and raw provenance remain unchanged.
3. Rewrite target-only binding metadata and its snapshot cut. Record source-to-target generation IDs/digests and source identity as `wm.import-rebase-evidence.v1`, explicitly historical and non-executable. Original component is retained unchanged. Old source operation rows remain readable historical evidence; old and generated import operation IDs are permanently denied execution. Live pins, approvals, target execution jobs and source fence authority are not imported.
4. Reinstall the exact immutable triggers within the stage transaction. Verify the entire rebased SQLite closure and map against the source component, target identity and planned admission. Verify the source component still has its original digest.
5. Persist the staged digest, then publish exactly one file with an atomic no-clobber hard link. Consume only the internally generated staging link. No source/backup file is deleted. Full readback and the durable receipt follow publication.

`wm.import-receipt.v1` reports source/target identity, target file digest, inventory digest, per-domain completeness, generation count, incarnation, source preservation and `activation:false`, `historicalAuthority:false`, `admission:'recovery_required'`, `wholeTransferAtomic:false`. A committed receipt is the historical result of that operation; it is not a current-health, current-file-immutability or activation proof.

The returned `targetIdentity` is required to reopen the new store. An existing server configured for another creation identity will correctly refuse it. This version intentionally does not edit server identity configuration, redirect a running server, alter existing mixed-owner restore, or update RETRACE UI to adopt the new physical store.

## Durability and retry limits

Phases are prepared → staging → staged → publishing → committed. All transitions retain the same operation/plan/target authority. An exclusive apply lock prevents cooperative concurrent execution.

- Prepared can begin; a completely verified staged file can continue using its recorded hash.
- Publishing with a fully matching installed target can reconcile a lost acknowledgement into the same committed receipt. A mismatch/missing target remains uncertain; no fallback overwrite or new identity is generated.
- Interrupted staging, a leftover apply lock, partially installed/mismatching state, or uncertain storage failure requires explicit offline recovery. This API does not guess completeness, steal locks or discard evidence. It does not yet implement automatic chunk-stage resume or an operator recovery UI.
- A committed retry returns the durable historical receipt; confirmation/fingerprint/identity mismatches still reject.

The SQLite rebase transaction is atomic only inside the unpublished target stage. Copying, filesystem publication and journal writes are separate steps. This is not an atomic whole-transfer or multi-owner transaction. Filesystem hard-link/fsync support is required; unsupported systems fail closed without a copy-overwrite fallback. Exhaustion or interruption can leave derived stages/sidecars for recovery, while source and existing targets remain preserved.

The closure verifier reads payload blobs in bounded chunks. Component metadata, generation JSON and the rebase mapping are currently held in memory; a total constant-memory or arbitrarily large migration guarantee is not claimed.

## Qualification and unchanged boundaries

Real RisuAI/native owner installation/reopen, all-writer fence/CAS, native backup archive/UI, native cross-physical import, ordinary imported native consumers, actual server identity adoption, recovery activation, Windows/filesystem durability, process-crash/concurrency/storage-full matrices, deep regression and independent review remain open. No production profile or credential is created. Actual host/server/handoff activation remains false.

C2 WM + LIA inactive target/persona preparation, core3 mixed modes, LIA local_only, RETRACE manager_only, GRADIA read-only/nonparticipant, exact zero-copy and materialized receipts, and user settings are unchanged. Generated Full/Min/plugin manifests remain stale; checkpoint-local source assembly is separate evidence.
