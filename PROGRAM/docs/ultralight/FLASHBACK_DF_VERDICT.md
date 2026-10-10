# Flashback DF loop — measured verdict (re-checked after the LIBRA optimisation)

**Outcome: not modified. The earlier "under 1%" judgement was reached by a different measurement,
and this re-check both corrects the number and confirms the conclusion, from a stronger reason.**

## What was re-measured

`tools/_probe_flashback_df_share.cjs` — the shipped loop against its obvious replacement
(an inverted index built once, then looked up per query token), on the corpus shapes Flashback
actually serves, including 4,096 documents (the cache ceiling).

| documents | tokens/doc | query tokens | shipped | inverted index | ratio |
|---|---|---|---|---|---|
| 1,200 | 40 | 12 | 3.5 ms | 30.4 ms | 0.12× |
| 4,096 | 40 | 12 | 12.6 ms | 42.6 ms | 0.30× |
| 4,096 | 60 | 20 | 8.6 ms | 74.4 ms | 0.12× |

The replacement is **3× to 8× SLOWER**, so it is rejected on measurement, not on preference.

## Why the replacement loses

The inverse index must visit every term of every document — `documents × fields × tokens` — while
the shipped loop visits only the query's tokens: `queryTokens × documents × fields`. With 12 query
tokens against 40–60 tokens per field, the shipped loop sees roughly an order of magnitude fewer
items. Building the index is only worth it when a corpus is searched MANY times per build, which is
not this call site: the ranking pass builds its DF table once per request.

## Where the DF cost really sits

`tools/_probe_flashback_pass_parts.cjs` decomposed the pass and first reported the average-length
precompute at 95–98% — that reading was an artefact of the probe itself (it timed the whole
`Object.fromEntries(fields.map(...))` expression including closure and allocation churn, not the
arithmetic). Re-measured directly by `tools/_probe_flashback_average_length.cjs`:

| documents | shipped shape | one-pass shape | identical |
|---|---|---|---|
| 1,200 | 0.149 ms | 0.199 ms | yes |
| 4,096 | 0.282 ms | 0.499 ms | yes |
| 12,000 | 0.818 ms | 1.036 ms | yes |

Sub-millisecond at every size, and the "optimised" one-pass form is slower. With DF ~0.7–1.5% and
scoring ~1–3% of the pass, **no component of this pass is a bottleneck**, so there is nothing to
fix and any change would be churn.

## Standing rule this produced

A micro-benchmark that times a COMPOSITE expression (closure + allocation + arithmetic) can report a
share that is an order of magnitude wrong. Decompose to a primitive the profiler can attribute,
then re-measure the candidate fix against the shipped shape before writing it up — and when the
candidate is slower, say so and leave the code alone.
