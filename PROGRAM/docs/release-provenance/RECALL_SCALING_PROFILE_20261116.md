# Final Injection Recall Scaling Profile (2026-11-16)

## Scope
Warm `beforeRequest` recall-path CPU profiling and scaling optimization across **HAYAKU**, **Flashback**, and **LIBRA** on `feat/gradia-world-dynamics-aide`.

## Summary of Bottlenecks & Fixes

### 1. HAYAKU (`c227e3d4` + Recall/Normalization Follow-up)
- **Bottleneck (`c227e3d4`)**: Quadratic per-request loops in `hayakuCanonicalTopologySnapshot` (re-filtering all ledger records per pair) and `bindStorageLedgerToSnapshot` (scanning all worldline nodes per record).
- **Bottleneck (Follow-up profile at `n = 400`)**: `compact()` regex/trim on every short ASCII field (`17.3%` inclusive CPU), `localRecallRank` probing `(visited x terms)` and re-deriving `localRecallSourceKey` inside sort comparators (`16.4%`), `localRecallExpand` calling `allRows.indexOf(seed)` (`5.7%`), and repeated `localRecallPostingSourceId` `JSON.stringify`+hash passes.
- **Fix**:
  - `c227e3d4`: Replaced both quadratic loops with one-pass turn/hash index maps.
  - Follow-up: Added whitespace-free ASCII fast-path in `compact`, `WeakMap` memoization for `localRecallSourceKey`, direct postings-list score accumulation and precomputed `docNorms` in `localRecallRank`, `Map` index lookup in `localRecallExpand`, and proof-object memoization in `localRecallPostingSourceId`.
- **Measured Warm `beforeRequest` (Node fixture)**:
  - `n = 25`: `91.6 ms` -> `73.9 ms` (-19%)
  - `n = 100`: `208.7 ms` -> `152.8 ms` (-27%)
  - `n = 400`: `1,039.6 ms` -> `462.5 ms` (-56%)

### 2. Flashback (`aec51107` + BM25F Follow-up)
- **Bottleneck**: CPU profiling at `n = 800` turns showed >75% of warm `beforeRequest` CPU spent re-normalizing, re-sanitizing, and re-hashing unchanged historical messages/records on every request (`resolveScopeFromSnapshot`, `stableHash`, `flashbackPairIdentity`, `conversationStateWithIndexes`, `sanitizeAssistantForMemory`, `visibleRecallFieldsForRecord`). In BM25F scoring, `sparseProjectionForRecord` also re-hashed record revisions on every call, `bm25fCorpusCache` missed on freshly filtered arrays, and `scoreBm25fCandidates` recomputed `idf`, `families`, `norm`, and `maxRaw` inside the inner document loop.
- **Fix**:
  - `stableHash`: Added a bounded LRU cache (`8192` entries) for strings `<= 4096` chars; oversized one-off strings bypass the cache so they cannot evict message/pair entries.
  - `normalizeMessagesForFingerprint`: Added a bounded per-message normalization cache (`8192` entries, `<= 16384` chars) keyed by `(role, tagKey, rawContent)`.
  - `resolveScopeFromSnapshot`: Memoized `{ chatFingerprint, chatTailHash }` per chat by exact `(role, rawContent)` sequence comparison.
  - `liveChatStateFromNormalized` / `conversationStateWithIndexes` / `flashbackPairIdentity`: Skipped redundant re-indexing of already-indexed `WeakSet` states and memoized `flashbackPairIdentity` per `pair` object in a `WeakMap`.
  - `sanitizeAssistantForMemory` & `visibleRecallFieldsForRecord`: Memoized regex sanitization (`4096` entries, `<= 8192` chars) and per-record BM25F/recall field extraction (`WeakMap`).
  - `sparseProjectionForRecord` & `bm25fCorpusFor` / `scoreBm25fCandidates`: Added `WeakMap` object-identity memoization for unchanged records, a 4-entry filtered-array fallback in `bm25fCorpusFor` with precomputed `fieldWeightNorms`, and hoisted query-side IDF/`maxRaw` calculations out of the per-document loop.
- **Measured Warm `beforeRequest` (Node fixture, hash-8)**:
  - `n = 100`: `17.8 ms` -> `11.4 ms` (`13.1 ms` post-BM25F refactor)
  - `n = 400`: `51.6 ms` -> `25.8 ms` (`29.4 ms` post-BM25F refactor)
  - `n = 800`: `93.0 ms` -> `45.7 ms` (`50.1 ms` post-BM25F refactor)
- **Measured `_probe_flashback_recall_scaling.cjs` (`N = 1600`)**:
  - `totalMs`: `346.6 ms` -> `310.6 ms` (`scoreMs`: `43.1 ms` -> `37.7 ms`)

### 3. LIBRA (`2002d98b` + Lore BM25F & `buildPairs` Follow-up)
- **Bottleneck**:
  - `rememberVerifiedRead` + `pruneVerifiedReads` (`19.6%` CPU): scanning the entire `verifiedReadCache` on every cache write.
  - `pairRevisionProjectionWithCache` + `buildPairs` (`46.3%` CPU): performing full `Map` delete+insert, `Date.now()`, `finalizePairRevisionObservation`, `retainPairRevisionObservation`, and `sequence` string allocation on every `buildPairs` call even when all rows were cache hits, plus re-extracting message metadata across repeated in-request `buildPairs` passes.
  - `responseLoreCorpusBm25f` & `responseLoreExactScore`: scanning all records 3 times for averages and `O(Q x N x 3)` for DF on every stage call, and re-normalizing query/record keys per record.
- **Fix**:
  - `pruneVerifiedReads`: Throttled full-map expiry sweeps to at most once per `250 ms` unless the cache is at capacity.
  - `pairRevisionProjectionWithCache` & `buildPairs`: Precomputed `sequenceItem` on cache entries, skipped `delete+set` and full-map observation/retention sweeps when all rows hit unchanged, and added a reference/primitive-field fast-path in `pairRevisionProjectionWithCache` indexed via `cache.byIndex`.
  - `responseLoreCorpusBm25f` & `responseLoreExactScore`: Added `loreBm25fCorpusFor` (caching averages, length norms, and token postings per corpus) so scoring only visits matching postings, and memoized normalized exact-score query strings and record lore key lists.
- **Measured Warm `beforeRequest` (Node fixture, `plugin_only`)**:
  - `n = 50`: `12.7 ms` -> `11.2 ms` -> `10.4 ms` (-18%)
  - `n = 200`: `41.2 ms` -> `28.8 ms` -> `23.7 ms` (-42%)
  - `n = 400`: `83.5 ms` -> `53.2 ms` -> `39.0 ms` (-53%)
- **Measured Lore BM25F / Rank Probe (dense 100%-hit synthetic corpus)**:
  - `N = 1600`: `bm25`: `20.1 ms` -> `16.5 ms`; `rank`: `210.4 ms` -> `207.1 ms`
  - `N = 3200`: `bm25`: `39.6 ms` -> `41.1 ms`; `rank`: `368.2 ms` -> `360.4 ms` (cold corpus build; subsequent sparse queries and repeated stage calls reuse `loreBm25fCorpusFor` postings/norms)

---

### 4. Structural Audit, Precision Fixes & Second Optimization Pass (`HAYAKU`, `Flashback`, `LIBRA`)
- **Architectural Audit Findings**:
  - **HAYAKU BM25 vs BM25F & Global Index Clobbering**: Live `localRecallRank` runs single-body BM25 + IDF information scaling (`hayaku.evidence-lexical.v1`), while ~1,500 lines of 8-field BM25F (`SPARSE_HYBRID_TUNING.bm25fFieldWeights`, `sparseFieldValuesForRow`, `buildSparseBm25fCorpus`, `sparseBm25fScore`, `applyUnifiedContextualBm25f`, `applyRrfFusion`) and `compositeRecallLaneFor` / `partitionCompositeRecallIndex` / `mergeCompositeRecallLanes` remain uncalled by `localRecallCandidates` / `searchIndexCompositeRecall`. Parallel `beforeRequest` calls to `searchRecoveryVaultRawPassages` and `searchAcceptedPartialMemory` with empty arrays previously invoked `localRecallRank([], ...)` and overwrote the single global `localRecallRankIndex` every turn.
  - **HAYAKU Temporal Lane Policy**: Active `hayakuTemporalQuotaState` reads `hayakuTemporalPolicy`, whose 5 settings (`hayaku_recall_short_max_age`, `hayaku_recall_medium_max_age`, `hayaku_recall_short_turn_quota`, `hayaku_recall_medium_turn_quota`, `hayaku_recall_long_turn_quota`) default to `''`, leaving `policy.status === 'unset'` unless manually configured (`compositeRecallLaneFor`'s `COMPOSITE_RECALL_HORIZONS` defaults are on an unconnected code path).
  - **Flashback Non-LLM Entity/Item/Location Extraction & `factIdentity` Precision Bug**: Natural-language extractors (`visibleContinuityFactsFromText`, `collectLiveStructuredStateFacts`, `buildCurrentUserStateOverlay`) are intentionally stubbed to empty arrays so unverified LLM-free heuristics cannot promote unconfirmed state. Only explicit `record.metadata.statusDataParsed` or `record.structuredStateFacts` populate state/latent cues. In `visibleRecallFieldsForRecord`, `factIdentity` (`fact.entity`, `fact.peer`) was computed and omitted from `fields.identity`, dropping structured state entities from the `3.4`-weight `identity` BM25F field.
- **Fixes Applied**:
  - **HAYAKU**: Preserved `localRecallRankIndex` on empty input, added a 4-entry `recentLocalRecallRankIndices` LRU cache + `priorIndex` length match, added empty-input early returns in `searchRecoveryVaultRawPassages` and `searchAcceptedPartialMemory`, memoized `bindPacketRecordReferences` via `boundPacketRecordRowCache`, excluded per-tier budget fields (`injectionCapChars`, `recallDataBudgetChars`, `allowTailOnly`) and keyed `signatureOwner` in `prepareHayakuEvidenceUnits`, and optimized `selectHayakuEvidencePlan` (incremental `maxSimToChosen`, hoisted `chosenOccupancy`, per-iteration tie-metric memoization, skip re-sort on unchanged discards).
  - **Flashback**: Wired `factIdentity` into `fields.identity`, skipped empty fields in `sparseProjectionForRecord` and `scoreBm25fCandidates`, filtered before sorting in `buildLatestStateByEntity`, indexed vector sidecars via `itemByRecordId` without duplicating float arrays, cached `checksumValid` in `readFlashbackPureProjection` (`decode-shard-v2`), skipped cloning on read-only C0 `verifyVectorPayloadMetadataOnly && expectedSerializedRaw` verification while using 1-level shallow record clones on mutable recall reads, and optimized `selectFlashbackEvidencePlan` (per-`(unit, variantIndex)` fragment evidence cache, hoisted `delivered` set, incremental `maxSimForUnit`, `canAddGroup` gate before `fit()`, skip redundant rebuild/re-sort on unchanged discards).
  - **LIBRA (and `PROGRAM/tools/libra_state_memory_engine.cjs`)**: Precomputed `gramKeys` and `gramKeySet` in `loreTokenFeatureOf` (preserving `loreJaccardCharNgrams` counts), cached `LoreIdentityFeatureCache` in `loreIdentityFeaturesOf`, added `exactSignalFromNormalized` + `scorePrecomputed` shared by `rankCatalog` and `select`, and reused `source?.pairs` in `createLibraStateMemoryCapture.micro`.
- **Verified Before -> After Benchmarks (`HEAD` `66ce6048` vs working tree, same host)**:
  - **HAYAKU (`n = 200` turns, `1,868` indexed rows, warm `beforeRequest` median of 5)**:
    - Total latency: `328.12 ms` -> `267.89 ms` (-18.4%)
    - `lastLocalRecallRank.verificationRows`: `0` (clobbered) -> `1868`; `invocation`: `24` -> `12` (`compiledIndexHit: true`, `documentTokenizations: 0`)
  - **Flashback (seeded v2 shards + 8-dim vector sidecars, warm `beforeRequest` median of 5)**:
    - `n = 200`: `685.76 ms` -> `221.69 ms` (-67.7%)
    - `n = 400`: `902.10 ms` -> `316.70 ms` (-64.9%)
    - `factIdentityInFieldTf`: `false` -> `true`
  - **LIBRA**:
    - `debugUnifiedLoreMaterial` (`N = 1600`, median of 3): `640.40 ms` -> `275.03 ms` (-57.1%)
    - `debugUnifiedLoreMaterial` (`N = 3200`, median of 3): `1,161.90 ms` -> `431.49 ms` (-62.9%)
    - `createLibraStateMemoryEngine` (`N = 800`, median of 5, exact equivalence verified): `select` `19.67 ms` -> `11.60 ms` (-41.0%), `rankCatalog` `23.33 ms` -> `12.70 ms` (-45.6%)
    - `createLibraStateMemoryEngine` (`N = 1600`, median of 5, exact equivalence verified): `select` `38.14 ms` -> `21.53 ms` (-43.5%), `rankCatalog` `43.08 ms` -> `25.33 ms` (-41.2%)

