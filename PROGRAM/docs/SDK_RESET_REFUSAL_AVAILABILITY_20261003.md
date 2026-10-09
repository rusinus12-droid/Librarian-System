# SDK reset refusal availability unit

Goal: keep an actual restore/reset epoch refusal distinct from an unavailable server, preserving the existing old-client fence and explicit reset choice.

Base: `d18de13202890005531384bf32eb0302a1774263`. Files: both canonical `sdk/MemorySuiteStorageClient*.source.js`, `tests/sdk_reset_refusal_availability_runtime_test.cjs`, this note. Product embeddings remain unchanged for root's later exact synchronization unit.

Cause: actual restore advances HAYAKU epoch; cached old SDK requests receive HTTP 409 `MEMORY_SUITE_RESET_RECONNECT_REQUIRED`. `retryableSyncError`'s substring `econn` matches `reconnect`. `request` therefore normalizes the refusal as unavailable, populates the URL-wide shared failure map, and clears the affected bootstrap. A second owner read and fresh healthy peer/manager bootstraps fail locally with cached `memory_suite_server_unavailable`.

- [x] Reproduce the actual same-runtime HTTP/SQLite restore with both template variants, record raw 409 and subsequent cached errors, and retain actual transport-outage controls.
- [x] In `retryableSyncError`, return false only for status 409 and exact payload error `MEMORY_SUITE_RESET_RECONNECT_REQUIRED`. Preserve the thrown response, binding/epoch/reset choice, and transport circuit behavior.
- [x] Replay final unchanged assertions on exact BASE, then run related SDK binding/lifecycle, physical identity, durable pin and reset suites under the network guard.
- [x] Check exact source diffs/syntax, record hashes and commit independently.

Positive readback: a second stale owner read still receives real 409 without implicit refresh; an unselected LIBRA peer at the same URL reads exact stored bytes, a fresh RETRACE manager reads status, and a direct HTTP write with the original token/DATA identity/reset epoch is refused. Fresh SQLite reads prove exact restored raw/vector fields; the persisted reset map remains unchanged. Stopping the actual server still activates the shared offline circuit and suppresses repeated dispatch.

Fixture corrections are retained as history: an initial probe named a nonexistent public `serverSet` method, then a local-mode proxy write did not reach the server. The final stale-write control uses actual HTTP with the preserved old binding/epoch. No claim is made that those prototypes proved SDK write dispatch. Production delta stays one narrow classifier line per template.

Native RETRACE GUI evidence is owned separately and lives at `C:/Users/rusin/AppData/Local/Temp/LIB-RETRACE-RestoreNext-Evidence-20261003/shared-poison-http.jsonl` and `shared-poison-causal.jsonl`. That owner identified a separate `MEMORY_SUITE_CONNECTION_STALE` normalization/cache concern; this unit does not change it. Whole global authority, embedded-product synchronization, native Risu, full suite/build/release and actual models remain open/unrun.

Final unchanged BASE replay: 2 PASS / 2 FAIL, exit 1. Both actual restore cases prove the cached unavailable error replaces the repeated real 409 and blocks new healthy peers/manager bootstrap. Both actual stopped-server controls pass. Final implementation owning test: 4 PASS / 0 FAIL, exit 0, with HTTP/outcome JSON for every variant/scenario.

Nine-file regression: 74 PASS / 1 FAIL of 75, exit 1. The sole failure is `reset_owner_reconnect_test.cjs`, at the unchanged embedded Flashback `acceptServerReset` bootstrap with `MEMORY_SUITE_CONNECTION_STALE`. Exact canonical BASE replay and candidate replay both reproduce 0 PASS / 1 FAIL with the same stack. The file consumes unchanged product-embedded SDK bytes, not these changed canonical templates. No failure was removed, weakened or repaired in another owner's product. Source/test syntax and diff checks pass; guard events are zero.

Guarded command from `PROGRAM`, with shared `NODE_PATH` and required no-model `NODE_OPTIONS`:

```text
C:/Program Files/nodejs/node.exe --test --test-concurrency=1 --test-reporter=tap --test-timeout=60000 tests/sdk_reset_refusal_availability_runtime_test.cjs tests/sdk_data_instance_binding_runtime_test.cjs tests/sdk_lifecycle_hardening_test.cjs tests/sdk_integration_test.cjs tests/server_data_instance_identity_runtime_test.cjs tests/memory_suite_durable_job_data_pin_runtime_test.cjs tests/namespace_reset_runtime_test.cjs tests/namespace_reset_recovery_test.cjs tests/reset_owner_reconnect_test.cjs
```

Evidence: private clone `PROGRAM/evidence-server-authority/sdk-reset-final-BASE-RED.log`, `sdk-reset-final-GREEN.log`, `sdk-reset-scoped-regression.log`, `sdk-reset-owner-reconnect-BASE.log`, `sdk-reset-owner-reconnect-GREEN.log`, variant/scenario HTTP/outcome directories and `sdk-reset-proof-index.json`. Root owns review, product embedding synchronization and promotion; the inherited embedded reset failure remains an explicit blocker for complete product acceptance.
