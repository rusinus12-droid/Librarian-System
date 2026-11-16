# Final Injection Recall Scaling Profile (2026-11-16)

## Scope
Warm `beforeRequest` recall-path CPU profiling and scaling optimization across **HAYAKU**, **Flashback**, and **LIBRA** on `feat/gradia-world-dynamics-aide`.

## Summary of Bottlenecks & Fixes

### 1. HAYAKU (`c227e3d4`)
- **Bottleneck**: Quadratic per-request loops in `hayakuCanonicalTopologySnapshot` (re-filtering all ledger records per pair) and `bindStorageLedgerToSnapshot` (scanning all worldline nodes per record).
- **Fix**: Replaced both quadratic loops with one-pass turn/hash index maps.

### 2. Flashback (`aec51107`)
- **Bottleneck**: CPU profiling at `n = 800` turns showed >75% of warm `beforeRequest` CPU spent re-normalizing, re-sanitizing, and re-hashing unchanged historical messages/records on every request (`resolveScopeFromSnapshot`, `stableHash`, `flashbackPairIdentity`, `conversationStateWithIndexes`, `sanitizeAssistantForMemory`, `visibleRecallFieldsForRecord`).
- **Fix**:
  - `stableHash`: Added a bounded LRU cache (`8192` entries) for strings `<= 4096` chars; oversized one-off strings bypass the cache so they cannot evict message/pair entries.
  - `normalizeMessagesForFingerprint`: Added a bounded per-message normalization cache (`8192` entries, `<= 16384` chars) keyed by `(role, tagKey, rawContent)`.
  - `resolveScopeFromSnapshot`: Memoized `{ chatFingerprint, chatTailHash }` per chat by exact `(role, rawContent)` sequence comparison.
  - `liveChatStateFromNormalized` / `conversationStateWithIndexes` / `flashbackPairIdentity`: Skipped redundant re-indexing of already-indexed `WeakSet` states and memoized `flashbackPairIdentity` per `pair` object in a `WeakMap`.
  - `sanitizeAssistantForMemory` & `visibleRecallFieldsForRecord`: Memoized regex sanitization (`4096` entries, `<= 8192` chars) and per-record BM25F/recall field extraction (`WeakMap`).
- **Measured Warm `beforeRequest` (Node fixture, hash-8)**:
  - `n = 100`: `17.8 ms` -> `11.4 ms` (-36%)
  - `n = 400`: `51.6 ms` -> `25.8 ms` (-50%)
  - `n = 800`: `93.0 ms` -> `45.7 ms` (-51%)

### 3. LIBRA
- **Bottleneck**: CPU profiling at `n = 400` turns showed:
  - `rememberVerifiedRead` + `pruneVerifiedReads` (`19.6%` CPU): scanning the entire `verifiedReadCache` on every cache write.
  - `pairRevisionProjectionWithCache` + `buildPairs` (`46.3%` CPU): performing full `Map` delete+insert, `Date.now()`, `finalizePairRevisionObservation`, `retainPairRevisionObservation`, and `sequence` string allocation on every `buildPairs` call even when all rows were cache hits.
- **Fix**:
  - `pruneVerifiedReads`: Throttled full-map expiry sweeps to at most once per `250 ms` unless the cache is at capacity.
  - `pairRevisionProjectionWithCache` & `buildPairs`: Precomputed `sequenceItem` on cache entries and skipped `delete+set`, `finalizePairRevisionObservation`, and `retainPairRevisionObservation` when all rows in `buildPairs` hit `cache.entries` with unchanged size.
- **Measured Warm `beforeRequest` (Node fixture, `plugin_only`)**:
  - `n = 50`: `12.7 ms` -> `11.2 ms`
  - `n = 200`: `41.2 ms` -> `28.8 ms` (-30%)
  - `n = 400`: `83.5 ms` -> `53.2 ms` (-36%)
