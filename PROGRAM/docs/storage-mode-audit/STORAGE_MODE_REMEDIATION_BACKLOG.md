> 2026-10-02 retirement status: LIBRA uses Classic memory recall. GRADIA/SGA, Planner and InputWriter executors, model settings and delivery controls are retired. Existing raw memory, historical receipts, drafts and physical storage keys are preserved. Helper descriptions below are historical evidence, not active operational instructions.

# Storage-Mode Remediation Backlog

> Task 18 of `Librarian-System-0.3.60-STORAGE-MODE-FEATURE-PARITY-PLAN.md`.
> Only concrete gaps discovered by the parity audit appear here. Shared storage
> authority was proven green for all four owners (see
> `storage_mode_owner_parity_audit_test.cjs`, `storage_mode_special_parity_gates_test.cjs`),
> so no P0 defect was found. Remaining items are per-feature mode-status promotions
> that require a focused execution+readback test.

## P0 — source/parent mutation, data loss, sibling contamination, false success

**None found.** The following gates are green for all four owners in all three modes:

- Child view cannot overwrite a parent/sibling/global key (`MEMORY_SUITE_NATIVE_BRANCH_KEY_OWNERSHIP_DENIED`).
- Sibling scope substitution is denied (`MEMORY_SUITE_NATIVE_BRANCH_SCOPE_ACCESS_DENIED`).
- Parent and sibling branch data remain unchanged.
- Retained retired local bytes are never re-adopted in server_only (R02).

## P1 — RESOLVED: Flashback legacy-child migration CAS race

**Defect (found by the 0.3.61 follow-up audit, not by the 0.3.60 audit).**
`reconcileNativeBranchStoragePolicy` (the R01 migration writer for an
already-adopted 0.3.57 child) performed its manifest load-modify-save *outside*
`withScopeWriteLock`, while the retirement / maintenance writer
(`retireExternalRecordsForScope`) commits the same
`vector_rag_memory:scope:<hash>:manifest:v2` revision *inside* the lock. Both
writers therefore read revision N and the loser's conditional batch failed with
HTTP 409 `conditional_batch_state_changed` — an intermittent failure on a
one-time data transition.

This was a real defect **inside an already-`verified_supported` feature**
(`FLASHBACK-NATIVE-BRANCH-CLONE`), which is precisely the class of gap the
0.3.61 follow-up is meant to close: the 0.3.60 evidence proved the common
storage authority, not this feature's concurrent execution.

- Fix: `PROGRAM/plugins/Flashback_Memory.js` — the whole reconcile decision and
  commit now run inside `withScopeWriteLock(scope.scopeKey, ...)`, and merge onto
  the manifest that is current at commit time instead of the caller's older
  snapshot. No retry loop: the CAS failure is eliminated, not masked.
- Test: `native_branch_flashback_legacy_child_migration_concurrency_test.cjs`
  (50 forced-concurrency iterations).
- Evidence: `PROGRAM/docs/storage-mode-audit/evidence/FLASHBACK_LEGACY_CHILD_CAS_RACE_EVIDENCE.json`
  (RED on the pre-fix revision: `writers are serialized...` assertion fails;
  GREEN on the shipped revision).
- Acceptance: 50/50 PASS, HTTP 409 = 0, duplicate copies = 0, parent mutation = 0.

**Residual risk (same file, not yet fixed — tracked, not claimed green).** Nine
further call sites remain outside a scope write lock (re-derive with
`PROGRAM/tools/audit_flashback_manifest_locks.cjs` — Task 21 corrected this path; the earlier
`PROGRAM/_lock_audit.cjs` reference was wrong and no such file exists; line numbers drift on every
plugin edit):

| Line | Kind | Enclosing function | Path |
|---|---|---|---|
| `:19287` | `saveScopeManifest` | `saveScopeRecordsCore` | record save |
| `:22409` | `saveScopeManifest` | `adoptSessionHandoff` | session handoff |
| `:22479` | `saveScopeManifest` | `adoptSessionHandoff` | session handoff |
| `:22518` | `saveScopeManifest` | `adoptSessionHandoff` | session handoff |
| `:25962` | `saveScopeRecords` | `commitFlashbackSourceReplacement` | source replacement |
| `:25967` | `saveScopeManifest` | `commitFlashbackSourceReplacement` | source replacement |
| `:25973` | `saveScopeRecords` | `commitFlashbackSourceReplacement` | source replacement |
| `:46121` | `saveScopeRecords` | `installFlashbackPortableMemoryBackup` | portable restore |
| `:46124` | `saveScopeManifest` | `installFlashbackPortableMemoryBackup` | portable restore |

These are handoff / portable restore / source-replacement paths that were not
exercised by the R01 race and must be triaged before their features can claim
mirror/server_only parity. See Task 48 of
`Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md`.

**RESOLVED (Task 48, 2026-09-17) — and the count above was wrong.** The list is a *static* result:
"outside a `withScopeWriteLock` block body" is not the same as "racing". Triaging each site by whether
its **caller** holds the lock on the same key found **4 genuinely racing sites, not 9**:

- `:22409`, `:22479`, `:22518` (`adoptSessionHandoff`) — **racing, now fixed.** The function body had no
  lock and neither callers (`ensureScopeStorageReady:20433`, `registerMemoryBridgeIpc:36201`) held one.
  All three target-scope manifest writes now run inside `withScopeWriteLock(targetScope.scopeKey)`.
  New forced-concurrency test `tests/flashback_session_handoff_concurrency_test.cjs` fails on the
  pre-fix revision and passes 12/12 after the fix.
- `:19287` (`saveScopeRecordsCore`) — **not racing.** All 26 `saveScopeRecords` references were
  enumerated: 23 hold the lock directly, the 2 in `commitFlashbackSourceReplacement` are covered by
  `upsertRecords:23478`, and the portable-import writer targets a fresh per-import archive scope.
- `:25962`, `:25967`, `:25973` (`commitFlashbackSourceReplacement`) — **not racing** (caller lock).
- `:46121`, `:46124` (`installFlashbackPortableMemoryBackup`) — **not racing** (fresh scope per import).

Scanner after the fix: **9 → 6 unprotected**, all 6 being the sites proved safe above. Verified caller
chain per site: `docs/storage-mode-audit/TASK48_UNLOCKED_SITE_TRIAGE.md`. Flashback `1.0.96 → 1.0.97`.

**Coverage gap closed:** `bridgeHandoffValid` had no reference in any test file before Task 48, so the
session-handoff adoption path was never executed by the regression — which is why an unlocked writer
there survived. The new test is net-new coverage, not a regression guard.

## LIBRA review fixes applied (2026-09-17, LIBRA 2.3.126 → 2.3.128)

The project-wide review's top LIBRA findings were fixed after independent verification. **Two of the
four reported "Critical/High" findings were corrected by verification before any code changed** — the
review's evidence was right, its prescriptions partly wrong.

### Fixed

**#1 — Lock-free read-modify-write on the GLOBAL scope registry.** `resolveStableScopeKey`
(`:34579`) and `markNativeCopySuppressed` (`:36102`) both read-modify-wrote the single global document
`libra:v1:scope-registry:v1`. Two concurrent scope resolutions read the same document, each added its
own entry, and the second write dropped the first; the orphaned chat then minted a **new** scope key on
its next pass, splitting its canonical memories across two scopes.
**Fix:** a shared promise tail (`scopeRegistryMutationTail`) serializes both writers and each re-reads
inside its turn, so unrelated entries survive.
**Review correction:** the review recommended reusing `writeScopeRegistryLocal`'s pattern. That helper
writes `SCOPE_ROUTING_LOCAL_KEY` (`__memory_suite_internal_scope_routes_v1__:libra`) — a **different
store with a different schema** (`parseScopeRegistry`/`mergeScopeRegistries` handle routing entries,
not the `scopeId → scopeKey` map). It is not reusable here. Also, `serializeMutation` (the helper this
fix first used) lives inside a **different IIFE scope** (closed at `:4021`) and is not reachable from
`resolveStableScopeKey` — the first attempt threw `serializeMutation is not defined` at runtime and was
caught by the existing test suite, then corrected.

**#3 — Unlocked State Head writes.** `rebuildStateFromCanonicalChain` recomputed the Continuous State
Head and wrote it through `persistStateReplayHead` → `storage.setJson(key.continuityState)` with no
lock. Two rebuilds computed from independent `loadContinuityState` reads meant the later write won
whole and the first rebuild's applied deltas/corrections were silently lost.
**Fix:** split into `rebuildStateFromCanonicalChainUnlocked` (body) + `rebuildStateFromCanonicalChain`
(per-scope `enqueue` wrapper) — exactly the existing
`rebuildCurrentStateForWorldline`/`…Unlocked` pair in this file.
**Deadlock handling:** `enqueue` is non-reentrant, and one caller (`resolveCanonicalCandidate`, `:56702`)
**already holds the lock**, so it was switched to the `Unlocked` body. The other four callers
(`38049`, `41011`, `45598`, `58827`) are outside every lock block and keep the wrapper. Verified: no
wrapper caller sits inside a lock.

### Reported but NOT defects (verification refuted them)

**#2 — "failed commit returns success".** `retryUnifiedServerEmbedding`'s outer catch returns the input
`memory`, which the review read as reporting success. In fact the callers inspect the result:
`flushUnifiedDerivedVectors` builds `{ok: completed===refs.length, attempted, completed, results}` from
`memory.embedding.status` (still `retry_pending` on failure) and carries the error in each row's
`diagnostic`. The failure is surfaced, not swallowed. **No change.**

**#3 sibling `:58793`.** The review called this second State Head write unlocked. Its callers were
enumerated: **all five are inside `enqueue`** (`35706`, `58829`, `58876`, `58909`, `59003`). Lower risk
than reported; the real exposure was `:40648`, which is fixed above.

### Test coverage added / updated

- **`tests/libra_scope_registry_race_test.cjs` (new).** Evaluates the plugin's scope-registry slice and
  runs two concurrent resolutions for different chats with a **read barrier**, so both readers really
  start from the same document.
  - **RED/GREEN demonstrated:** pre-fix → `totalEntries: 1` (chat A entry lost) → **FAIL**; post-fix →
    `totalEntries: 2` → **PASS** (stable 3/3). Non-vacuity guard asserts both readers really read the
    registry.
  - Includes the second site: a suppression write must not drop an unrelated chat entry.
- **Six source-slice contract tests updated** to keep their boundaries on the rebuild *body* after the
  `…Unlocked` split: `libra_legacy_continuity_migration_gate_test`,
  `libra_canonical_variant_job_gui_contract_test`, `libra_manual_archive_transfer_runtime_test`,
  `libra_post_commit_state_orchestrator_contract_test`, `libra_state_rebuild_transfer_contract_test`,
  `libra_world_manager_narrative_v1_contract_test`. These are text-slice probes whose markers pointed
  at `const rebuildStateFromCanonicalChain = async`; the split moved that marker onto the wrapper, so
  the markers now point at `…Unlocked` and the slices again contain the code under assertion. **The
  guarded behaviour was never broken** — only the slice boundaries moved — and the assertions
  themselves were left unchanged.

## LIBRA: the unlocked-saveManifest classification (follow-up to Task 48, 2026-09-17)

Task 48's method was applied to **LIBRA**, where the defect class is worse than Flashback's: LIBRA's
`saveManifest` (`LIBRA.js:35229`) is a **whole-document overwrite** —

```js
manifest.updatedAt = nowIso();
await storage.setJson(key.manifest(scope), manifest);   // no merge, no CAS
```

Flashback's `saveScopeManifestCore` at least compares a `MANIFEST_STORAGE_READ` basis and throws
`FLASHBACK_COMMIT_CONFLICT`. LIBRA has no such guard: `setJson` → `fencedMemoryStorageSet` bumps a
fence *revision* but lets every writer proceed, so the last writer wins **wholesale** and silently
reverts independent fields (`inFlight`, `stats`, `failedBatches`, `branchGuard`, `worldlineMeta`,
`portableImports`, `inheritedMemories`) committed by another writer in between. The user-visible
symptom is bookkeeping drift, not lost memories: batches stuck in `inFlight`, wrong failure records,
embedding stats mismatch, lost portable-import receipts.

**Inventory:** 29 `saveManifest` call sites; **26 are outside a lock block**; they belong to 16 writer
functions. Classifying each by whether its *caller chain* holds `enqueue(scopeKey)` (the Task 48 rule —
lexical nesting is not protection) gives:

| Verdict | Writers | Notes |
|---|---|---|
| **RACING (fixed)** | `processBatch` (7 sites) | reached via `regenerateCanonicalMemory` with no lock; all 7 commit sites live inside `processBatch` |
| CALLER-LOCKED | `migrateTerminalInFlightFailure`, `retryEmbeddingForMemory` | every caller holds `enqueue` |
| PASSED-IN baseline | `discardStaleBatchBuild`, `discardPreviousBatchWork`, `processBatch`'s caller-supplied manifest, `retryUnifiedEmbedding` | no local `loadManifest`; the caller owns the read |
| Lower risk (unchanged) | `cloneNativeChatCopyStorage`, `ensureNativeChatCopyAdopted` | `state.nativeCopyInFlight` is a promise-merge guard: concurrent calls for one scope **join the same promise**, so the 3 unlocked writes are serialized in practice |
| Lower risk (unchanged) | `reconcileCanonicalBranchBeforeRecall` | 3 of its 4 callers are locked; the 4th is a recall path |
| Lower risk (unchanged) | `adoptSessionHandoff`, `deleteCanonicalVariant`, `deleteFailedRun`, portable import writers | guarded by `assertPortableMemoryIdle` / canonical-job state, or write a per-import fresh scope |
| Not racing | `runManagedScan` | takes no lock itself but calls `scan`, which does |

**Fix (LIBRA `2.3.126 → 2.3.127`):** wrap `regenerateCanonicalMemory` in
`enqueue(context.scope.scopeKey, …)`. One wrap protects all seven `processBatch` commit sites plus the
`56494` call path, because that function is the only unlocked route into `processBatch` — the other
route already ran inside `scan`'s lock block (`45967-46224` covering the call at `46143`). Wrapping each
of the 26 sites individually was rejected: the same writer owns several lines (deadlock risk from
non-reentrant `enqueue`) and the diff would be far larger for no extra coverage.

**Deadlock verification (required — `enqueue` is non-reentrant):**
- all three callers of `regenerateCanonicalMemory` (`56434`, `56781`, `74783`) are outside every lock
  block, with **zero overlapping lock blocks**;
- the callee closure (depth 4) contains exactly **one** `enqueue` — `flushUnifiedDerivedVectors`
  (`45876`) — and it is only reached through `setTimeout(0)` + `void`, i.e. never awaited while this
  lock is held.
`processBatch`'s two call sites are now **both** locked (`46143` via `scan`, `56516` via the new lock).

**Test:** `tests/libra_canonical_regeneration_manifest_race_test.cjs`. It records the manifest read
windows of the regeneration and of a competing same-scope operation (`scanMemoryNow`) and asserts **zero
overlap** — i.e. the per-scope lock really serializes them.
- **RED/GREEN demonstrated:** pre-fix source → `overlappingReadWindows: 1` → FAIL; shipped plugin →
  `0` → PASS (stable 3/3 runs).
- **Non-vacuity guards:** asserts the regeneration really opened a manifest read, the competing
  operation really opened one too, and the competing operation **completed** (so it cannot pass by
  deadlocking or by doing nothing).
- **Why not a lost-update probe:** every `processBatch` commit save is gated behind
  `if (!candidateOnly && …)`, and the regeneration passes `candidateOnly: true`. A probe driven by the
  usual synthetic provider *failure* writes the manifest **zero times** (measured directly), so a
  lost-update assertion would pass against the unfixed plugin. That measurement is why this test asserts
  lock serialization instead.

## Project-wide defect review

A full read-only review of all five plugins, the storage server, the embedded SDKs and the release
tooling was consolidated (with every top-severity claim independently re-verified) in
`docs/storage-mode-audit/PROJECT_DEFECT_REVIEW_20260917.md`. Highest-value open items there:
LIBRA's lock-free global scope-registry RMW (`LIBRA.js:34579-34611`), LIBRA's swallowed failed commit
(`LIBRA.js:45831-45837`), LIBRA's unlocked State Head write reachable from 8 unlocked callers
(`LIBRA.js:40623-40648`), Flashback's portable-rollback ordering (`Flashback_Memory.js:46237-46244`),
and the un-gated SDK forks (8 `tools/sync_*.cjs` referenced by no test or gate).

## P1 — feature unavailable in mirror/server_only despite expected support

These features are `owner_authoritative` / `owner_derived` / `archive_reference` and are
currently `unverified` for mirror/server_only. Each needs one focused test that executes the
feature in mirror and server_only with identical logical input and reads back the durable
result.

| Feature ID | Mode | Reproduction | Entry point | Storage schema |
|---|---|---|---|---|
| `LIBRA-CANONICAL-CAPTURE` | mirror, server_only | `libra_canonical_job_runtime_test.cjs` | `captureCommittedOutputEvent` | `libra.manifest.v1` |
| `LIBRA-ARIADNE-ITO-PIPELINE` | mirror, server_only | `libra_unified_fact_pipeline_v1_test.cjs` + **`libra_ariadne_ito_pipeline_3mode_parity_test.cjs`** | `runLibraMemoryPipeline` / `librarian` stage | `libra.canonical_artifact.v4` |
| `LIBRA-CANONICAL-REVISION-ADOPT` | mirror, server_only | `libra_canonical_variant_job_gui_contract_test.cjs` + **`libra_response_variant_missing_canonical_catchup_test.cjs`** | `resolveCanonicalCandidate` / `reconcileCanonicalBranchBeforeRecall` | `libra.canonical_variant_index.v1` |
| `LIBRA-WORLD-MANAGER-STATE` | mirror, server_only | `libra_latest_state_tracking_contract_test.cjs` | `loadContinuityState` | `libra.continuity_state.v2` |
| `LIBRA-STATE-CORRECTION-JOURNAL` | mirror, server_only | `libra_world_manager_correction_transaction_rc2_test.cjs` | `appendStateCorrection` | `libra.state_correction_store.v1` |
| `LIBRA-DUAL-WORLDLINE` | mirror, server_only | `native_branch_libra_worldline_meta_test.cjs` | `hostWorldlineMetaForNativeBranch` | `libra.worldline_meta.v1` |
| `LIBRA-RECALL-ENGINE` | mirror, server_only | `libra_classic_provenance_rescue_runtime_test.cjs` | `recall` | `libra.recall_catalog.v3` |
| `LIBRA-EMBEDDING-VECTOR-LIFECYCLE` | mirror, server_only | `libra_unified_server_vector_v1_test.cjs` | `embedMemory` | `libra.embedding_projection.v2` |
| `LIBRA-MANUAL-RECOVERY` | mirror, server_only | `libra_failed_batch_fresh_retry_runtime_test.cjs` | `startManualColdStart` | `libra.canonical_job.v1` |
| `LIBRA-SOURCE-EDIT-CONSENT` | mirror, server_only | `source_edit_libra_runtime_test.cjs` | `assertLibraStateSourceEditPermission` | `memory-suite.source-edit-consent.v1` |
| `LIBRA-PORTABLE-HANDOFF` | mirror, server_only | `libra_portable_cross_chat_restore_runtime_test.cjs` | `restoreEnvelope` | `libra.shared_archive.v1` |
| `HAYAKU-PACKET-CAPTURE` | mirror, server_only | `output_listener_capture_contract_test.cjs` | `captureHayakuOutput` | `hayaku_storage_ledger_v2` |
| `HAYAKU-CONTINUITY-PACKET-STORAGE` | mirror, server_only | `hayaku_common_admission_runtime_test.cjs` | `writeStorageLedgerDirect` | `hayaku_storage_ledger_v2` |
| `HAYAKU-TURN-WORLDLINE` | mirror, server_only | `native_branch_hayaku_runtime_test.cjs` | `reconcileTurnWorldline` | `hayaku_turn_worldline_v2` |
| `HAYAKU-MANUAL-RECOVERY` | mirror, server_only | `hayaku_native_targeted_regeneration_runtime_test.cjs` | `runNativeMissingTurnBatch` | `hayaku.native_repair_run.v1` |
| `HAYAKU-FAILED-ONLY-RECOVERY` | mirror, server_only | `hayaku_failed_analysis_vault_runtime_test.cjs` | `saveFailedAnalysisArtifact` | `hayaku.failed_analysis_index.v1` |
| `HAYAKU-SOURCE-EDIT-SYNC-CONSENT` | mirror, server_only | `source_edit_hayaku_runtime_test.cjs` | `assertHayakuSourceEditConsent` | `memory-suite.source-edit-consent.v1` |
| `FLASHBACK-UA-CAPTURE` | mirror, server_only | `flashback_capture_profile_regression_test.cjs` | `afterRequest` | `vector_rag_memory.scope_manifest.v2` |
| `FLASHBACK-HYBRID-RECALL` | mirror, server_only | `flashback_context_recall_runtime_test.cjs` | `recallRecords` | `vector_rag_memory.record.v2` |
| `FLASHBACK-PORTABLE-BACKUP` | mirror, server_only | `flashback_portable_cross_chat_restore_test.cjs` | `doRestoreFile` | `memory-suite.portable-memory-backup.v1` |
| `FLASHBACK-COLDSTART-MAINTENANCE` | mirror, server_only | `flashback_single_turn_maintenance_runtime_test.cjs` | `runMemoryMaintenance` | `flashback_memory.maintenance_journal.v1` |
| `LIA-LIVE-REFRESH` | mirror, server_only | `lia_output_listener_revision_contract_test.cjs` | `checkLivePersonaSync` | `lia.live_sync_batch_revision.v1` |
| `LIA-SESSION-HANDOFF` | mirror, server_only | `retrace_server_handoff_test.cjs` | `adoptLivePersonaHandoff` | `lia.live_persona_handoff.receipt.v1` |
| `LIA-PERSONA-RESTORE` | mirror, server_only | `lia_shared_server_restore_runtime_test.cjs` | `restoreOriginalLivePersona` | `lia.persona_visual_asset_bundle.v1` |

(A complete machine-readable list is in `support_matrix.json` → `rows[].gaps`.)

**Stale-entry rule learned here:** the P1 table's `entryPoint` column can name a route that has since
been retired. `LIBRA-ARIADNE-ITO-PIPELINE` was listed with `executeUnifiedStage`, which is now
**not reachable from the public API** and whose four stage ids all reject with
`LEGACY_ANALYZER_RETIRED`. Before writing a parity test from this table, execute the named entry
point once and confirm it exists; if it does not, the table row (and the plan task that produced it)
must be corrected, not worked around.

## P2 — reload/recovery/maintenance mismatch

### P2 (found by Task 26, FIXED 2026-09-17): duplicate correction-journal write in `plugin_only`

`setStateCorrectionStatus` wrote the State correction journal **twice** per status change in
`plugin_only`, and once in `mirror`/`server_only`:

```text
BEFORE the fix
plugin_only  : suspend -> revisions 2 then 3    activate -> revisions 4 then 5
mirror       : suspend -> revision 2            activate -> revision 3
server_only  : suspend -> revision 2            activate -> revision 3

AFTER the fix
all three    : suspend -> revision 2 (one write)  activate -> revision 3 (one write)
```

Cause: `mirror`/`server_only` took the `serverAtomic` path, where the replay persists the journal;
`plugin_only` first wrote it through `saveStateCorrectionJournal` and then the follow-up replay wrote it
again, because the non-atomic replay call did **not** receive the already-saved journal.

**Fix (in `plugins/LIBRA.js`):** `rebuildCurrentStateForWorldlineUnlocked` now accepts and forwards
`storeOverride` into `rebuildUnifiedStateForWorldline`, and both `appendStateCorrection` and
`setStateCorrectionStatus` pass the already-saved journal on the non-atomic path exactly as the atomic
path already did. No retry loop, no behaviour change for callers that do not supply a store.

- Verified by: `tests/libra_world_manager_state_3mode_parity_test.cjs`, which measures writes on each
  mode's real authority and now asserts **exactly one** write per status change in all three modes plus
  `journalRevisionFinal === 3` everywhere.
- Related state suites re-run green: `libra_state_correction_meta_transaction_rc2_test`,
  `libra_world_manager_correction_transaction_rc2_test`,
  `libra_world_manager_worldline_transaction_rc2_test`, `libra_state_correction_sparse_v2_runtime_test`,
  `libra_latest_state_tracking_contract_test`, `native_branch_libra_worldline_meta_test`.
- `libra_unified_server_writer_v1_test.cjs` remains at its **pre-existing** failure (line 64,
  "Missing expected rejection" for `UNIFIED_BACKEND_NOT_SUPPORTED`) — identical before and after the fix,
  and already registered as a baseline exception.

### P1 (found by Task 26): branch/worldline operations are bounded to `plugin_only`

`rollbackWorldManagerState` and `setWorldManagerWorldline` succeed in `plugin_only` and fail closed with
`UNIFIED_BACKEND_NOT_SUPPORTED` in `mirror`/`server_only` (same boundary the writer test already asserts
for rollback/handoff). They fail closed rather than silently downgrading to local-only state, which is
correct behaviour, but it means:

- `LIBRA-DUAL-WORLDLINE` cannot claim `mirror`/`server_only` parity — its entry point does not execute there.
- Task 26 Step 2 (branch-specific correction isolation) cannot be verified in all three modes, because
  `setStateWorldline` → `inheritStateCorrectionsForWorldlineFork` is reached through the bounded path.

Needed: either a server-side implementation of worldline set/rollback, or an explicit decision that these
are `intentionally_unsupported` for server-backed modes. Until then neither is promoted.

**RESOLVED (Task 21, 0.3.61).** Both entries below were `plugin_only = verified_supported`
without a focused execution test. That is a matrix defect, not a code defect: the features
worked, but the status claimed more evidence than existed. Both now carry an executed
entry point plus durable readback, so `verified_supported` is honest again.

- `HAYAKU-PACKET-DELETE-MAINTENANCE` — resolved by
  `hayaku_packet_delete_maintenance_runtime_test.cjs`: `ledger.forget` → `ledger.restore` →
  `ledger.orphanCleanup` through the deployed public ledger API, asserting the tombstone
  survives a reload of the same storage, `restore` returns the packet to a usable state,
  and orphan cleanup on a live scope is a verified no-op that removes **0** records.
- `FLASHBACK-EPISODE-INDEX` — resolved by
  `flashback_episode_index_rebuild_runtime_test.cjs`: record corpus →
  `maybeRebuildEpisodeIndex` → reload → identical episode membership, digest and manifest
  counters; the repeat run with an unchanged digest must not rebuild.

## P3 — diagnostics/UI-only inconsistency

**RESOLVED (Task 21, 0.3.61).**

- `LIBRA-WORLD-ADDITIONAL-RETIRED` — resolved by
  `libra_world_additional_retirement_marker_runtime_test.cjs`: legacy candidate records and
  all four legacy manifest field shapes → `purgeLegacyWorldAdditionalData` → candidates
  physically removed, manifest cleaned, `libra:v1:migration:remove-world-additional:v1`
  marker durable, second run and reloaded runtime idempotent, unrelated manifest data
  (commitId, stats, sibling nested fields) preserved.

**Evidence-collection rule learned here:** a test only counts if
`run_regression_batch.py` collects it. The runner globs `tests/*.cjs` whose name ends in
`_test.cjs` or `.test.cjs`. A file ending in `_repro.js` (e.g.
`tests/_libra_rc2_commit9_repro.js`, an embedded copy of old LIBRA v2.2.8 source) runs in no
gate at all and must never be cited as evidence.

## RESOLVED (2026-09-17): release smoke — three macOS-specific blockers

The release smoke set could not pass on this host. Three independent causes were found, and **all
three were fixed**, so the real builder now completes its smoke phase:

**1. NFD bundle filenames (43 entries).** Korean-named bundle entries were stored NFD on disk while git
stores NFC, so `cross_platform_launcher_test` could not find `1_서버_실행.sh`. Fixed by
`PROGRAM/tools/normalize_bundle_filenames.cjs`. (Full detail in the section below.)

**2. `prepare_data.cjs`: case-only legacy DATA was never adopted on macOS.**
`selectCaseOnlyLegacyDataCandidate` was gated to `process.platform !== 'win32' → return null`, on the
assumption that a case-only legacy directory is a Windows-only situation. macOS APFS is
case-insensitive by default, so `<root>/data` and `<root>/DATA` **are the same directory there**
(`statSync(a).ino === statSync(b).ino` is true while the resolved path strings differ). macOS therefore
skipped the `case_only_in_place` migration entirely and reported `legacyDataMigrated: false` even
though the data was already in place.
Fix: detect the case with **filesystem identity** (`sameDirectory` via device+inode) instead of the
platform name, and require the spellings to differ. `program_data_layout_test` passes.

**3. `remote_update_launchers_contract_test.cjs`: fixture compared a symlinked path literally.**
`os.tmpdir()` on macOS is `/var/folders/...`, and `/var` is a symlink to `/private/var`. The updater
correctly canonicalises through `fs.realpathSync.native()` in `UPDATER/runtime.cjs` → `validateRoot`, so
it returns `/private/var/...` while the test asserted against its own `/var/...` string.
**The earlier registration of this failure blamed a "non-ASCII temp path" and that diagnosis was wrong**:
the same assertion fails with a pure-ASCII `plain-` prefix, and the test **passes** when `TMPDIR` points
at a non-symlinked directory. The product code is correct; the fixture was wrong.
Fix: canonicalise the fixture root once with `fs.realpathSync.native(...)`. The test passes.

**4. `.DS_Store` was treated as a bundle entry.** macOS recreates `.DS_Store` in any directory Finder
has displayed. `program_data_layout_test` asserted an exact bundle-root listing, so it failed whenever
Finder had opened the bundle. Those files are gitignored, never tracked, and cannot reach a release
because the builder is an allowlist (`shouldCopySourceProgram` / `shouldCopyUpdater`).
Fix: filter known OS metadata (`.DS_Store`, `Thumbs.db`, `desktop.ini`) out of the listing instead of
treating macOS bookkeeping as a release artifact.

**Also fixed while verifying:** the installation inventory in `0_설치_안내.txt` was stale
(`Flashback Memory 1.0.95`, `LIBRA 2.3.125`). Regenerated with `tools/release_metadata.cjs`
(`syncReleaseGuides`), which is the tool for exactly this; `distribution_metadata_coherence_test` passes.

**Verification:** all **74/74** release-smoke tests pass, and
`distribution_builder_failure_runtime_test.cjs` — previously a registered TIMEOUT/FAIL baseline
exception — now **PASSES**.

## RESOLVED (Task 21 follow-up, 2026-09-17): NFD bundle filenames

**Was:** 43 Korean-named bundle entries were stored **NFD** on disk while git stores **NFC**.
This aborted the real release builder in `release_smoke`
(`AssertionError: missing cross-platform script: 1_서버_실행.sh`), so no Release/Source ZIP could be
built from this tree — a hard Task 52 blocker.

**Root cause detail worth keeping:** macOS APFS is a *normalisation-insensitive* filesystem, so on the
affected tree `fs.existsSync(NFC_PATH)` returned **true** and `os.path.samefile(NFD, NFC)` was **true**
even though a raw `readdir` reported 43 NFD spellings and **zero** NFC ones. Do not use `exists()` as
proof that the NFC directory entry is present.

**Fix:** `PROGRAM/tools/normalize_bundle_filenames.cjs` rewrites each entry under its NFC name
(copy → unlink → place under NFC). A plain `renameSync` does **not** work: it preserves the original
spelling. Verified safe before use against a scratch directory, and the tool refuses to run while a
regression process is active.

**Result:**
- 43/43 entries rewritten, 0 failures, 0 NFD entries remaining
- content SHA-256 identical before/after; `git status` shows **no** content changes (only names moved)
- `cross_platform_launcher_test` now **PASS** (was the builder's blocking failure)
- the real builder now reaches its **intended** failure path in the malformed-guide probe
  (`release_guide_inventory_invalid:LIBRA`), i.e. the smoke suite no longer fails on filenames

**Also cleared while verifying:** two `.DS_Store` files in the bundle root (macOS metadata) were
removed; `program_data_layout_test` asserts the bundle root contains only the documented entries, and
it was right to fail — those files were release-artifact pollution.

## LIBRA P01 embedding commit-failure propagation (2026-09-17, LIBRA 2.3.129 → 2.3.130)

Source: `reference/Librarian-System-0.3.63-ISSUES-AND-GRADIA-COMPARISON-PACKAGE`, §3 P01.

**Defect.** The unified vector retry writes the MEMORY ROW first and the MANIFEST second, so an
interrupted commit leaves durable storage DIVERGED: the row says `embedding.status: 'ready'`
while the manifest ref still says `embeddingStatus: 'pending'`. `ref.embeddingStatus` is what
selects work for the next flush, but completion was derived from the RETURNED object's status —
so the flush loaded the already-`ready` row, counted it `completed`, reported `ok: true`, and
left the ref outstanding. The ref therefore stayed selected forever: an unbounded no-progress
retry loop that reported success on every pass. Measured (probe): `reported_completed: 1`,
`reported_ok: true`, `reported_status: "ready"`, `durable_manifestRefStatus: "pending"`,
`newVectorCommitted: false`.

**Fix.** `flushUnifiedDerivedVectors` now decides completion from the DURABLE ref, never from the
returned object. When the row is embedded but the ref is outstanding it reconciles the ref from
the row and publishes it; if the publish fails the ref is restored and NOT counted as completed,
and the failure is surfaced through the diagnostic.

**Regression.** `tests/libra_embedding_commit_failure_propagation_test.cjs` — all three storage
modes. RED: `plugin_only: flush reported 'ready' while the durable manifest ref is still
'pending' — a failed commit was reported as a success`. GREEN after the fix.

## LIBRA Task 27–31 verification fixes (2026-09-17, LIBRA 2.3.128 → 2.3.129)

Tasks 27–31 verified LIBRA Recall / Embedding+vector / Cold start / Backup-restore-handoff /
source-edit consent in all three storage modes. Four of the five were clean parities; Task 30 found a
**real storage-mode defect** that made portable backup structurally impossible in `server_only`.

### Fixed — `bridge.*` called without the `space` argument (Task 30)

**Defect.** LIBRA's portable-memory storage adapter called the storage bridge's scope-aware functions
as if they were generic CRUD:

```js
await safeCall(bridge, ['keys'], [], []);   // -> scopedKeys(undefined, '', …)
await bridge.get(key);                      // -> scopedGet(undefined, key, …)
await bridge.set(key, value);                // -> scopedSet(undefined, key, …)
await bridge.remove(key);                    // -> scopedRemove(undefined, key, …)
```

The bridge exports its **internal** functions (`keys: scopedKeys`, `get: scopedGet`, `set: scopedSet`,
`remove: scopedRemove`), and each takes `space` as its **first positional argument**. With no argument
the SDK sent `space=undefined` to the server, which rejects it (`400`), so key enumeration returned
nothing and `collectRecords` threw `portable_backup_no_current_scope_records`.

**Impact.** In `server_only` the canonical and manifest live **only on the server**, so no local
fallback could rescue the enumeration: portable backup/export failed **every time**. `plugin_only`
worked because its records are local and the `compat`/`raw` fallbacks found them; `mirror` worked
because its local copy populated the same fallbacks. The failure was invisible to the regression
because **no test drove `exportCurrentScope` against a server-backed scope** — the existing portable
repros are all `plugin_only` vm fixtures.

**Fix.** Bind the plugin space explicitly at every bridge call (`'plugin'`, the space LIBRA owns), and
read keys through `bridgeKeysOf()`, which passes `('plugin', '')` and then falls back to the bridge's
own key inventory (`listKeys`/`getKeys`/`keyInventory`/`storageKeys`) if the direct scoped call
returns nothing.

**Verification.** `tests/libra_portable_backup_3mode_parity_test.cjs`.
RED (pre-fix): `server_only` → `Error: portable_backup_no_current_scope_records`, exit 1.
GREEN (post-fix): all three modes PASS — envelope excludes foreign-scope records, restore is an exact
replacement that preserves the canonical batch set, and the transactional checkpoint is released.

**Why not fixed in the SDK instead.** The bridge's inconsistent surface (some members take `space`,
`createPluginStorageProxy`/`createLocalStorageProxy` do not) is a real API hazard, but changing it
touches Flashback/HAYAKU/LIA/RE:TRACE and the SDK fork-divergence finding (#7); the plugin-side
binding fixes the defect without widening scope. Logged below as a follow-up.

### Verified clean (no change needed)

- **Task 27 — Recall.** All three modes recall the committed canonical with byte-identical excerpt
  payloads. `tests/libra_recall_3mode_parity_test.cjs`.
  *(Test note: the recall payload crosses the plugin VM boundary, so values built from it carry the
  VM realm's prototypes. `assert.deepEqual` under `assert/strict` compares prototypes and fails on
  identical content; the test compares JSON forms for that reason.)*
- **Task 28 — Embedding/vector lifecycle.** embed → readback → canonical preserved → failed-only
  retry, in every mode. `server_only` leaves **zero** owner vector rows locally; `mirror`'s local and
  server records agree (status/dimensions/vectorCount). `tests/libra_embedding_vector_3mode_parity_test.cjs`.
  The local `libra:v1:local-vector:<hash>` key is a derived read-through cache, not an owner record.
- **Task 29 — Cold start / manual recovery.** No analysis runs before the user asks; explicit cold
  start commits; a second cold start never regenerates a successful canonical; an explicit failed
  retry creates a **new** run and provider operation (the discarded run is physically absent); the
  canonical job head survives a plugin reload. `tests/libra_cold_start_3mode_parity_test.cjs`.
  **Mode-specific by design:** `plugin_only` records the failed batch in `manifest.failedBatches`,
  while the server modes roll the manifest back through the rejected-pointer CAS and keep the failure
  identity on the `run`/`work` records. Both are durable; the test asserts a durable record exists.
- **Task 31 — Source-edit consent.** Declining leaves the prior canonical byte-identical with zero
  reanalysis and an existing scan cannot bypass the gate (`SOURCE_EDIT_CONSENT_REQUIRED`); approving
  commits a new revision whose source digest reflects the edit. The consent record follows the mode's
  routing (local / local+server / server-only). `tests/libra_source_edit_consent_3mode_parity_test.cjs`.

## FIXED (2026-09-17): recovery quarantine — SQLite sidecar TOCTOU race (`server/server.cjs`)

**Observed failure.** A `release`+`source` build at 0.3.62 failed with
`distribution_command_failed:--test:1`: `remote_update_real_server_runtime_test` → `PASS: real HTTP +
SQLite + launcher success` reported
`ENOENT: no such file or directory, open '.../DATA/stores/retrace/retrace.sqlite-shm'`.

**Why it looked intermittent.** The same test passed standalone (3/3), in regression v10 (9.09 s) and in
regression v11 (10.18 s). It only failed inside the builder's smoke step, which runs the 74-test set via
`node --test` (parallel file execution) — i.e. under host load.

**Root cause (a real defect, not test flake).** `createRecoveryQuarantine`'s `capture()` helper used a
check-then-use sequence on the SQLite WAL sidecars:

```js
if (!fs.existsSync(sourcePath)) return;     // check
fs.copyFileSync(sourcePath, targetPath);    // use  <-- TOCTOU window
```

`-wal` and `-shm` are **not durable files**: SQLite deletes them when the last connection closes, and a
checkpoint can remove them at any moment. When one vanished between the check and the copy, the ENOENT
aborted the whole quarantine — the mechanism that protects user data during an offline restore.

**Fix.** `capture()` now guards the copy and treats a vanished sidecar as "nothing to capture"
(removing any partial target): the quarantine records only what it could actually read. Other sidecar
sites (`rmSync` inside `try/catch` with `force: true`) already tolerated missing files and needed no
change.

**Verification.** `tests/recovery_quarantine_sidecar_race_test.cjs`.
RED: pre-fix `capture` has no `catch`/`ENOENT` guard (and a replicated check-then-copy with the file
removed inside the window fails with `ENOENT` — the observed defect). GREEN: guarded capture survives the
same race, and `restoreBackupOffline`/`planOfflineRestore` remain exported entry points.
Smoke set 74/74 PASS afterwards; full 0.3.62 `all` build succeeded.

**Note on the earlier baseline entry.** The backlog previously listed `remote_update_real_server_runtime_test`
with `ENOENT ... .update/PROGRAM.next/VERSION.txt` attributed to non-ASCII temp paths. That was a
*different* symptom from the same test; this sidecar race is a separate, now-fixed defect.

### Follow-up (not blocking)

- The bridge should validate `space` (or default it to `'plugin'`) rather than forwarding
  `undefined` to the server. `createPluginStorageProxy` is the intended entry point and already binds
  the space; the raw exported functions do not.



## RESOLVED (2026-09-17): `program_data_layout_test` DATA migration

`program_data_layout_test` failed at its line ~97 (`receipt.legacyDataMigrated !== true`) on a clean
worktree at `990e7b2` too, so it was a genuine pre-existing defect, not a parity-work artifact.

**Root cause.** macOS APFS is case-insensitive: `/data` and `/DATA` resolve to the same directory
(`fs.stat` reports the same inode; only the `realpath` *strings* differ). The legacy-DATA candidate
selector `selectCaseOnlyLegacyDataCandidate` was gated on `process.platform !== 'win32'`, so on macOS
the `case_only_in_place` path was never reached and `legacyDataMigrated` stayed false.

**Fix.** `tools/prepare_data.cjs` — replaced the win32 platform gate with a real same-inode
(`fs.statSync(...).ino`/`dev`) comparison, so a case-only alias is recognized on any case-insensitive
filesystem.

**Verification.** GREEN: `migrationMode: case_only_in_place`, `legacyDataMigrated: true`,
`program_data_layout_test: PASS`.

## Working-tree defect blocking the release gate — superseded

The earlier registration below described the NFD symptom. It is retained for provenance; the NFD
portion is now resolved by `normalize_bundle_filenames.cjs` as described above.

**Symptom.** `distribution_builder_failure_runtime_test.cjs` fails on this working tree and the
real release builder aborts at `phase: release_smoke` with `distribution_command_failed:--test:1`,
even though the malformed-guide assertion it is supposed to hit never runs. The nested smoke
failure is:

```text
AssertionError [ERR_ASSERTION]: missing cross-platform script: 1_서버_실행.sh
  tests/cross_platform_launcher_test.cjs
  tests/distribution_metadata_coherence_test.cjs
  tests/program_data_layout_test.cjs
  ...
```

**Root cause (proven, not inferred).** The working tree stores **43** Korean-named files and
directories in **NFD** (decomposed) form, while git stores them in **NFC**:

```text
LIVE LIB/         0_설치_안내.txt  → NFD    업데이트.sh → NFD
git index         same names      → NFC
HEAD worktree     same names      → NFC  (core.precomposeunicode=true normalises on checkout)
```

Affected entries include `Librarian-System/업데이트.{bat,command,sh}`,
`Librarian-System/0_설치_안내.txt`, all `PROGRAM/*.sh|.bat|.command|.txt` launchers, the whole
`PROGRAM/관리도구/` directory, three `PROGRAM/docs/*.md` files and
`PROGRAM/DATA/이_DATA_폴더를_통째로_백업하세요.txt`.

**Proof it is the working tree and not any code change.** The identical test body plus the three
Task 21 tests copied into a clean `git worktree` at `990e7b2` **passes** (exit 0,
`distribution_builder_failure_runtime_test: PASS`), while the live tree with byte-identical
program sources fails (exit 1). The only variable is the on-disk filename encoding.

**Consequences if left unfixed.**
- `distribution_builder_failure_runtime_test.cjs` and `remote_update_launchers_contract_test.cjs`
  are registered baseline exceptions **for this NFD tree**, not for the code. The registration is
  honest for the inputs it names, but it hides the fact that the release builder cannot run here
  at all, which Task 52 depends on.
- `program-manifest.json` records 37 NFD paths, and the regenerated manifest is itself now in NFD
  form. The Release/Source ZIP will therefore contain NFD names, which do not equal the NFC names
  a Windows extractor or the updater expects.
- `0_설치_안내.txt` does not resolve by its documented (NFC) name, so any tooling that reads it by
  that literal path fails.

**Fix (not applied — needs an explicit decision, because it rewrites 43 filesystem entries).**
Either (a) re-create the entries from the git index in NFC form, or (b) set
`core.precomposeunicode=true` and re-checkout the affected paths so macOS normalises them. Then
re-run `update_manifest.cjs`, `update_checksums.cjs`, the four launcher/metadata tests and the
real builder. Do **not** "fix" any test assertion to accommodate NFD names.

## Known baseline exceptions (registered, not attributable to this change)

These fail on the pre-change checkpoint-3 tree with byte-identical inputs, so they are
environment-dependent and must not be used to declare a regression. Registered per the
completion rule that "this is probably not from my change" is never sufficient on its own.

| Test | Symptom | Root cause | Provenance |
|---|---|---|---|
| `flashback_scope_panels_browser_test.cjs` | `spawn /usr/bin/chromium ENOENT` | No Chromium at the POSIX path on this Windows host | Checkpoint-3 identical |
| `source_review_dock_browser_test.cjs` | `spawn C:/Program Files/Google/Chrome/Application/chrome.exe ENOENT` | Same browser-path family as above; macOS host has no Windows Chrome | Re-run at `990e7b2` reproduces identically |
| `program_data_layout_test.cjs` | FAIL on the live tree; FAIL at `990e7b2` too | Korean bundle-root names are NFD on disk; the literal (NFC) comparisons cannot resolve them — see the working-tree defect section above | Reproduces at `990e7b2`, so **not** attributable to Task 21 |
| `engine_consistency_v2_runtime_test.cjs` | `recall helper synchronization mismatch: HAYAKU_Locator_Continuity.js` | HAYAKU.js and `sync_recall_keyword_features.cjs` are byte-identical to checkpoint-3 | Checkpoint-3 identical |
| `distribution_builder_failure_runtime_test.cjs` | **NOW PASSES** (was TIMEOUT/FAIL) | The blocking cause was the NFD bundle filenames making the nested smoke suite fail before the malformed-guide assertion could run | Resolved 2026-09-17 — see the release-smoke section above |
| `remote_update_launchers_contract_test.cjs` | **NOW PASSES** (was FAIL: `Cannot find module` / nonzero exit) | **The previous diagnosis ("Non-ASCII temp path") was wrong.** Real cause: macOS `/var` → `/private/var` symlink made the fixture path differ from the updater's canonical path. The product code was correct | Resolved 2026-09-17 — see the release-smoke section above |
| `hayaku_server_only_recovery_shards_test.cjs` | TIMEOUT 60 s | HAYAKU byte-identical to checkpoint-3 | Checkpoint-3 identical |
| `libra_unified_server_writer_v1_test.cjs` | FAIL after 96 s | LIBRA.js, `server.cjs`, the storage SDK and the test are all byte-identical to checkpoint-3 | Checkpoint-3 identical |
| `recall_keyword_features_runtime_test.cjs` | `AssertionError: Standalone owner embeds identical reviewed helper` | Same helper-synchronization family as the HAYAKU mismatch; test is byte-identical to checkpoint-3 | Checkpoint-3 reproduces (exit=1) |
| `remote_update_release_zip_runtime_test.cjs` | `distribution_command_failed:--test:1` (52.7 s) | Nested real build in a non-ASCII temp path; no Task B reference; test byte-identical to checkpoint-3 | Checkpoint-3 reproduces (exit=1) |
| `remote_update_launchers_contract_test.cjs` | nonzero exit / `Cannot find module` | Non-ASCII (`librarian 복구 boundary …`) temp path | Checkpoint-3 reproduces |
| `remote_update_real_server_runtime_test.cjs` | `ENOENT ... .update/PROGRAM.next/VERSION.txt` | Same non-ASCII temp-path handling | Checkpoint-3 reproduces |
| `remote_update_standalone_recovery_test.cjs` | `Cannot find module ... updater.cjs` | Same non-ASCII temp-path handling | Checkpoint-3 reproduces |
| `prior_work_harness_regression_test.cjs` | FAIL only **inside** `run_regression_batch.py` (15.5 s); PASSes every time when run standalone (4/4 on the live tree, 3/3 at `990e7b2`) | Host-concurrency sensitive: the nested harness needs ~25 s of exclusive CPU, and the runner's 60 s budget is not the binding constraint — it passes alone but not under the runner's load. Not attributable to Task 21: LIBRA.js is byte-identical and the test passes at `990e7b2` too | Reproduces at `990e7b2`; **monitor** on a quieter host before treating as permanent |
| `compute_four_namespace_product_load_test.cjs` | Occasionally FAIL: `all four product namespaces must have overlapping Worker execution 3 !== 4` | Worker-overlap timing assertion; measured **3/4 PASS** standalone (so flaky, not deterministic) | Not attributable to Task 21 — no Worker/compute source changed. Observed failing only in the run where unrelated node test processes were launched concurrently; it passed in the clean run |
| `compute_product_worker_matrix_test.cjs` | Occasionally FAIL: `unexpected namespace concurrency for worker=4: {"peakJobs":4,"peakNamespaces":3}` | Same Worker-overlap family as above; measured **4/4 PASS** standalone | Fails only while another regression/test process was running concurrently. **Both Worker tests fail as a pair under host contention** |

> **Operational rule (learned the hard way):** `run_regression_batch.py` writes to a fixed log path, so
> two regression runs (or a regression plus any heavy test process) must **never** run at the same time.
> Doing so corrupts the shared log, makes unrelated Worker-concurrency tests fail as an artefact of host
> contention, and produces numbers that cannot be attributed to code. Run regressions strictly serially.

## Intentionally unsupported (documented, not a defect)

- `LIBRA-CONFIG-PERSISTENCE` (provider/prompt/runtime settings and credentials):
  intentionally local, never canonical owner data, so mirror/server_only parity does not apply.

## Acceptance criteria for promotion

A status moves from `unverified` to `verified_supported` only when a test executes the feature
with identical logical input in the mode and reads back durable owner state, plus:
- mirror: matching logical local/server digest;
- server_only: zero local canonical writes and a successful server readback;
- branch-sensitive features: repeated on parent/child/sibling scopes;
- source-edit-sensitive features: repeated after the edit-consent/reanalysis path.
