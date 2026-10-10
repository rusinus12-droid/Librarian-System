# Flashback preservation and migration design

Baseline: `b54b265fed8d9a147e43a3b4618462f805aeef28`. The first unresolved-registry slice is an uncommitted review candidate; later slices remain planned. This is not a released guarantee.

## Required behavior

- Keep original text, source hashes, lineage and existing vector values through failed migration
- A legacy hash vector is readable data, never a configured-model-ready result
- A replacement model result is adopted only for the exact current source/profile/scope/backend configuration/attempt
- An unresolved attempt must survive replacement of the record's current work marker, profile A→B→A, reload, same-scope portable restore, and trusted copy/import
- No automatic repeat of an unresolved source/profile job. An explicit acknowledgement may authorize exactly one new, bound replacement attempt
- Keep raw capture working even when derived-work metadata is unavailable or at capacity
- Preserve the existing plugin-only in-runtime mutex and verified writes. Do not claim host-wide CAS or isolated-runtime exactly-once execution

## Current storage findings

`saveScopeRecordsCore` carries unknown manifest fields forward from the prior manifest. `saveScopeManifestCore` verifies physical readback and preserves the last verified manifest. This permits a small attempt registry to be published in the same authoritative manifest as a new raw-work reservation. Portable export already collects complete manifest values and referenced dependencies; restore/clone ownership rules still need explicit registry validation and rebinding tests.

The current v1 marker deliberately describes vectorless raw work. Attaching it to a retained nonempty vector would violate its validator and could discard recoverable data. Archive re-embedding already builds a new immutable vector overlay and conditionally swaps the active archive reference; that mechanism should be reused after durable archive jobs are available.

## First implementation slice: durable unresolved-attempt registry

Files: Flashback_Memory.js, a new focused attempt-history runtime test, and this plan. Keep legacy conversion disabled until this slice is verified.

Add a versioned registry to the scope manifest. Entries contain only job/attempt/source/profile identity, runtime owner, physical-submission state and acknowledgement links; never duplicate source text or credentials. Normal completed attempts can leave the open registry after their verified receipt is published. Unresolved or explicitly superseded-unknown history remains retained. Enforce a documented metadata byte budget before starting a new model attempt; refuse with a local capacity status rather than silently truncate history. Raw capture continues with the existing registry unchanged.

Reservation transaction:

1. Load and strictly validate the existing registry. A missing field is the pre-registry format; a malformed existing field is a repair state, not empty history
2. Seed current v1 running/uncertain rows into the registry conservatively, because their old physical submission outcome is not provable
3. Refuse a new attempt if its exact job identity has an unresolved predecessor without a matching acknowledgement
4. Publish the raw record's running attempt and its reserved registry entry through one verified shard/manifest commit
5. Before the first physical request, durably mark the same attempt submitted and revalidate source/authority. A restart observing submitted/unknown never resends automatically. This slice conservatively blocks reserved-only attempts after restart too; a missing acknowledgement is never evidence that no physical call happened
6. Publish known success/failure and the matching receipt/state through verified commits. An interrupted/indeterminate publication keeps history rather than guessing that the provider was never called

Every ordinary record rewrite must retain the registry. Source/profile changes may create a distinct job while the old unresolved job remains represented. Returning to that earlier source/profile finds the old unresolved identity and blocks a duplicate call.

Tests before implementation:

- A→B→A with A physically unresolved, including fresh-runtime readback and zero repeated A calls
- Current record replacement must not erase prior unresolved history
- Reservation/registry/submission write failure causes no unauthorized model call
- Submitted outcome lost across restart stays blocked; known reserved-only state is distinguished conservatively
- Malformed existing registry and capacity exhaustion preserve bytes and block model work while new raw capture still succeeds
- Same-scope portable restore and trusted native-copy/predecessor ownership transformations preserve/rebind unresolved history; no source/hash invention

## Second slice: retain vectors while replacing their model profile

Introduce a distinct retained-vector work contract rather than weakening v1. It binds the source revision, target profile and digest of retained derived metadata/vector values. Existing vector fields remain physically intact while work is pending/running/failed/uncertain, and remain ineligible for current-model recall while work is outstanding. Validator, hydration, copy and portable paths must support that contract explicitly.

On successful verified replacement, publish the new model vector and completion receipt. Failed or stale work preserves the old vector and source. Matching legitimate model vectors can be reused without a call. Profile changes consult the durable registry before constructing another job; returning to an unresolved earlier job stays blocked. No destructive legacy cleanup is part of this partition.

The initial migration consumer operates on directly stored records and then the complete local inherited-copy inventory. Tests cover exact retained vector equality before success, provider/storage failure, profile/source changes during await, source tamper, restart and export/restore. The existing full-inventory queue must demonstrate a valid tail beyond failing/malformed front groups after migration creates its jobs.

## Explicit uncertain-attempt recovery

Expose a per-source recovery choice only for an inactive uncertain attempt. The displayed snapshot must bind source/job/attempt IDs, current profile, scope and storage configuration. A private issued token prevents accidental use of another view's acknowledgement. The UI explains that the old request may still complete and that a new request may incur duplicate cost; cancelling makes no writes or calls.

An accepted acknowledgement is persisted with the exact predecessor and exactly one successor attempt before provider submission. Known active same-runtime attempts cannot be superseded. A stale, reused, foreign or closed-view acknowledgement causes no work. The old attempt/history is retained, and a late old result fails ownership checks. This is explicit recovery authorization, never proof that an unknown physical outcome became known.

## Immutable archive slice

Add archive jobs bound to the active owner scope, exact archive head/physical source identity, source revision and profile. Preserve predecessor raw archives and their attempt history. Reserve in the active owner's durable registry, create verified immutable vector overlays, and adopt only if the archive head and active lineage remain current. A sibling/predecessor archive must not be mutated. Migration of legacy maintenance entrypoints must route through these jobs before claiming coverage.

## Remaining gates

- Real browser, actual model/latency measurements: user-PC handoff
- Actual physical server/tenant identity and cross-isolated-runtime atomicity: later server/integration gate
- Complete lifecycle routing for cold start, source-edit completion, full rebuild, profile change, inherited/archive backfill and restart
- Historical test fixtures tied to retired hash/fallback behavior need explicit migration, not deletion or weakened assertions
- Full inventory discovery/validation cost remains visible; no constant-time claim

## First-slice review evidence (2026-10-02)

The full plugin source runs in a synthetic host, with process-level outbound networking disabled. Eighteen focused controls pass: published submission state before the first wire, A→B→A, restart and same-scope portable restore, malformed/capacity preservation, refused writes, physical false acknowledgements, unavailable submitted readback, native copy, portable predecessor import, exact-origin grouping and origin tampering. The final bounded 14-file offline aggregate passed 140/140 (exit 0). The two prior incomplete-group fixtures were updated to include origin in their job digest; their blocked-group and tail-progress assertions are unchanged.

Logical history is keyed by original scope, source revision and semantic profile. New physical job IDs additionally bind current scope and original scope; pre-registry raw-work IDs remain readable and are upgraded only at trusted ownership rebinding or a newly reserved attempt. Worker admission refuses ambiguous source hashes across origins; the background queue selects the exact origin. Copy/import retains the original logical history and rebinds physical ownership. Malformed copied history remains a repair state with the original registry values preserved.

The initial legacy-seeding test result was refuted. Deleting the modern field during an active runtime let an already-started retirement metadata save republish it, so the apparently passing control did not prove legacy migration. The corrected fixture quiesces writes, modifies the actual stored old-format manifest, and starts a fresh runtime. A source mutation disabling raw-save carry-forward now fails at the required preservation assertion; the real implementation passes. The temporary source mutation was applied only inside the verification loader. Parent review also identified a submitted→reserved downgrade gap. Both a single-batch final adoption and a later physical batch were reproduced before the fix; after submission publication is attempted, every authority check now requires the submitted registry state. Both controls pass without overwriting the downgraded snapshot.

Scope limits: no retained-vector migration or new archive-worker scheduling is enabled here. Copies/imports preserve registry history so those later workers can consult it. Reserved/submitted/uncertain history remains conservatively blocked without explicit recovery; the acknowledgement UI/one-successor protocol is a later slice. The in-runtime lock and readback checks do not establish host-global CAS or isolated-runtime exactly-once delivery. Server identity certification and real provider/browser measurements remain separate gates.

## Retained-vector review candidate (2026-10-02)

The new `flashback.embedding_retained_work.v1` contract binds the source revision, physical/logical ownership, target model and exact retained vector/metadata digest. Pending vectors stay in the existing shard's inline representation so sidecar conversion and six-decimal rounding cannot alter them. Worker writes use verified metadata-only commits; comparison ignores physical layout fields while retaining exact source, vector and semantic metadata comparison. New model output is explicitly converted to its validated Float32 storage representation before adoption.

Preparation runs through the background/manual queue, outside the active `beforeRequest` work. Defaults limit newly inlined vector JSON to 1 MiB per preparation pass and 2 MiB per target shard, with bounded per-call options for verification. Budget exhaustion or refused candidate writes reports deferred migration and preserves the prior committed data. These are local operation budgets, not a measured host quota guarantee. The GUI starts both pending and legacy migration; failed-only retry skips unrelated preparation. The shared request/deadline ledger remains in force, and a deferred retained-profile preparation cannot be bypassed by the ordinary worker.

A currently configured, profile-compatible retained vector can remain ready under its existing validated source/metadata proof. Returning to that model does not rewrite its old values or synthesize a new completion receipt. The earlier no-receipt legacy compatibility remains limited to the existing exact profile checks; this does not prove that a pre-contract input never changed. Unknown history for another profile remains persisted and blocks that profile on return.

Focused controls include inline/sidecar equality and restart, actual queue pre-wire reservation, definite failures and explicit retry, tamper refusal, byte/shard budgets, refused writes, an unselected precise Float32 vector, trusted copy and portable predecessor ownership, compatible prior model reuse, profile change during await, B→C→B unresolved history, more than a batch of failed migrations with a valid tail, GUI wiring, failed-only isolation, and finalized capture after a lost retained derived vector. The latter preserves the old work/provenance as repair evidence while retaining new raw text. Actual browser/model measurements, storage quotas and server identity remain unmeasured.

Evidence corrections: the first unselected-vector fixture was already six-decimal rounded and did not reproduce the precision issue. A valid precise Float32 fixture exposed it before the metadata-only worker fix. The first inline-legacy fixture failed to produce a model record because its storage fixture was disabled too early; the corrected actual producer creates the record before switching its storage representation. Only the corrected controls support the preservation claims.

Still pending: explicit uncertain-attempt acknowledgement and one-successor recovery, archive model-worker lifecycle, remaining legacy maintenance entrypoint routing, actual release build and user-PC validation handoff.

Retained candidate verification: 19 retained tests plus 15 GUI tests passed in the independent frozen-source review. The final bounded 15-file offline aggregate passed 160/160, exit 0. Source SHA256: `8977278462663e7498503a5124a7b1c7324186c26ae863057f3813613e71aa71`. Per-shard accounting follows the same loaded-record order and configured shard size used by the metadata-only writer; it measures retained vector JSON bytes, not total raw-text/metadata overhead or the host quota.

## Explicit uncertain recovery implementation plan

Issue a private offer for one displayed source/origin group. Bind it to the current source-set projection, all matching unresolved registry entries, model, scope, storage configuration and runtime generation. The actual GUI asks whether to send exactly one replacement request despite the prior physical outcome remaining unknown. Cancelling or a stale/closed/foreign offer performs no work. Known active same-runtime attempts cannot be acknowledged away.

On acceptance, consume the private token once and atomically publish one named successor's running records/reserved registry entry plus append-only acknowledgement links in every matching predecessor. Preserve the old entries as physically unresolved; acknowledgements never mean the old call did not happen. Verify the links at every physical request and before adoption. A failed or uncertain successor does not unlock ordinary failed retry; another successor requires another explicit offer and acknowledgement. Registry capacity and retained-vector byte budgets continue to apply before submission. Scope is direct local groups; archive model workers remain separate.

Verification begins with exact current-format and pre-origin raw-work records, then successor uniqueness/readback, accepted/cancelled actual GUI dialogs, token substitution/reuse, source/profile/scope/backend changes, closed/reopened views, active original requests, link tampering, refused writes, restart, and failed successor behavior. Tests remain synthetic and offline.

### Recovery review candidate

The core and actual GUI paths now pass 21 focused offline controls. The dialog is per displayed source group and explains possible duplicate processing/cost. Its private token binds scope/origin, source projection, profile, runtime generation, storage configuration and the exact unresolved-entry snapshot. Confirmation appends a digested acknowledgement to each unknown predecessor and commits one named successor reservation atomically with its work records. Every wire, adoption and final readback validates the acknowledgement links. Unknown predecessors are retained; a failed successor requires another explicit acknowledgement before a new successor.

Closing the GUI cancels its pending recovery dialog; retained old buttons, foreign tokens, changed views and cancelled dialogs create no work. Capacity exhaustion preserves history and raw source. The registry limits acknowledgement history to 128 records per predecessor within its existing overall byte limit, and recovery applies the retained-vector byte budgets before reserving. These limits defer recovery rather than truncate history.

The pre-origin v1 compatibility control found and fixed a real source-projection mismatch: materializing an equivalent explicit logical origin changed the earlier proof hash. Source authority now always includes the canonical logical origin, so the old and newly materialized representations bind the same source. This does not remove the source/body or origin check.

Evidence remains full-source synthetic host/DOM execution with outbound network disabled. This is not evidence of a built release, actual provider measurements, host-global CAS or server identity certification. Archive model-worker lifecycle and remaining legacy maintenance routing remain open.

Recovery verification: independent frozen-source run passed 21/21, with source/test hashes matching. The bounded 16-file offline aggregate passed 181/181, exit 0. Source SHA256: `27942344340faf6db1f8847d92ecab96a8485063bc1ac5e9f32127f5d9067909`.

## Local maintenance entrypoint cutover

Route captured-turn, progressive and full local maintenance through the verified direct-source queue before archive expansion. Preserve exact source selection, current settings/scope checks, the original operation ledger, absolute deadline and maintenance source-validation callback. Record/character budgets apply to complete source groups without hiding a smaller valid tail. The registered GUI maintenance route and actual old APIs must inspect submitted reservations during every corpus request. A query-purpose connection probe is separately identified and shares the request budget. Old archive submission must remain pending until its owner-ledger worker is implemented. Source rebuild, cleaning and clone-repair document submissions remain separately tracked.

### Local entrypoint review candidate

Seventeen focused offline controls pass for captured/progressive/full APIs, the registered advanced GUI handler, and the automatic GUI handler's vector-only repair case. Every corpus request observes its submitted durable reservation. Shared-ledger accounting includes previously spent metadata/preflight requests, exact captured-source selection is preserved, stale caller settings are refused, and whole-group record/character budgets retain a smaller valid tail after an oversized group. Maintenance source validation is carried into preparation, every provider authority check and adoption.

The three earlier raw-pending guard tests were first observed failing under the intended routing change, then strengthened to inspect the submitted reservation and prove that an unknown outcome is not retried on a second invocation. The old archive submission body now reports pending work without a model call, including automatic maintenance callers. Legacy restore finalization wakes the existing durable background queue instead of the removed retry scheduler.

This checkpoint does not close source-changing cleanup, sync/rebuild ingestion or clone repair. Their document submissions are still separate routes requiring raw-first durable publication; the automatic GUI control here covers unchanged-source vector repair only. Archive owner-ledger work remains next after those remaining local routes are addressed. Matching configured vectors are reused rather than forcibly reissued, and the advanced maintenance description now says so. No actual browser/provider or release-artifact claim is made.

Parent review exposed a per-pass budget gap inside a multi-batch source: a shared ledger with limit 10 allowed 10 physical requests despite a queue-pass limit of 2. Fresh and partly used parent-ledger controls reproduced it. A bounded forwarding ledger now enforces the pass limit at every physical reservation while preserving the original parent's accounting and settlement. A budget rejection after all submitted batches are known complete is a definite failed job; an unsettled physical request still preserves uncertainty. Both new controls pass, bringing this focused suite to 19 cases.

Local-route verification: independent frozen-source run passed 19/19 with matching hashes. The final bounded 17-file offline aggregate passed 200/200, exit 0. Source SHA256: `636eec9610ebd6e3b16cf2b65b472b16becb453d3b7e2047f8e9a923b13a8d33`.

## Raw-first source maintenance continuation

First bind ingestion/cold-start/rebuild to raw publication before model work, retaining their existing source/currentness checks. Synchronous callers may enrich only after verified raw publication and lineage admission; capture and `beforeRequest` stay nonblocking. Provider failure must leave the new source durable and report pending/failed/uncertain status accurately, never count every non-isolated source as embedded. Explicit raw-only options must make zero provider calls.

Then handle source-changing cleanup and clone repair with the same source-preservation contract. Existing retired-worldline history has a hard cap and full rebuild resets it; neither behavior can silently discard old variants in a preservation claim. Retention/capacity controls are required before broadening those writes. Archive jobs remain deferred.

### Rebuild preservation repair checkpoint

The unchanged-source rebuild now reconciles the existing worldline instead of resetting it. Complete matching raw source groups retain their original payload, IDs, embedding origin, legacy vector and unresolved work history during raw publication. A verified live-chat copy is matched through its copied provenance, exact source body, message positions/IDs and raw digest, preserving its original logical source even when collecting the copied chat derives a different chat-based ID/hash. Ambiguous or incomplete groups are not accepted as unchanged. Legacy vectors remain retained data rather than configured-model readiness; only a valid durable replacement makes the group ready. Raw publication and lineage annotation use the existing metadata-only commit/readback path so precise sidecar values survive failure, deferral and refused adoption.

Both existing worldline limits remain 2,048. Normalization now refuses an over-capacity node/retired-record set with `FLASHBACK_WORLDLINE_PRESERVATION_CAPACITY` instead of silently slicing history. Reconciliation validates the proposed retired set before removing retiring raw rows from the active corpus. Boundary controls compare the actual stored worldline bytes, complete known ID/source-hash/text arrays and the active manifest/shards; capacity refusal submits no provider work. A rebuild can already have published new raw data before lineage admission fails, but the operation rejects instead of claiming completion and the old worldline remains intact. Existing over-capacity legacy states now also refuse normalization and require an explicit preservation recovery path.

The supplied 12-test WIP first reproduced 9 passes/3 failures. Correcting the trusted-copy setup through the normal automatic adoption route preserved its assertions and independently exposed the product failure. The final 18 controls against the immutable original WIP pass 9/fail 9; against this repair they pass 18/18. The nine original raw-before-request/reservation, provider-failure retention and explicit-defer controls remain unchanged. Field tracing reads physical pluginStorage manifest/shard/worldline data and reloads it in a fresh runtime: retired original text and lineage markers, exact legacy vectors/source hashes, and copied origin/uncertain registry entries all survive. The final frozen-source run of these 18 controls plus the 13 existing narrow Flashback files passes 208/208, exit 0. Source SHA256: `2e3cc16f6b04c31904f04c6c909062dbd122ad101fef319b94c41dcfc3448d0a`; focused-test SHA256: `83e03e821101884c48da509b88a947613ace16858b73d40561be979bc71c25b9`. All Node execution uses the no-model/no-network preload and synthetic providers; no actual model requests are made.

This checkpoint closes unchanged-source rebuild, normal trusted-copy preservation and common capacity refusal. The shared normalizer/preflight also affects worldline loads/saves and reconciliation callers, but does not certify every entrypoint. Unchanged legacy retention in ingestion/cold-start, source-changing cleanup/consent completion, repair-then-adopt cloning, rebuild retirement/archive movement and archive owner-ledger workers remain the next F01/F02 units. They require their own source/owner/revision/active-head/profile/backend/attempt fencing and physical readback tests before broader preservation claims. Non-capacity failures between the separate active-corpus and worldline writes, browser/provider execution, cross-runtime/global CAS and release builds remain unverified here. Independent review and metadata regeneration follow controller integration.

### Independent review: changed chunk settings

Independent review exposed an additional unchanged-source boundary: changing `chunkChars` from 12,000 to 240 with the exact same host body produced a new 12-chunk generation. The old matching required the same chunk count and therefore dropped the original vector before the provider call. A trusted copy with an unresolved original attempt also became a new native source and submitted work. Preserving origin alone would be insufficient because logical embedding job IDs include each chunk's source revision.

The narrow preservation repair now explicitly refuses this generation transition with `FLASHBACK_REBUILD_RECHUNK_PRESERVATION_REQUIRED`. It first validates complete groups and reconstructs the exact raw source independently of chunk boundaries, then checks the original source ID/hash or verified copied provenance, message identity, origin and raw digest. A changed chunk layout cannot replace the old corpus or create new work. The public rebuild rejects before publication; maintenance/GUI applies the same check before its connection probe and surfaces the error through the registered handler with a failed journal and no completion result. This is a safe refusal, not completed rechunk support. F01 must implement a source-generation handoff that preserves exact old vectors/history/provenance separately from new raw chunks and does not bypass unresolved attempts.

Four new controls cover fixed synthetic failure/success transports, trusted-copy uncertainty and the actual rebuild GUI. They compare all physical scope pluginStorage and local-sidecar bytes, existing retired-worldline markers, source IDs/hash/body/origin and attempt registry. Precise Float32 sidecar payloads are decoded directly from storage and checked again in a fresh VM. Both native transports and the copied source make zero calls, including after restart. These controls first fail 0/4 before the refusal and pass 4/4 afterward; the immutable original WIP passes 9/fails 13 against the final 22 controls. The initial 208-test evidence is retained separately. The final frozen-source regression passes 212/212 (22 focused plus the existing 13 files/190), exit 0. Source SHA256: `5de7a42d9a3d8c5160a6b3ce3d2b6f499f1308b896e5f64746e4462ac243f602`; focused-test SHA256: `ad44ef9a7a358ffd4da93741f3667782f195d2937a2eebfce687855e73081f79`.

### Existing worldline integrity refusal (2026-10-03 private review unit)

Base: `c0f59588aca4bdb1b17294069cee0655c5707214`, Flashback source SHA256 `01601ded1ed0802dec9b4c96e1da0f1bf3aef5140470136182a6d19337d13ee2`. The 22 integrated raw-first/rebuild preservation controls pass on that base; the old WIP failures do not describe the current source.

A new physical-storage control exposed an independent current-source defect. Truncating one closing brace from a persisted worldline that contained retired raw text made `loadTurnWorldline` parse it as null and normalize it to empty history. Rebuild replaced the worldline with `retiredRecords: []` and made one synthetic provider call. Valid JSON with invalid/duplicate history rows also lost those rows during normalization. Rebuild published its active raw generation before a later worldline read could report an unavailable or newly corrupt history.

The loader now distinguishes absent storage (`null`/`undefined`) from existing invalid bytes. It refuses an invalid root/version/scope/array structure or normalization that discards nodes/retired rows with `FLASHBACK_WORLDLINE_PRESERVATION_INTEGRITY`; capacity refusal retains its existing code. Rebuild reads history before scope preparation and checks it again under the existing scope write lock immediately before publishing replacement raw records. Invalid/unavailable history cannot authorize that publication or a model request. Empty string is existing invalid evidence, rather than absent storage. The normalizer's construction behavior for new valid history is unchanged.

Thirteen new controls cover truncated JSON, empty bytes, parsed null, array root, missing arrays, foreign ownership, unknown version, invalid/duplicate nodes, an unreadable retired vector, read rejection, corruption after preparation, and genuinely absent first-use storage. They compare exact physical scope manifest/shard/worldline/local-vector bytes; the structural-corruption controls also reload in a fresh runtime. Replaying those controls against the immutable base yields 1 PASS / 12 FAIL. The candidate passes all 35 focused controls, including the previous 2,048-node/retired-record capacity tests, exact retained vectors, normal trusted-copy uncertainty and rechunk refusal.

The first ten-file narrow related regression yielded 95 PASS / 1 FAIL (96 Node verdicts). The failure is `flashback_raw_cow_append_runtime_test.cjs`'s `actual registered capture to final hook rejects reused removed-vector after recall preparation`, at `assert(mutated)` because the final-consumer fixture hook was not reached. The candidate's full raw-COW file recheck also yields 25/26, with the same failure. The same exact case passes 1/1 in separate candidate and immutable-base runs; running the three final-hook controls in their original sequence reproduces the same 2 PASS / 1 FAIL on both candidate and immutable `c0` source. This demonstrates the failure precedes this unit, while its fixture/order root cause remains unproven. All failing logs are retained, and no fixture or assertion was weakened. Verdicts for IIFE files represent one Node entry each; their internal assertions remain in the logs.

Scope: a bounded fail-closed preservation unit for existing history reads and full rebuild publication. It does not repair malformed bytes, provide source-generation/rechunk migration, close unchanged legacy ingestion/cold-start or source-changing cleanup/clone repair, implement archive owner jobs/GC, or establish cross-runtime CAS. Full aggregate/model/browser/release checks were not run. All Node processes use the no-model/network preload and synthetic providers. Parent review and durable backup of the private commit/evidence precede any promotion.

### Independent review: node identity compaction boundary

Checkpoint `294ea71f452672275251ceec13576ec0f0310dbb` and its original bundle/evidence are retained. Independent review found that two persisted node IDs with the same first 96 characters passed the loader's row-count check. Compaction gave them one identity, and an actual raw-only rebuild subsequently removed the second original variant. A single over-width ID also changed its persisted identity. Both real rebuild controls failed on the checkpoint with unchanged provider call count zero; a control with two distinct IDs of exactly 96 characters already passed.

The strict loader now requires each persisted `turnNodeId` to appear unchanged in the normalized identity set. Combined with its existing row-count validation, this refuses compaction or collision before raw/vector publication using `FLASHBACK_WORLDLINE_PRESERVATION_INTEGRITY`. Normal construction/saving of valid history remains unchanged. Existing non-stable IDs require explicit preservation recovery rather than an implicit truncation during loading.

The two refusal controls compare exact worldline bytes and all physical scope manifest/shard/local-vector bytes, then prove the same refusal and unchanged bytes in a fresh runtime. The positive boundary control verifies both original variant IDs survive an actual rebuild with exact 96-character IDs. Targeted verification changes from 2 FAIL / 1 PASS to 3/3 PASS; the complete focused suite passes 38/38, including all previous raw-first, provider-failure, retired-history, capacity, trusted-copy, integrity and rechunk controls. Syntax and diff checks pass. Full project/model/browser/release checks were not run, and the previously documented raw-COW sequence issue is outside this identity-only follow-up. All execution uses the network guard and synthetic providers.
