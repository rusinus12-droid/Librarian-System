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

## Remaining steps

2. **Server.** For one release, `/v1/compute/*` keeps answering so that older plugins fall back cleanly. Then remove the worker pool, the registry, and the operations.
   - `sdk/MemorySuiteSearchKernel.source.cjs` is still used by the server registry.
   - `sdk/MemorySuiteComputeClient.source.js` and `sdk/MemorySuiteSearchClient.source.cjs` are now used only by SDK/server tests and the distribution list.
3. **Tests and Storage SDK.**
   - Retire the SDK-only and server-only Compute tests (`compute_bridge*`, `compute_sdk_robustness`, `compute_background_job*`, `docker_compute_*`, ...).
   - Drop the `computeMode` execution policy and the "연산" (computation) label from the Storage SDK panels: the panel titles still read "저장 및 연산" ("storage and computation").
