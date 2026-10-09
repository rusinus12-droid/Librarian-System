# HAYAKU summary-alias retrieval

Existing `meta.summary_memory.recallAliases` are retrieval metadata for their
own summary, not additional factual text. The lexical search body includes only
aliases carrying an internally issued, immutable certificate bound to the
source hash, source revision, record key and original JSON pointer. Rendering,
deduplication, source-row identity and final evidence budgets still use the
original record body. Local ranking, server corpus serialization and the
post-await corpus check use the same search-body function.

Derived alias metadata examines at most 64 scalar aliases and reuses the compact
admission's 700-UTF-16-unit string limit (at most 44,800 units total). Slicing
does not split surrogate pairs, and happens before additional normalization or
copying. Canonical alias strings and original evidence are never rewritten.

## Privacy and bounded preparation

The source projector already advances at most 128 records per descriptor per
call. Each chunk's normalized `projection.packet` is checked by the existing
`packetRecordRestrictedSecrets` predicate. This must not use the slim public
record value: fields such as `reveal_state`, `hidden_from`, `revealed` and
`holders` can be absent there.

The per-generation certificate retains only one summary's normalized aliases
and provenance, plus a sticky restricted-secret decision. It does not retain
whole packets or invoke the full semantic canonicalizer/reducers. No aliases
are searchable until source projection is complete. If any chunk has a
qualifying restricted secret, every language's summary aliases are removed by
the same helper used by the existing admission redactor. Private-summary and
record visibility gates still apply independently; query aliases do not add
actors or grant viewer access.

Large or deadline-interrupted sources can therefore keep ordinary body recall
while aliases remain unavailable until later bounded passes complete. This is
visible through `_recallSourceCoverage.aliasCertification` and the existing
partial-source counts; it is not complete cold-call alias coverage.

## Lifetime and compatibility

Certificates/progress live in the transient source projection cache, keyed by
the exact raw generation, source evidence, scope/worldline locator metadata and
certificate version. A new revision starts uncertified. Empty, failed or
skipped replacement generations cannot inherit a stored wrapper's aliases.
Completed same-generation certificates are reused on warm requests. Fresh VMs
rebuild them through ordinary source preparation, including historical packets
outside the separate chronological admission window.

The legacy admitted-summary wrapper can use an in-memory proof for its current
public summary. That proof is not persisted, is not inferred from arbitrary
serialized fields, and never supersedes source preparation. Its omission from
a persisted/JSON-cloned wrapper does not lose normal-request recall: the source
cache or fresh source projection provides the current certificate.

No producer prompt, packet schema, admission-selection window, storage format,
private actor gate, tokenizer, shared SDK kernel or second search engine is
changed by this repair.

## Focused checks

- `hayaku_sanitized_alias_recall_runtime_test.cjs`: exact summary ownership,
  original-text output, privacy/redaction, final budget and revision invalidation
- `hayaku_alias_incremental_certificate_test.cjs`: bounded work, delayed secret
  schema aliases, delayed summary, interrupted/resumed preparation, empty and
  failed/skipped replacement generations
- `hayaku_alias_restart_hook_runtime_test.cjs`: the original 12-turn historical
  hook fixture, same-VM warm request and fresh-VM persisted-store reconstruction
- `hayaku_alias_search_parity_runtime_test.cjs`: exact final evidence bytes for
  local/server-success/fallback paths using an in-memory compute transport,
  plus alias-only and visibility changes during await

The deterministic 1,001-record work probe uses the same 131 clock reads with or
without aliases and asserts zero full semantic-canonicalizer calls in source
preparation. Tiny-budget elapsed time is diagnostic, not a strict wall-time
guarantee: pre-existing parsing/normalization work can overshoot a short
deadline. Real host behavior and HTTP/worker performance are separate claims.
