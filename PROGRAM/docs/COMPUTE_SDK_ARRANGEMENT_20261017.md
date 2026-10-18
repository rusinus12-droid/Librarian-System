# Compute SDK arrangement: where it helps plugin computation (2026-10-17)

Goal: arrange the Compute SDK so it actually speeds up the plugins' computation. The first step was to measure where server compute pays off and where it does not.

## 1. Current state (Compute SDK 0.3.8)

- **Modes.** The SDK has two modes, `local` and `prefer_server`. The storage mode sets the mode: `computeMode = serverBacked ? 'prefer_server' : 'local'`. In plugin_only mode, computation is always local.
- **Server location.** The server URL must be loopback. **The compute server always shares the same device's CPU.**
- **Production call sites:**
  - Flashback: recall cosine. The `memory-search` vectors path goes through `SearchClient.vectors`.
  - HAYAKU: composite-recall lexical ranking via `memory-search` lexical.
  - LIA: world-lore rerank. LIA's storage is local-only, so this always runs locally.
- **Unused or retired:**
  - LIBRA's unified engine retired its bridge.
  - The HAYAKU sparse-RRF bridge is reachable only from the debug API.
  - `hash-embedding-batch`, `sha256-batch` and `vector-rank` have no production callers.
  - The job API (`prime`, `executeCachedOrLocal`, `submitJob`) has no plugin callers.

## 2. Measurements

Measured on 4 vCPU and Node 22. Expect about 20% noise.

| Computation | 300 | 1000 | 3000 |
|---|---|---|---|
| Flashback cosine, d=1536, 3 queries, local kernel | 8 ms | 10 ms | 22 ms |
| The same through SDK `prefer_server` | 2259 ms | 2770 ms | 2824 ms (hits the 2.5 s cap; the rest falls back to local) |
| HAYAKU lexical recall, warm local index | 3.4 ms | 5.2 ms | 14 ms |
| HAYAKU memory-search lexical, server end-to-end | 118 ms | 198–239 ms | 483–575 ms |
| SDK canonical JSON + SHA-256 + freeze (input 87 / 289 / 874 KB) | 17 ms | 21 ms | 104 ms |

The SDK pays for digests and canonical JSON on the main thread. The loopback server also uses the same CPU. Server compute only pays off when the computation costs well over about 0.3 ms per KB of input, and none of the kernels in use reach that. Server routing was a net loss: up to 2.8 s per request for Flashback and up to 0.5 s for HAYAKU.

## 3. Changes

### 3.1 Search offload decided by measured cost (SearchClient)

`createMemorySuiteSearchClient` now takes an `offload` policy. The default is `{vectors: false, lexical: false}`, based on the measurements above. `client.offloads(kind)` tells call sites whether to use the server.

- **Flashback:** in `prefer_server`, the call site checks `offloads('vectors')` first. When it is off, it also skips building the search basis, which costs 3 storage reads plus hashing the chat JSON twice. Cosine runs locally.
- **HAYAKU:** when it is off, HAYAKU builds no corpus or binding and uses the warm local recall index.
- **Turning it back on.** An owner can pass `offload: {vectors: true, lexical: true}` to use the server path again. The tests do this to keep checking the server path (`search_compute_owner_paths`, `search_compute_expansion`, `hayaku_alias_search_parity`).

### 3.2 Local computation speedups (Flashback recall)

The profile showed the time going into repeated work rather than into kernels that could be offloaded.

| Change | Effect |
|---|---|
| Per-corpus BM25F cache: field averages and token postings are reused for the same record array, validated by the identity of each projection. Only documents that contain a query token are scored. | Per pass at 3000 records: 181 → 147 ms |
| Record text hash kept per record while its text is unchanged. Previously every projection-cache lookup re-hashed the full text with FNV. | 147 → 105 ms |
| The query side of embedding compatibility is computed once per synchronous pass. The memo is dropped at the next microtask. Previously each record re-hashed several profile descriptors. | — |
| Vector validity checked without allocation. Previously `vector()` copied every vector. | — |

`generateRecallCandidateArms` end to end in `prefer_server`, median of 3, 1024 dimensions:

| Records | Before | After |
|---|---|---|
| 300 | 3153 ms | 675 ms |
| 1000 | 6656 ms | 1924 ms |
| 3000 | 15736 ms | 5925 ms |

The VM test harness inflates absolute times, so compare the ratios. The candidate output is unchanged: the result digest of `generateRecallCandidateArms` is identical before and after, and the BM25F ranking digest is identical too.

## 4. Where the SDK can help next (not implemented)

- **A `local_worker` executor.** A pure, self-contained kernel would run in a Blob Worker, off the main thread, with an inline fallback when the CSP blocks workers. This is the only form that helps in every mode, plugin_only included.
  - **Best candidate:** LIBRA's background 5-turn analysis. Its response-lore ranking (BM25F ×4 + RRF) takes about 0.75 s per rank at 3000 entries and repeats (1 + consumers) × 4 times per batch.
  - **Prerequisite:** extracting it into a self-contained kernel. It currently depends on many LIBRA tokenizer helpers.
- **A server-side prepared-corpus handle.** It would cache the compiled index, not just the corpus JSON. This is needed before any remote lexical offload could win, because the server re-tokenizes on every call.
- **Not worth offloading:** LIA lore rerank (≤40 entries, ≤6 ms), HAYAKU sparse RRF (≤256 rows), GRADIA packing, vector cosine. Transfer and digest costs exceed the computation.
