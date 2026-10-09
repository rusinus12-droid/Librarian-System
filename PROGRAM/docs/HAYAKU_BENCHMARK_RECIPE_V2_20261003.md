# HAYAKU runtime fixture recipe v2

The original shared benchmark remains blocked. This separate recipe preserves the original fixture and frozen runner, binds an explicitly selected runtime fixture, and records new evidence without overwriting old attempts. The observed 10-turn comparison supports a bounded model-free content comparison; it does not establish equivalent costs, wall times, native behavior or a completed shared matrix.

## Immutable inputs

| Input | SHA-256 |
|---|---|
| Fixture v1, 13,897 bytes | `190f35784dd687a5a295e5b5d122713e55a97e4b06192754350f6442f596edb6` |
| Fixture v2, 14,831 bytes | `9f52fffea821492e5c9bf6ade87a4a2fc1b6ca6de5d2db174a36f9caffe80ac8` |
| Frozen search runner | `fef4e60bbfd1f32d552fbbfc6974552e090985bd7bd73dbbfdc161c58ce1601a` |
| Original 56dfa4d product | `98f0e2fb4d23db99c389dfb246ebd7369092c83de884ff7af622a8d96f470ccb` |
| Current 15b40a5 product | `db7c1495795c8b8f6a59b4e0be03323a43543b1ca0d7af79a3bfb881b0dece9f` |
| Shared frozen 2,000-turn artifact | `9c9a970c144aae0d1daaba19edb4964276a22ef104c4f6761c6ae642238692d0` |
| Shared transcript JSON | `18a2f18bfc3c6adf37b12bdb27ecde94219e6183475a523aa3a8f0642ed1bd6b` |
| Gold list JSON | `9b9a9c2d00876f288375e31e68a0eacf01fd010e1d81f4ade5f2ee4fb0a80c68` |

Exact fixture and runner bytes are archived under `tests/fixtures/hayaku-benchmark-recipe-v2/`. The default remains v1. Selection of v2 never changes v1's expected hash. The wrapper rejects unknown versions, changed source bytes, nonexact runtime require paths and child process/Git execution. Only the original runner's one exact runtime require is bound to the selected archive. Its `runOne` body and scoring code remain unchanged. Its private directory binding sends all newly generated filesystem stores/results into this clone; product snapshots are read by their separately verified absolute paths.

The historical product is verified against the root worker's freshly materialized original Git blob. The current product is independently verified against this clone's 15b40a5 Git bytes. Their product changes are not attributed to the fixture change.

## Changed preparation condition

Fixture v1's wait rejects an API if the polling loop resumes after its 15,000ms observation deadline. Fixture v2 records assignments to `context.HAYAKU`. A delayed observer can return that same API only when a finite recorded publication time is on or before the original deadline. The deadline is unchanged. Late publication, missing publication, an invalid timestamp and unannotated waits still fail. Deterministic controls cover publication at 14,999ms, 15,000ms and 15,001ms, including the actual fixture setter. These boundary tests use a controlled clock; actual product recipe runs retain a real clock.

## What can be compared

Both selected fixtures generate identical seedless base/foreign transcripts at 10/100/1000/2000 turns, identical edit/reroll/add packets and identical gold. Source tracking, packet recovery and every repair path remain off. Each frozen run preserves fresh cold question runtimes/stores, 17 five-question mandatory panels, three repeated-query panels and the original at-most-eight settle observations per settle phase. Final emitted records, their order, provenance and whole-context marker hits remain separate from candidate presence.

On the original 56dfa product, the initial old/new 10-turn runs have 85/85 identical raw input hashes, quality decisions and final consumed records, text, provenance, order and markers. Each reports 53/70 mandatory positive full-gold hits, 15/15 negative controls and zero forbidden markers. The same 17 positive misses remain visible. There are three additional settle observations per run. Raw returned hashes differ at all 85 requests and filesystem counters differ at 27; these are preserved as differences. Exact final-run pins and follow-up compatibility evidence are stored under `work/hayaku-recipe-v2/`.

A fresh final pair under wrapper SHA `034d915639ece3ebcc3a3965d8e0ba694683f0227a18de93af6b2b8f12d6017f` uses one independent process for each fixture. It repeats the same 85/85 input/quality/final-consumer match and 53/70 + 15/15 results. Its 40/85 IO differences remain visible. The required three independent processes at every scale have not been run. The initial pair used one process sequentially and is retained as earlier diagnostic evidence.

Separate five-question RAM compatibility panels on each immutable product compare v1/v1 and v1/v2. Each of the four comparisons has 5/5 identical consumed records and markers. Full output differs only by actual exposed `request_nonce`/`generation_attempt_id` values in these panels: replacing those exact observed values, without filtering any other byte or field, yields 5/5 identical outputs. The product constructs generation attempt identity from its runtime epoch, sequence, real `now()`, scope and turn owner; this variation also exists without any fixture change. The 15b current-product results are separate from historical 56dfa results and do not establish current full-matrix benchmark quality.

IO counter and timing definitions remain the exact original runner code: physical filesystem reads/bytes, fsync/rename writes/bytes, key enumeration/removal and real hook return wall time. Background tasks can move work between observations. No measured byte/count equality or timing improvement is claimed. Record-scoring, query-tokenization and physical raw comparison work remain `null` where the original producer did not instrument them.

The three untouched historical 2,000-turn baseline files still hash to `7d7b34b99c426703633aeb07cbe6776a4949db56d5605c9fd126aebac0e7e027`, `77befbdd497b454a6b53c7ca6ccb0ec11ef5a8ee9a0b3222f7e27236f0d430c2`, and `f967c1c5b7997fdf2ed5f58d98788278038aab1b5f4bf4e98bd83f4797b29d94`. Their 56/94, 29/94 and 57/94 full-gold results remain 142/282. Each denominator includes 24 extra positive settle observations beyond the 70 mandatory positives; the 15 negative controls are separate. Successful v2 starts cannot relabel earlier v1 timeouts as successful observations.

## Guarded use and outstanding gates

Run in a new private clone. Set the existing `NODE_PATH`, both explicit `--require` and `NODE_OPTIONS` to the authorized recovery guard, and `RECOVERY_NETWORK_LOG` to a new path inside that clone. `tools/hayaku_benchmark_recipe_v2.cjs` exports `loadRecipe({fixtureVersion, outputRoot})`, `productSnapshot(file, product)` and `runFrozen({fixtureVersion, productFile, product, n, repeat, outputRoot, label})`. Product selection is `baseline` or `current`. A run refuses an existing result or store directory. Every new result has a `.recipe-v2.json` sidecar with fixture, runner, wrapper, product and result hashes.

Useful isolated commands are `node --require <guard> tests/hayaku_benchmark_recipe_v2_test.cjs` and `node --require <guard> tests/hayaku_benchmark_deadline_equivalence_test.cjs` from PROGRAM. The exact executed commands, exits, output checks and private environment are retained in the evidence folder. Actual model/embedding calls and external network attempts are zero.

The shared WM adapter and its own shipped-product storage/init/final-consumer path have not been inspected or executed by this worker. The LIB-local handoff explicitly requires a WM-owned adapter consuming the frozen transcript/gold; no packet answer may be pasted into its final context. The four-scale, three-independent-process paired matrix, 2,000-turn delayed-start content/cost equivalence, native host/provider behavior and real semantic/model accuracy remain unverified. Shared benchmark resume and pooling old/new wall times therefore remain BLOCKED.
