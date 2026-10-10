# Flashback Raw-Pending Recovery Implementation Plan

**Goal:** Persist captured source text independently of model availability, and preserve that source through reload, backup and predecessor restore without treating a missing vector as model-ready.

**Architecture:** Keep the existing record/shard/manifest store, verified copy-on-write commits and in-runtime scope mutex. An explicit source-bound embedding-work record distinguishes intentional pending work from a missing/corrupt vector. Model attempts will require a durable reservation; unconfirmed running attempts must not silently resend after restart.

**Tech Stack:** Existing JavaScript plugin, Node full-plugin VM tests, synthetic host/provider boundaries; no new packages.

**Spec:** Recovery plan F01/F02, `LIB-WM-Recovery-Plan-2026-10-02.md`; current recovery checkpoint `71cc44742c3ef41067e120e357ba16094634dba7`.

## Constraints and scope

- Preserve source text, source hashes, lineage and non-vector integrity/cache hashes
- Keep ordinary `plugin_only` capture available; no host-global CAS requirement is introduced
- No live model/provider requests or broad historical-suite rerun
- Modify only `PROGRAM/plugins/Flashback_Memory.js`, targeted tests and this plan
- Existing hash vectors remain readable legacy data; matching dimensions alone never establish configured-model readiness
- Partition 1 is intermediate. Removing all hash/fallback retrieval paths is partition 2. Full-inventory fair backfill, including a failing front batch and valid tail, is partition 3
- Server/integration, live-host concurrency and built-release verification remain separate gates

## Current-source findings and correction

- `finalizedCaptureCommitSettings` forces hash vectors; completed capture then schedules an in-memory remote upgrade
- `buildRecordsFromSources` embeds before persistence and fabricates a hash vector if its local vector slot is empty
- `saveScopeRecordsCore` serializes empty arrays and sidecar packing skips them. Runtime reproduction refined the static map: metadata-only vector audit, immutable archive validation and portable logical hydration reject vectorless records, while physical hydration previously returned early when no sidecar refs existed and wrongly accepted unmarked vector loss
- Correction of the initial preliminary statement: empty-vector serialization alone does **not** establish raw-only durability. All validator paths must understand an intentional source-bound pending record; unmarked missing payloads remain corruption. The physical hydration bypass was reproduced and corrected rather than claimed as an existing guarantee
- Scope locks are shared only through one `globalThis` coordinator. The server has lease/fence/conditional-batch support. The plugin-only branch bypasses that server layer
- Current commit IDs are a short hash of scope/time/count/Math.random. Reproduce equal-clock/random collisions before changing this. Strong unique IDs and collision checks are not create-if-absent or cross-runtime CAS
- Progressive maintenance loads the full corpus but starts selection at index zero each pass. Repeatedly failing early work may starve later work; this is a hypothesis pending the partition-3 failure/tail test

## Record contract

`embeddingWork.schema = flashback.embedding_work.v1` binds:

- `jobId`: scope/source/profile work identity, no raw dialogue copy
- `sourceRevision`: hash of source ID/hash, chunk index/count and exact stored text digest
- `targetProfile`: configured provider/model plus settings fingerprint, or null when unconfigured
- `status`: `pending` or `unconfigured` for intentional raw capture; `repair_needed` distinctly identifies detected legacy derived-vector damage. Later reservation adds explicit running/failed/uncertain/ready states
- Raw-only record: `vector: []`, no `vectorRef`, zero dimensions; no fabricated provider/profile readiness

The `isValidatedVectorlessRecord` predicate validates schema, status, exact source binding, equality of work scope and physical record scope, and vector representation. A repair marker additionally preserves the original vector metadata including embedding provenance as an opaque serialized value and checks its digest; it is not relabeled intentional pending. A forged marker, changed text, nonempty invalid vector or missing claimed sidecar must not bypass existing corruption checks. Copy/import may rebind work ownership to its new scope, but must preserve the source revision and original source hashes. Legitimate matching model vectors may be reused; legacy hash vectors must not count as model-ready.

## Review focus

1. Empty vectors must mean intentional pending work only, not lost sidecars
2. A partially failed write must leave the previous authoritative manifest/readback intact
3. Source identity must survive portable predecessor/copy rebinding without inventing a new source
4. A provider may return after scope, source, profile or backend changed; it cannot publish into the new authority
5. Two isolated runtimes do not share the local mutex; strong unique candidates reduce collisions but do not establish atomic manifest swaps

## Slice A: raw contract, capture and round-trip preservation

**Files:**
- Modify `PROGRAM/plugins/Flashback_Memory.js`
- Create `PROGRAM/tests/flashback_raw_pending_contract_runtime_test.cjs`

**Interfaces:**
- `buildRecordsFromSources(sources, settings, scope, {deferEmbedding:true, reuseRecords})` produces source-bound raw/pending records without provider submission
- `isValidatedVectorlessRecord(record)` validates intentional pending/unconfigured or explicitly recorded derived-vector repair state
- Existing `ingestSources`, capture, verified save/load, immutable archive and portable restore paths consume the same contract

- [x] Write failing full-plugin VM tests for no-model raw capture, zero provider submissions, exact text/hash readback after a fresh runtime, strict marker/body corruption rejection, and lost-sidecar rejection
- [x] Run `node --test PROGRAM/tests/flashback_raw_pending_contract_runtime_test.cjs`; retain the red log and first failed assertions
- [x] Implement the smallest raw-only builder and source/profile work metadata; thread explicit defer mode through intended completed-capture entrypoints
- [x] Allow validated pending rows through physical vector validation, immutable archive verification and portable logical hydration; preserve all existing corruption gates for other records
- [x] Add and run same-scope export/restore and predecessor-import round trips, including mixed legitimate vectors/legacy hash/pending rows and non-vector hash preservation
- [x] Reproduce candidate-key collisions under equal clock/Math.random, then use supported strong randomness and existing-key collision refusal; test serialized in-runtime writes and explicitly classify isolated-runtime limits
- [x] Report capture as switched only after its actual event/entry path is exercised. Pending records must not enter the old unreserved automatic upgrade queue

## Slice B: durable attempt ownership before provider calls

**Files:** same source and a focused runtime test, split if the fixture needs a separate coherent file.

**Interfaces:**
- Source/profile/job identity is already persisted with the raw row
- `reserveCapturedEmbeddingAttempt(scope, sourceHash, settings)` reloads under the scope mutex, verifies current source/profile/storage boundary, durably publishes one attempt identity, and returns only verified reserved work
- `processPendingEmbeddingWork({sourceHash,retryFailed})` reserves and conditionally publishes a matching model vector only while exact source/profile/scope/storage-configuration/attempt ownership remain current; `assertEmbeddingAttemptCurrent(proof)` is also called before each physical request
- `inspectEmbeddingWork()` reports durable state separately from runtime observation; a restarted runtime or orphaned operation observing a running reservation reports uncertain/recoverable status and performs zero automatic resubmissions

- [x] Write failing tests for reservation readback failure, successful/failed synthetic provider output, exact restart readback with zero unintended calls, and late source/profile/scope/backend changes
- [x] Implement reservation and conditional adoption using existing verified commits; never use unverified read-then-write as a claimed host-global CAS
- [x] Reuse matching legitimate model vectors without a new call; do not reuse hash vectors merely because dimensions match
- [x] Keep uncertain provider attempts recoverable rather than automatically retrying them; expose status before adding automatic scheduling
- [x] Run focused regression, syntax, whitespace and SDK-sync checks; request independent review before checkpoint commit

## Deferred gates

- Partition 2: remove adapter/default/error/query/runtime-overlay hash-vector paths, apply current-model readiness to recall and GUI without deleting integrity hashes
- Partition 3: durable restart/fair scheduling over the complete active local and inherited inventory; >batch-size failing-front/valid-tail test, model-change backfill and all relevant capture forms
- Local server tests only after their fixtures are audited for egress; real RisuAI behavior and built artifacts are not established by synthetic VM tests

## Slice A executed status (2026-10-02 KST)

- New focused runtime file: 22/22 tests pass. The actual completed-output capture path stores vectorless source/work metadata, and diagnostics report embedding incomplete rather than vectorized
- Eight-file offline regression: 35/35 runner tests pass, including the new file, profile compatibility, clone/portable vectors, 14 internal commit durability faults, restore validation, and source-edit tests. These are source/synthetic-host checks, not release/live-host certification
- Existing vector payload absence remains a fault. A new raw capture now preserves valid older text with an explicit `repair_needed` marker and original vector metadata, and that corpus survives backup/restore. This closes the reproduced old-lost-sidecar/new-turn-save block in the tested case
- Equal clock/Math.random reproduced a candidate-ID collision. Candidate IDs now prefer UUID/cryptographic bytes, retain a checked fallback for older sandboxes, and refuse existing candidates. Read-before-write checks are not atomic create-if-absent or isolated-runtime manifest protection
- Captured, progressive and full legacy embedding entrypoints reject new pending work before provider submission. Source-edit raw ingestion uses the same deferred construction path. Durable reservation is still pending; this checkpoint is not for release/merge
- Browser behavior and actual model measurements will be handed to the user for their computer. Continue cloud implementation and offline tests without labeling those local gates passed

Logs are retained with the recovery evidence: flashback-raw-pending-red.log, flashback-raw-pending-roundtrip-red.log, flashback-raw-pending-reload-collision-red.log, flashback-raw-pending-collision-refusal-red.log, flashback-raw-pending-legacy-damage-red.log, flashback-raw-pending-status-red.log, flashback-raw-pending-unreserved-red.log, and flashback-raw-pending-focused-regression.log.

### Slice A review corrections

The parent review found that a pending work scope was merely nonempty rather than equal to its record scope. Negative controls reproduced acceptance of both foreign work and foreign record scope. The validator now requires equality; trusted save/clone/archive transitions validate the original record first and then rebind work scope/job ID. Actual predecessor and chat-copy restore prove the destination binding changes while sourceRevision/sourceHash and the original source work remain intact. Damaged-vector metadata now also preserves embeddingProvenance before clearing active vector fields. The five targeted review controls failed before these changes; the final focused aggregate is 35/35, including 22 new controls.

## Slice B executed status (2026-10-02 KST)

The explicit source-scoped product API now reserves work with verified shard/manifest readback before any provider submission. It is bounded to 200 source records / 500,000 source characters and a 64-request operation ledger within the configured embedding timeout; incomplete source groups are preserved and refused before submission. This API is not yet an automatic scheduler.

The durable attempt binds runtime owner, job/source revision, semantic profile, storage-configuration digest and the complete non-vector source authority. Private active-attempt tracking distinguishes a live operation from an orphan, even within the same runtime. Every physical model request revalidates the proof. Output adoption and final durable readback require the same source/profile/scope/storage configuration/attempt. Definitive failures retain raw source with failed status; unknown outcomes remain uncertain and cannot be retried merely by setting retryFailed. Success stores an embedding completion receipt and removes active pending work.

Runtime tests reproduced and corrected false success during publication, orphan liveness reporting, same-runtime overlap reporting, source ownership metadata changes, further batches sent after source change, contradictory ready/profile status, incomplete-source submission, and reuse of a completion receipt after source text changed. Ready/reuse decisions now check the completion receipt sourceRevision. Credential, custom-header and execution-timeout changes each advance runtime generation while preserving the semantic profile, and late results are rejected.

Verification: 23/23 new reservation tests and 59/59 runner tests across the focused ten-file offline aggregate pass. Syntax, whitespace and SDK synchronization pass. The aggregate includes the 22 Slice A tests and existing profile, embedding-execution, clone/portable, commit-durability and source-edit regressions. It uses synthetic host/provider boundaries and a process-local egress denial guard; no live model/browser or actual server certification is claimed.

Storage binding currently covers current scope, mode, transition phase, configured URL and recovery state. It does not certify a physical server instance, credential-selected tenant identity or cross-isolated-runtime atomicity. Source verification currently uses the existing full-scope loader; large-corpus cost and fair scheduling remain partition-3 work. A late setting change inside an already-dispatched host write may leave correctly labeled old-profile derived output physically stored, but cannot be reported ready for the new profile; no rollback that could overwrite newer state is attempted.

Automatic capture scheduling, GUI job controls, removal of all legacy hash/fallback retrieval paths, model-change/inherited backfill and the failing-front/valid-tail fairness test remain open. The raw-pending and reservation checkpoints together are still not a complete model-only release. Browser and real-model measurement remain a user-computer handoff.

## Partition 2: configured-model-only construction and retrieval

Approved after checkpoint `2243c9a6ef83b6dded4963425c9d98e440b45377`. Source inspection found active adapter, provider-error, builder, legacy-compaction restore and query-overlay hash substitutes. Query failure can also flow into sparse/forced/state evidence. No-model raw capture remains available.

Files: Flashback_Memory.js, flashback_model_only_retrieval_runtime_test.cjs and this plan. Existing fixture tests that intentionally constructed legacy hash data may need explicit legacy fixtures; any changed expectation or incompatible historical contract is recorded rather than silently removed.

1. Reproduce default/disabled/hash generation, configured-provider failure fallback, incompatible/current-source receipt candidates and lexical injection after query failure
2. Use explicit unconfigured defaults, retain readable legacy provider identity, disable obsolete fallback settings/UI, require a configured real model in the adapter
3. Require current model/profile and source-bound completion receipt when present across all recall arms and stored-state consumers. Lexical scoring may assist eligible model vectors, but never substitute for unavailable query/model work
4. Preserve raw-pending/repair metadata through builder and legacy-compaction restore without generating hash vectors; leave existing legacy vectors intact for migration
5. Verify actual reserved-work-to-query-to-evidence positive and negative controls, plus a compatible record after over 128 pending front records. Fair backfill scheduling remains partition 3
6. Run bounded offline regression, classify incompatible historical fallback tests, request independent review before checkpoint. Actual browser and model measurements remain a user-PC handoff

### Partition 2 executed candidate (2026-10-02 KST)

The new 28-case runtime suite reproduced default/disabled/hash vector creation; configured-provider error fallback; pending/hash/foreign-profile/source-edited evidence reaching recall; lexical evidence after query failure; hash fabrication during legacy restore; emergency sparse raw evidence; a late profile change during shard reads; and a stale caller submitting to a former model. The actual timeout-hook control initially had an incorrect diagnostic read and was corrected; the direct emergency-helper negative established the removed behavior. The compatible-model positive and the record beyond 137 pending front rows passed before and after the cutover.

The shipped plugin now contains no hash-vector generator, hash worker, hash compute operation registration or runtime hash overlay. Defaults are explicitly unconfigured; obsolete fallback flags normalize to disabled, and GUI controls/wording no longer offer that route. Legacy vector values and profile metadata remain readable. Integrity, cache identity, source and archive hashes remain unchanged.

Every recall candidate arm and stored-state consumer requires a valid current model/profile and, where present, a current source-bound completion receipt. Lexical ranking is limited to eligible model records. Unavailable, failed or timed-out model queries produce no dynamic memory evidence. A query validates the live selected profile/scope before submission, before each physical provider request and again after storage reads. The hook retains model-readiness diagnostics and the GUI warning. Raw capture remains independent of model availability.

Legacy compaction restore keeps intentional raw work and preserves malformed derived-vector bytes/provenance as explicit repair evidence instead of truncating or replacing the vector. Neither filtering nor a failed query modifies stored source records.

Focused verification: 87/87 runner tests across eleven offline files pass, including 28 new controls, 23 reservation controls, 22 raw-pending controls, 14 internal durable-write/portable faults and the actual source-edit request-hook path. Syntax, whitespace and embedded SDK synchronization pass. Evidence is full-source plugin execution with synthetic host/provider boundaries and a process-local egress-denial preload. No built artifact, real browser, provider measurement, physical-server identity or distributed atomicity is certified.

Historical test changes are explicit:
- embedding_execution_v1 retired its expected hash overlay and now checks raw/ref preservation with zero candidate arms until compatible model replacement, plus a ready tail after 300 raw rows
- raw_pending_contract creates its lost-vector fixture explicitly as retained legacy data; all damage/new-capture/portable preservation assertions remain
- commit_durability_v135 rebuilds edited raw work through its source-bound factory before injected write faults, so the faults are actually reached
- source_edit_owner_path uses raw ingestion followed by durable reserved synthetic-model completion before checking the same hook gate and delivery assertions
- the shared embedding harness no longer exposes removed production overlay symbols

Read-only search found additional historical test references to retired routes in fallback_diagnostic_truth, hash_embedding_batch_pilot, storage_fault_sweep, portable_cross_chat_restore, episode_index_rebuild_injection_negative, context_engine_compatibility_runtime, recall_selection_hook_runtime and feature_parity. They were not run by this bounded aggregate and are not claimed passing; migration of their fixture/retired-feature assertions remains tracked separately from production behavior.

Automatic capture scheduling, fair complete-inventory backfill, source/profile-change work migration, inherited/archive work and recovery actions for uncertain attempts remain partition 3. This is still an intermediate checkpoint, not a complete release. Browser and real-model validation remains the user-computer handoff.


Parent review of the final consumer boundary found another real gap: scope changes during the hook's last manifest read were not reflected by its cached scope fence. Paired controls reproduce old-scope evidence on that path, and credential changes at the same boundary reproduce stale generation acceptance. The hook now reads current settings and then actual scope after manifest/worldline checks; the private prepared binding carries semantic profile and runtime generation. No await follows the final live check before evidence construction and hook return. Same-scope injection remains positive.

Receipt-less retained model records intentionally retain narrow backward compatibility: exact provider/model/profile (including existing official Voyage compatibility aliases), numeric/dimension validity and ordinary source/worldline/privacy gates are required. The old format has no completion receipt to prove the historical original model input; it is not retroactively certified. Raw-pending work and any record that does carry a completion receipt must satisfy their stricter source bindings.

## Partition 3A: nonblocking scheduling of current local raw jobs

Baseline is model-only checkpoint `86c62966b00cd3332ecd094210b80dafc7877a6d`. Files: Flashback_Memory.js, new flashback_pending_queue_runtime_test.cjs, and this plan.

The existing progressive worker selects from index zero and uses its former batch path. New raw work must instead use the reserved worker. Initial scope is the active local scope's existing validated raw jobs; legacy vector/model-change migration and immutable inherited/archive jobs follow separately.

- Discover every local response source group before selecting a bounded batch. Pending/unconfigured/repair work is eligible only when complete, within the source bounds and allowed by current worldline/privacy/source-edit authority. Provisional captures, incomplete groups, failed/running/uncertain groups and legacy migration work are exposed but skipped
- Use one shared physical-request ledger and hard deadline per pass. Per-item errors, malformed groups and retries cannot reset it. Skip definite failed jobs on later passes, so more than one failing front batch cannot starve a valid tail
- Reuse the existing verified per-source reservation and conditional adoption. Check source admission again before physical calls and adoption. Restart observes uncertain work without duplicate submission
- Wake background work after verified final capture, after exact live confirmation on a later request, startup/scope resume, and GUI settings completion. Scheduling itself performs no storage discovery and never awaits a provider on the response/request critical path
- Test actual finalized-capture return while the provider is held, provisional zero-submit, complete-inventory fairness and structural skips, shared request/deadline bounds, overlap, restart uncertainty and scope changes
- Discovery currently uses the existing full-scope loader and is not claimed constant-time. Source and backend binding still have the documented plugin-only isolation limits. GUI job status/retry wiring follows the core worker

### Partition 3A executed candidate (2026-10-02 KST)

The active local raw-job queue now runs through the verified per-source reservation worker, with a single physical-request budget and absolute deadline for each pass. It discovers the full local source inventory, skips structurally incomplete/provisional/private/unadmitted groups before selection, and leaves failed/uncertain jobs durable without automatic retry. Source admission is checked again before reservation, every physical request and adoption. Pausing automatic work lets an already-submitted job finish, then stops subsequent jobs.

Finalized capture schedules a background timer after raw durability, and returns before the held provider begins. A later request's exact live confirmation can wake pending work after request return; scheduled discovery defers while beforeRequest is active. Startup and GUI settings completion also wake the worker. Automatic continuation processes remaining eligible sources after a bounded pass, while unknown outcomes stop continuation. The GUI has an automatic-work toggle; detailed readiness and retry controls are the next slice.

Verification: 21 new controls and 108/108 runner tests in the bounded twelve-file offline aggregate pass. The fairness fixtures select the physical final record from durable readback because source numbering is not storage order; the prior assumption was corrected. Controls include 26 failing physical front items before a ready tail, 25 incomplete front groups before a valid tail, automatic continuation after nine failed front jobs, zero/shared request budgets, a logical-clock deadline, restart uncertainty, overlap, pause and actual capture/request/startup wakes. Syntax, whitespace and SDK synchronization pass.

The discovery cost is explicit: the synthetic 27-group failure case takes roughly 8–10 seconds through repeated full-source validation and verified commits. This is background correctness evidence, not a latency or real-model benchmark. Legacy/model-change vectors and immutable archive jobs still require preservation-aware migration. No broad historical suite or live provider/browser run was performed.


Parent queue review raised zero-budget/no-progress behavior. Automatic configured budgets currently normalize to at least one, while explicit manual API options can be zero. The manual controls reproduced misleading successful results and now report `budget_disabled` before inventory discovery, without leaking the per-scope active marker. A separate real scheduler fault reproduced repeated failed reservation writes to the same unchanged prefix. Passes now stop on unrecorded failures, and automatic continuation requires observed ready/failed progress. The failure leaves source records byte-for-byte unchanged and submits no provider request.

## Partition 3B: embedding job status and explicit retry controls

Baseline queue checkpoint is `f39dcbd83bfc5930a9ffbf6cf343f39581ddfd4e`. Files: Flashback_Memory.js, new flashback_embedding_work_gui_runtime_test.cjs and this plan.

Add a provider-tab job card backed by current durable inspection. Show source-group readiness, pending, failed, uncertain, blocked and legacy migration counts. Wire read-only refresh, one bounded pending pass and explicit failed-only retry to the existing queue. Failed-only retry must not silently include pending or uncertain jobs. Keep uncertain attempts visibly blocked until a later supported acknowledgement/recovery action is implemented.

Exercise the actual full-plugin event handlers using a small synthetic DOM boundary: current counts, provider call/readback after click, no resubmission of uncertainty, repeated click protection, no calls after scope change, and stale-read rejection after close/reopen. Refresh is asynchronous after paint and must not turn the UI open path into a provider call. Real browser validation remains the user-PC handoff.

### Partition 3B executed candidate (2026-10-02 KST)

The provider tab now has durable job status, read-only refresh, bounded pending execution and explicit failed-only retry. Inspection groups physical rows by source, reports incomplete/unadmitted groups as blocked, and shows the stored provider/model. Grouping uses indexed lookup rather than a quadratic corpus scan. Pending actions require a configured model. Failed-only retries exclude pending and uncertain jobs.

Displayed actions bind scope, semantic profile, storage configuration and runtime generation before starting. Runtime tests reproduced a stale displayed profile launching calls; the new binding rejects it before provider submission. The backend-change case was already a positive control and remains zero-call. A refresh cannot repaint a closed/reopened view, and parent review reproduced detached/closed/reopened old buttons still starting work. Actions now require the current connected visible root before any work read/write. Work-in-progress feedback and automatic background completion repaint are wired through actual product handlers.

Verification: 14 new full-plugin synthetic DOM/host/provider cases and 122/122 runner tests across the bounded thirteen-file offline aggregate pass. Syntax, whitespace and SDK synchronization pass. This does not certify real browser layout or interaction; those remain in the user-PC handoff.

Uncertain attempts are visible and excluded from automatic or failed-only retry. An explicit, bound acknowledgement/recovery action still needs implementation so these sources do not remain permanently stuck. Legacy/model-change and inherited/archive migration remain open. The card currently describes directly stored records for the active chat; it does not claim archive job coverage.
