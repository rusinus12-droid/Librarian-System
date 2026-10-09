# HAYAKU 3.0.113 mirror search binding patch

The request path caches a storage-backed snapshot, while the former search validator called authoritativeLedgerFromSnapshot with the raw chat snapshot. This could reconcile and replace the cache during validation, increasing revision 1 to 2 without a chat edit and raising HAYAKU_SEARCH_BINDING_STALE.

The validator now compares the existing request worldline without reconciling or replacing it. Both lexical search and RRF compute capture a digest of the persisted ledger through a direct read, avoiding loadStorageLedger's adoption side effects. Raw chat/scope identity, worldline contents/revision/head and persisted ledger changes still invalidate results. Existing corpus validation and server-failure fallback remain in place. This adds ledger reads/serialization at the validation boundary; live-device latency was not measured.

## Re-audit

- New hayaku_search_binding_readonly_test.cjs: actual localhost backend, real mirror policy, production beforeRequest and search functions; host and packet fixtures; cache accessor/storage setter instrumentation only for fault injection.
- beforeRequest reaches compute/execute and returns augmented messages; no external model calls.
- Storage-backed fixture: revision remains 1 -> 1, repeated validation preserves cache, search succeeds.
- Chat edit, persisted ledger write, and worldline revision change during search each reject with HAYAKU_SEARCH_BINDING_STALE.
- Network failure without state change falls back successfully.
- search_compute_owner_paths_runtime_test: 6 checks PASS across HAYAKU, LIBRA and Flashback.
- hayaku_sparse_rrf_product_server_integration_test: PASS.
- source_tracking_hayaku_request_patch_test and source_tracking_hayaku_guard_patch_test: PASS; source-edit approval protections retained.

No live RisuAI/user server or real provider generation was exercised. User data was not changed. This patch does not claim to resolve every possible packet-generation failure. Release ZIP not rebuilt.
