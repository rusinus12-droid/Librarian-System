# Compute SDK retirement, step 1: plugins (2026-10-18)

Decision: retire the Compute SDK from the plugins. See `COMPUTE_SDK_ARRANGEMENT_20261017.md` for the measurements. The loopback server shares the device's CPU, and digests and transfers run on the main thread. Every production path was slower through the server than locally, so no plugin computation benefited from it.

## Step 1 (this change): plugins

| Plugin | Before | After |
|---|---|---|
| LIBRA 2.3.167 | The unified engine had already retired its bridge; the SDK and search client were still embedded, unused | Removed. `getMemorySuiteComputeStatus()` stays `retired`. |
| Flashback 1.0.118 | `prefer_server` recall cosine through the search client (off by default since 1.0.116) | Removed. Cosine is always local; the search basis is not read. |
| HAYAKU 3.0.149 | Sparse-RRF bridge (debug only) and composite-recall lexical search via the search client | Removed. `applyRrfFusion` and composite recall run locally; `debugApplyRrfFusionWithCurrentOwner` is kept as a local alias. |
| LIA 0.26.87 | World-lore rerank through the bridge, always local (LIA storage is local only) | The same kernel is called directly, with the same canonical-JSON copy (sorted keys, plain data) and validation as before, and the same `rerankLoreEntries` fallback. |

- About 7,100 lines were removed from the four plugins.
- `tools/check_sdk_sync.cjs` now reports `compute=NOT_EMBEDDED` for all six plugins.
- `tools/sync_search_compute.cjs` now only checks that the search client and SDK are not embedded again.
- The operation ids and fingerprints (`hayaku.sparse-rrf-fusion.v1`, `lia.world-lore-rerank.v2`) stay in the source as historical identity. The manifest marks them `retired: true` and `execution: retired_local_only`, the same treatment LIBRA's `libra.recall-bm25f.v1` already had.
- Results are unchanged. The parity tests confirm this:
  - `search_compute_owner_paths`: server-backed results equal plugin_only results, with 0 Compute calls.
  - `hayaku_alias_search_parity`: identical evidence bytes.
  - The HAYAKU and LIA pilot tests: local kernel results are unchanged, and the server kernels still match exactly.

## Step 2 (server)

- **Removed:** `server/compute/*` (compute plane, worker pool, fair scheduler, workers, contracts), Compute capability tokens and signing, the Compute route handlers, the startup and shutdown hooks, and the `OPTIONAL_COMPUTE_CAPABILITIES`.
- **Every `/v1/compute/*` request** gets one answer, sent before authentication and during maintenance too:
  - `410 {ok:false, error:'compute_retired', code:'COMPUTE_RETIRED', schema:'memory-suite.compute.retired.v1'}`.
  - GRADIA still gets its read-only 403 first.
- **`/health`** reports `compute: {retired:true, enabled:false, configured:false, ready:false}`.
- **Older plugins (Compute SDK 0.3.8):** each plugin bridge opens its circuit after two 410s and computes locally. `compute_retired_server_fallback_test` runs 75 executes across 3 plugins: all are answered locally, with 6 bootstrap requests and no execute.
  - The SDK keeps a closed circuit for error codes such as `MEMORY_SUITE_COMPUTE_UNSUPPORTED`, which would cause a retry storm, so the server never sends those codes.
- **Accepted and ignored for compatibility:**
  - `computeEnabled` / `computeWorkers` in existing DATA configs, with any value.
  - The `--no-compute` / `--compute-workers` flags.
  - Existing `compute-signing-key.txt` files: left in place, no longer created.
  - `launcher_compute_config_contract_test` covers six legacy config shapes.
- **Kept, because installed updaters check them in a new release:**
  - The six-key DATA template (`computeEnabled:true`, `computeWorkers:0`).
  - `sdk/MemorySuiteComputeClient.source.js` with its version header.
  - `computeProtocol` / `computeSdk` in the manifest.
  - The migration metadata keys.
- **Manifest:** `dataContract.computePlane` drops the worker, scheduler and signing fields and declares `serverRetired: true`.
- **Tests:**
  - The reference kernels of the retired registry live on as test oracles in `tests/fixtures/retired_compute_reference_kernels.cjs`. The LIBRA tokenizer sync tool now targets this file.
  - 16 tests of the server, pool, scheduler and Compute integrations were removed, with their 3 fixtures.

## Remaining step

3. **Tests and Storage SDK.**
   - Retire the SDK-only Compute tests (`compute_bridge`, `compute_sdk_robustness`, `compute_background_job*`, `compute_late_risu_api_binding`, `docker_compute_*`).
   - Drop the `computeMode` execution policy and the "연산" (computation) label from the Storage SDK panels.
   - The Compute SDK source and the manifest compatibility fields can only go once the oldest supported updater no longer checks them.
