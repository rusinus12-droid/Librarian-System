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
