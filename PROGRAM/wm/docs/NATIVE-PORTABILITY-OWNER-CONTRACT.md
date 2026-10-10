# Native portability owner integration, v1

Status: adapter implementation, FEATURE-FIRST. No production owner implementation is included. Actual native support, actual-host qualification, all-writer ownership and activation are **not complete**. These are distinct gates. Supplying a plain capability flag, pluginStorage get/set, an in-memory lock or this document does not satisfy them.

## Product boundary

`WmNativePortability.createWmNativePortability({storage, owner, inventory, clock?})` supplies persistent chunk staging, complete six-domain byte/hash/dependency verification, independent materialization orchestration, exact installed inventory readback, native-consumer scope reopen, route-decision reconciliation, and native component capture/import/restore. The adapter does not implement the host's storage layout, all-writer exclusion, CAS, source fence, authenticated server decision lookup or lifecycle replacement.

The runtime's trusted environment may supply `nativePortabilityFacilities: {storage, owner, inventory}` alongside `nativeHostProvider` and `nativeHostQualification`. The runtime constructs the adapter inside its own module realm. A same-module branded `nativePortabilityAdapter` can be supplied instead. `nativeHostProvider.nativePortabilityOwner` must refer to the exact `owner` object, or the provider itself must be that owner. This binding is checked at the gate. It is not qualification evidence: the existing trusted qualification resolver must cover the actual provider and its bound facilities.

The gate exposes `nativePortabilitySupport()`, the existing `migration(method,input)` and `reconcileMigration(input)`, and `nativeBackup(method,input)`. A missing qualified provider continues to fail closed. The adapter's own destination inspection always reports `activationEnabled:false`. Only the existing qualified gate may admit the injected adapter to the migration coordinator. No profiles were added to the empty production list.

## Durable storage contract

The staging store is a separately bound durable workspace. It must not be an unfiltered alias of the source plugin/local memory store or native catalog. Its exact storage description is:

- `describePortabilityStorage()` returns `{schema:'wm.native-portability-store.v1', namespace, isolatedFromMemoryInventory:true}`
- `getItem(key,{strict:true})` returns the exact durable string, or null for an absent key
- `setItem(key,string,{strict:true})` durably replaces that one string before resolving

The declared isolation must actually be implemented by the host binding; the adapter cannot inspect the host's physical storage mapping. No B1 classifier was weakened or broad namespace exclusion added. Installed memory remains in the native owner's catalog/inventory, while operational staging and backup records stay outside its memory export.

Keys use the adapter's private `wm.native-portability.v1:` prefix with SHA-256 identities. Every write is read back. Chunks are immutable offset-bound base64 records; the stage metadata references them only after durable chunk readback. A retry of the same chunk must match its exact bytes. A metadata-write interruption can leave an unreferenced chunk, which is retained and safely reused by the same operation. No automatic deletion/GC exists.

Get/set/readback is not atomic ownership. All mutation occurs within the owner's `runExclusive` operation and requires verified ownership. The owner must provide the durable cross-executor transaction/exclusion semantics; a JavaScript promise queue is insufficient.

## Required native owner, schema `wm.native-owner.v1`

`describePortability()` returns exactly `{schema, identity, limits}`. Identity is `{authorityId, storeId, datasetId, backendId}`. Limits are positive safe integers `{maxChunkBytes, maxPageItems, maxPageBytes, maxItems, maxTotalBytes, maxItemBytes}`. These are capability capacities, never silent truncation or a permanent 4 MiB data limit. The adapter intersects chunk/page counts with the existing 256 KiB / 128-item transport defaults.

All methods below must exist before any adapter staging write:

1. `runExclusive({operationId,requestFingerprint,purpose}, callback)` obtains durable operation ownership, invokes and awaits the callback exactly once with a private handle, and retains/excludes conflicting target writers across failure/restart until its own authoritative outcome permits release. The same operation/fingerprint is retryable; a conflicting fingerprint is not. The owner must also coordinate different operations competing for the same destination.
2. `verifyOwnership({handle,input?})` returns true only while that handle still owns the exact operation. When input is supplied its ID/fingerprint must match. Handles never enter a wire DTO, backup, stage record or diagnostic.
3. `inspectDestination({handle,input,restorePlan})` reports `{ok,backendId,datasetId,targetHasExistingData,availableBytes}`. Read-only inspection may have null handle/input. An existing destination blocks migration; only a separately confirmed restore plan can replace an existing native generation.
4. `beginInstallation({handle,input,restorePlan})` atomically reserves a fresh independent native installation for the exact stage input, fences its consumers, and reconciles same-ID retries. Existing unrelated data cannot be overwritten or merged. For restore it uses the already fenced fresh lifecycle and retains the previous store.
5. `writeItemChunk({handle,input,descriptor,offset,bytes})` idempotently writes an independent target byte record, returning `{ok:true}` only after durable write. It must not point the target at source-owned chunks. It preserves every descriptor, original payload byte, provenance and inert import disposition. Partial targets must remain inaccessible to ordinary hydrate, bootstrap, inheritance and writers.
6. `sealInstallation({handle,input,items,restorePlan})` completes the native catalog/scope/binding installation and returns exactly `{ok:true,installationId,route,writerEpoch}`. Migration route equals the target route with state `fenced`; restore route has `recovery_required`. Native canonical envelopes, raw/cold readers and all catalog entries must actually resolve those installed records. This method must reconcile retries after a partial write or lost acknowledgment.
7. `readInstallation({handle,stage,installation,active})` reads the authoritative native installation and returns exactly `{ok:true,installationId,items,route,writerEpoch}`. Items are the complete ordered inventory, including unreferenced originals and known-empty scopes. No omissions or extra target data are accepted. Inactive reads bind the sealed installation; active reads bind the published global route.
8. `readItemChunk({handle,stage,installation,active,descriptor,offset,maxBytes})` returns `{ok:true,bytes,offset,totalBytes,sha256}` from installed target storage, not from the staging/source service. Zero-byte canonical records must be supported. Product code independently rehashes every installed payload and checks the complete dependency graph.
9. `reopenScope({handle,stage,installation,active,scope})` opens the scope through the host's actual native memory-consumer path and returns `{ok:true,installationId,scope,canonicalPresent,raw}`. A scope lacking a canonical item returns `canonicalPresent:false,raw:null`. A canonical tombstone returns `canonicalPresent:true,raw:null`. Every discovered scope is reopened; descriptor-only success is insufficient. Private inactive-generation reads remain owner-authorized and do not activate the scope.
10. `readRoute()` reads the one authoritative global WM route.
11. `verifyMigrationDecision({handle,input})` verifies the committed status using the authoritative native operation journal or authenticated server operation-status facility. It must bind operation/fingerprint, original source, exact target, inventory and durable decision. JSON `committed:true` is not authentication.
12. `reconcileRoute({handle,input})` performs/reconciles the existing owner-controlled durable route CAS. It accepts only the verified decision, preserves the old source inactive, and returns `{ok:true}` only when the global route is target. It does not perform a new migration or invent a new operation ID.

`beginInstallation`/`sealInstallation` and the native mapping/reopen methods above have **no production RisuAI binding in this repository**. The existing read-only `hostCatalog.listScopes/readWmScope` cannot implement them. This is an implementation gap, not merely an unexecuted qualification test.

## B5 migration use

The existing B5 coordinator continues to own source fence acquisition, the exact source snapshot, source-current checks before and after materialization, the durable cutover decision, and post-route active readback. The adapter implements the existing native destination methods:

`inspectMigrationDestination`, `migrationLimits`, `beginMigrationStage`, `stageMigrationChunk`, `migrationStageStatus`, `verifyMigrationStage`, `materializeMigrationStage`, `verifyMigrationReadback`.

Stage inputs retain the existing `{operationId,requestFingerprint,sourceRoute,targetRoute,snapshot}` contract. The adapter hashes the intent before admission, verifies exact descriptor count/order, all six domain totals, every payload hash and bytes, missing/cyclic dependencies, installed target inventory, and native-consumer canonical reopen. It never rewrites source identities or signs old originals under a new identity.

`reconcileMigration` authenticates the external durable decision, validates the receipt fingerprint, reads the complete native stage when the destination is plugin-only, then asks the bound owner for CAS and reads the route back. Reverse materialization does not reactivate an older local copy. Forward reconciliation is supported through the owner's authenticated server-decision verifier; this slice's basic checks cover the native destination only.

The adapter is not a replacement for B4 qualification or the ordinary native writer implementation. Actual native runtime reads/writes must consume the installed owner layout and obey the same fence. C1 scope handoff is a different contract and is not implemented by this adapter.

## Native backup component and import

`nativeBackup('capture',{backupId,sourceRoute})` uses the injected source inventory under owner exclusion. Source route must be plugin-only. It copies all bounded pages/chunks into an independent backup stage, verifies source currentness and the copied closure, then seals `wm.native-backup-component.v1`:

`{schema,backupId,sourceIdentity,sourceRoute,snapshot,items,componentDigest}`.

Only memory inventory and original safe evidence are copied. Live operation journals, owner handles, credentials, pending execution authority and restore approval are not exported. The supplied B1 inventory still controls canonical/raw/schema admission; unsupported legacy payloads remain unsupported.

`verify({backupId})` verifies the complete stored component and bytes. `readChunk({backupId,logicalId,offset,maxBytes})` provides bounded backup bytes. A host archive integration may transport the exact component plus these bytes without reserializing payloads.

For an independent staging workspace: call `beginImport({component})`, ordered `importChunk({backupId,logicalId,offset,bytes})`, optionally `importStatus({backupId,logicalId?})`, then `sealImport({backupId})`. Import preserves source physical identity and every original descriptor. A different physical target may verify/import a component, but its restore remains explicitly unsupported. Import only stages bytes and does not install native memory or acquire execution authority.

No existing SQLite `wm.backup-component.v1`, LIB v1/v2 archive schema, server backup dispatcher, legacy five-owner SDK or RETRACE backup UI was relabeled or relaxed. Host archive/UI integration for this separate native component is still absent. Backup readChunk currently re-verifies the full component on each call; large-data performance qualification is deferred.

## Same-physical restore

Restore additionally requires all of:

- `inspectRestore({handle})` returns `{ok:true,identity,fingerprint,route,writerEpoch,incarnation}` for the current native store
- `verifyRestoreConfirmation({handle,plan,confirmation})` authenticates the existing manager's exact action-time confirmation. It must not accept a caller's boolean or self-declared approval
- `fenceRestore({handle,plan,targetRoute})` durably returns the same `{ok:true,route,writerEpoch,incarnation}` on retry, advances both epoch and incarnation, fences every old writer, retains the old store, and keeps route recovery-required
- `readRetainedRestoreSource({handle,plan,lifecycle})` independently reads the retained previous store and returns `{ok:true,fingerprint}` matching the pre-restore fingerprint
- `finishRestore({handle,plan,installation,lifecycle,readback})` records verified installation under recovery admission and returns `{ok:true}`; it must not reactivate historical approvals, leases, operation IDs or jobs

`prepareRestore({operationId,backupId,expiresAt})` produces the existing `RestorePlan` shape with physical identity, current fingerprint, component digest binding, inventory digest, byte requirement and explicit caller-selected expiration. The internal plan also retains the previous lifecycle and immutable component identity. No default approval/expiration policy is invented.

`applyRestore({operationId,planId,confirmation})` verifies the confirmation, current target, complete backup, same physical identity, fresh durable lifecycle, complete installed bytes, every native scope, and the retained old store. Only then it records a durable terminal receipt. Same-ID completed retries read that receipt without writing another generation. Uncertain intermediate state is retained; a retry must reuse the same owner operation and its durable lifecycle. No automatic rollback/delete occurs.

The returned receipt remains `admission:'recovery_required'`, `historicalExecutionAuthority:false`. There is no activation/recovery-unfence method in this adapter. Source authority/store/dataset/backend identity must match. Cross-physical restore/rebase is explicitly unsupported.

## Verification limits and remaining implementation

The basic fixture uses real temporary files for staging, copied byte records and a separately reopened synthetic native-lore layout. It does not use RisuAI DATA, implement old-client/cross-process fences, or qualify a production owner. Tests cover adapter recreation, seven inventory items across six domains including an empty scope, complete copied readback, same-ID route reconciliation, backup capture/export/import into a second workspace, and fresh-lifecycle recovery restore.

Still absent: actual owner facilities/native schema binding, production authenticated route-decision bridge, normal runtime consumer integration into that layout, native C1/RETRACE continuation, WM+LIA pre-activation persona preparation, native archive/UI dispatch, cross-physical identity rebase, full restart/crash/ACK-loss/disk-full/concurrent-owner matrices, performance/bounded-global-memory proof and actual-host qualification. The prior deterministic feature and E06/cold-paging gaps are unchanged.
