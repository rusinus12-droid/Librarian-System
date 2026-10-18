# Storage SDK audit (2026-10-17)

## Sync status

`tools/check_sdk_sync.cjs`: every check is OK.

| Plugin | Storage SDK | Variant |
|---|---|---|
| Flashback | 1.8.26 | core3-standard (`sdk/MemorySuiteStorageClient.source.js`) |
| HAYAKU | 1.8.26 | core3-standard (same file) |
| LIBRA | 1.8.26 | libra-control-plane-preroute (`sdk/MemorySuiteStorageClient.libra.source.js`) |
| LIA | 1.8.24 | preserved-local-only (sha pin) |
| RE:TRACE | 1.8.24 | preserved-manager-only (sha pin) |
| GRADIA | 1.8.24 | preserved-readonly-three-owner (sha pin) |

## Defects found and fixes

Every defect was reproduced with a script against the in-process server before it was fixed.

| ID | Defect | Fix (1.8.26) |
|---|---|---|
| D1 | The server committed a write, then the response was lost at the network level (reset, `fetch failed`, client timeout). The client reported the write as failed and indeterminate. The failed request had opened the shared outage circuit, so the operation lookup was blocked before it reached the server. The server also stayed unreachable from that plugin for about 5 s. | The operation lookup forces a fresh bootstrap, bypassing the circuit, with up to 3 bounded attempts. The write is confirmed. |
| D2 | Another writer committed between this write and its readback. The client reported this writer's committed write as failed. A caller that retried then overwrote the newer value (lost update). | When the stored revision is greater than the receipt revision, the client checks the server's operation record and confirms the write as `superseded`. |
| D3 | Standard mirror mode treats the local copy as authoritative. A read from a stale tab pushes its old value to the server unconditionally. | The push is now conditional on the revision just read, so a write that lands in between is not overwritten. A device whose local copy is genuinely stale can still roll the server back. That follows from the mirror design (local first). LIBRA's mirror is server-first and not affected. |
| D4 | The scope-mode registry was cached indefinitely. After another tab or bridge switched a scope to server_only, this tab kept writing only to pluginStorage (split brain). | The registry is re-read after 2 s. When it has not changed, the route cache is kept. A write made locally during the read takes precedence. |
| D5 | `routeCache` was unbounded: about 1.7 KB per entry and roughly +5 MB per 3000 keys. | Capped at 2048 entries (LRU). |

New test: `tests/storage_sdk_write_confirmation_test.cjs` covers D1, D2 and D4 on both variants. It fails on 1.8.25.

## Guarantee limits (unchanged)

- **plugin_only is not atomic.** Read-modify-write between tabs or devices is last-writer-wins. In a test with 4 concurrent increments, the final value was 1.
  - Server-side CAS paths exist only in server_only/mirror: LIBRA's conditional batch and Flashback's writer fence.
- **Multi-page reads are not a snapshot.** `get-many` and `keys` pages can each see a different commit.
- **Write verification re-reads the whole value.** A 1 MB set uploads 1 MB and downloads 1 MB. Verifying by digest would halve the traffic (not yet implemented).

## Verified as passing

- DATA replacement and ABA defense.
- Server conditional atomic batches: idempotent per operationId, with expectedRevision checked inside the transaction.
- Fence and lease release on dispose, timers and abort controllers.
- Secret keys are excluded locally, by key name.

## Test results

Storage-related set: 116 tests, 110 passing before the change. After the change the same set has the same failures as before, and the version-check failures were resolved by updating the manifest.

The remaining failures pre-date this change:
- 4 are GUI or fixture DOM drift: `lia_local_routes`, `libra_gui_memory_settings_storage_modes`, `storage_global_owner_public_gui`, `sdk_reset_bootstrap_sequence` #10.
- `storage-compute-mode-contract-v2` cannot find a source-text needle.
- `libra_phase_d_v5_mirror_local_failure_recovery`: LIBRA's in-memory head after a restart.
