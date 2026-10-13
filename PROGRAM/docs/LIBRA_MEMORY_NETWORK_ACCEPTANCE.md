# A2 acceptance evidence

| Requirement | Qualified result | Evidence |
| --- | --- | --- |
| Owner/frame-bound derived postings and reverse dependency invalidation | Implemented; metadata is not authority | `libra_network_incremental_index_test.cjs` |
| Trusted unchanged revision and verified edit/delete/append/reorder delta | Implemented factory interface; synthetic receipts only, product host fast path unavailable | Same test; exact prior revision, exhaustive unique IDs, append prefix and owner isolation |
| Paging beyond 64 tokens; oldest entries; no recent-N cutoff | Implemented posting access; first page does not read all posting IDs | Same test with 150 keys and 7-item allocation pages |
| Cooperative new runtime fallback work and cancellation | Implemented; interrupted/invalidated mutation remains partial, concurrent writers reject, query exhaustion does not certify dirty coverage | Same test and real registered hook |
| Guarded runtime cache boundary and contention | Direct preview/read-only paths skip optional preparation; real queued vector publication rejects stale guarded delivery; exact busy cache exception skips prep and preserves A1 candidates | `libra_network_runtime_access_boundary_test.cjs`; source changes still fail closed |
| Actual beforeRequest cost trace | Measured plugin_only, separate final physical proof and raw readset observations | `libra_network_search_cost_probe.cjs`; server_only parity guards in A1 regression |
| Unchanged warm catalog reconstruction and document embedding | Zero in fixtures; selected hydration/physical proof checks remain active | Actual-hook trace and provider counters |
| Warm full metadata/signature/raw-history-zero | **BLOCKED**: no trusted host-wide revision; exact inherited raw identity validation remains | Reported full-ref/byte/hash/parse/raw-body counters, not waived validation |
| Actual 1k/10k/100k resource curve | Historical pre-resume 1k/10k measurements belong to scale/exact-PROGRAM snapshots in task-A2-report; current exact-source small observations are reported separately below. **100k BLOCKED**, historical default-heap OOM | Stage report preserves exit 134, GC trace, source/copy identity and fixture limitations |
| Packed dense O(Nd) access, 256 dimensions | Current Float64 preserves supplied precision; small access costs measured separately. Historical Float32 curves are not current allocation evidence | `--factory-only` defaults to 100; explicit `--sizes` up to 10k; no ANN/ranking/envelope target |
| Complete in-memory byte bound | **BLOCKED**: serialized tuple/typed-array counts exclude object, Map/Set, key, cursor, preparation and catalog/cache retention | Inspector labels accounting scope and unmeasured heap overhead; scope-count eviction is not byte admission |
| Canonical candidate discovery and selected physical guards | Existing A1 behavior retained | Network registry parity, A0 final-proof and affected currentness regressions |
| Full-model recall quality and final latency envelope | **Not certified** | Synthetic provider/metadata/vector fixtures only; later C2/D2 gates |

Run runtime fixtures and builders only in fresh ordinary PROGRAM copies, source `/workspace/librarian-cloud/env.sh`, and run sequentially. Default, `--factory-only`, and `--skip-scaled` all use n=100; `--runtime-only` runs the baseline and explicit actual hook sizes. `--sizes=100,1000` selects diagnostic sizes (1–10k); 100k/unknown options are rejected before fixture startup. Stage logs include heapUsed/RSS/external/arrayBuffers. Heap >=1GiB or RSS >=2GiB stops the experiment; SIGINT/SIGTERM requests diagnostic cancellation. Timer checks operate at event-loop boundaries, so large synchronous work cannot be preempted by this guard. These thresholds and small sizes are experiment controls, not product caps or a memory-safety certificate. Do not increase heap or replace failed actual runtime measurements with factory costs to claim PASS.


## Current source bounded qualification (2026-10-13)

Code/test snapshot: `/workspace/libra-a2-resume/final2-PROGRAM`, based on `e4a738c84d3e0695cbad641ca057afcd01c58d93` plus uncommitted A2. SHA256 map: `/workspace/libra-a2-resume/source-hashes.json`. Raw logs and per-request CPU/I/O/proof/currentness/selected IDs: `/workspace/libra-a2-resume/logs/final2/measurements.json`.

| Actual registered hook catalog rows | Cold ms | Three warm samples ms | Descriptive p95 ms | Full signature refs / request | Index fallback comparisons / request | Selected physical proof reads / request |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | 655.406 | 559.880, 540.854, 569.260 | 569.260 | 200 | 100 | 1 |
| 1000 | 1809.237 | 1486.152, 1487.987, 1404.619 | 1487.987 | 2000 | 1000 | 1 |

Both use a fixed synthetic catalog over the same 100-row source transcript, with **4600 repeated raw identity row observations per warm request**, not a 4600-row corpus. Every warm request delivers `a2_0` revision1 with a selected physical proof read; catalog/posting metadata reconstruction and document embedding calls remain zero. Full-ref signatures and raw currentness costs remain nonzero and BLOCKED for warm-zero performance.

Maximum **reported stage observations** across seed/setup/cold/warm/cleanup: default100 heap230975736 B/RSS447205376 B; runtime1000 heap234854360 B/RSS453382144 B. These are sampled stage values, not exact peaks, post-GC retention or a memory-safety proof. External/arrayBuffers are included in the raw logs.

Current Float64 factory100/1000 scans every vector at 256 dimensions: allocated packed bytes524288/2097152, serialized metadata9270/95670 B, dot terms25600/256000, descriptive seven-sample p95 1.168/2.122 ms. Historical Float32 10k/100k curves do not establish current Float64 allocations or actual hook costs. Current 10k is unmeasured; actual100k remains BLOCKED after the historical OOM. No large rerun or heap increase occurred.

Eight factory safety contracts and the runtime boundary/busy tests passed after meaningful RED reproductions. Initial regression11/15 and round2 8/9 failures were preserved and diagnosed; final scoped corrections pass InputWriter and actual registry parity, while normal-hook races retain exact binding rejection. Earlier passing unaffected suites are retained as their recorded source-snapshot evidence, not relabeled a new whole-suite final-source run. Independent review and local A2 commit remain the next gate.

Diagnostic controls additionally reject100k before startup, stop at injected heap/RSS threshold values, and honor real SIGTERM with nonzero cancellation. Injected usage tests validate stop branches; they do not allocate 1GiB/2GiB or certify memory bounds. `controls.json` preserves those distinctions.
