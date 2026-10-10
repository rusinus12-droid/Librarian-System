# GRADIA MiB scale read corpus and model evidence selection

Revision 2 design, 2026-10-06. The user approved 4 MiB / 1,024 items by default, configurable to 32 MiB / 8,192 items. This replaces the old capacity proposal; the v1 artifact remains historical and unchanged. No product code has changed. Execution awaits the parent interface/plan check.

## User visible result

GRADIA may read up to 4 MiB of eligible owner evidence in one logical read, with settings up to 32 MiB. The transfer ceilings are 1,024 items by default and 8,192 maximum. A single complete item may use the full configured corpus content budget. These are binary units: 1 MiB = 1,048,576 bytes.

The model receives a separately budgeted selection from that corpus. Reading MiB does not require sending MiB to a model. Whole items that do not fit a model call can remain successfully read but omitted from that call, with a recorded reason. No transport truncation or partial source item is labeled complete.

The first named local accounting profile is deliberately narrow: official dated GPT-4o mini, plain-text SHADOW-only Chat Completions. Native JSON-schema AIDE/other-model accounting is not yet qualified. Those configurations keep native-only behavior before evidence use rather than being promised production 4/8-phase evidence support. The implementation must expose this limitation clearly; it must not silently change models, disable AIDEs or claim a test-only meter is production support.

The warm-query-cache-only retrieval policy, native verification, ownership, point-in-time currentness, independent projects and no-extra-model-call rule are unchanged. A cold/mismatched/in-flight query cache is unavailable. A 2,000-turn test means querying an owner corpus covering 2,000 turns, not returning all 2,000 raw turns or expanding the search policy automatically.

## Actual sources and the chosen retrieval boundary

Baseline GRADIA source SHA256: `281d0ca7c8c3fd7d39239387b3f8a0b5d6fcadd217a968b2e1ff5b3fc374a99c`.

Actual LIBRA source SHA256: `d16c24154010d4689250a5b591ccc2fdf3417db03cac830db81a4e0ab46fe128`.

Current GRADIA `createLibReadConsumer` fixes 8 items/8,192 content bytes (33962), and `renderLibEvidence` has a 65,536-byte rendered limit (3304-3317). It JSON-clones receipts and renders all returned items into one shared block. Raising only maxBytes would leave small output limits and expensive whole-corpus copies in place.

Current LIBRA's ordinary recall returns `packed.selected` (59086,59262), with a 12,000-character prompt limit and recallMaxMemories normalized to 1-20. V2 must not use that already-excerpted output as its large corpus.

**Chosen producer profile:** expose the existing ranked candidate frontier from `shortlistRecallCatalog` before its ordinary `hydrateLimit` slice (LIBRA.js:56920-56935). Preserve candidate presets, forced/temporal priority, eligibility, scoring formulas and existing associative opt-in. The new authenticated GRADIA profile hydrates this frontier under its admitted byte/item limits, rather than using the ordinary 48-record prompt-hydration cap. It then returns the full eligible scored/sorted corpus before prompt packing. No underlying search frontier is widened to 1,024 or 8,192.

Freeze frontier construction precisely: take the existing ordered forced/latent `mustHydrate` rows followed by the remaining `catalogRows`, deduplicate by the same owner memory key, cap that union at the existing configured candidate limit, and preserve the existing selected-row score/order and temporal-anchor insertion/trimming rule within that limit. The forced union is not independently unbounded. Do not use raw catalogRows alone, lose a required anchor, or expose every forced row outside the preset. This changes only the new profile's hydration allowance; the ordinary path still uses hydrateLimit.

The two paths are explicit:

- **Ordinary LIB recall is unchanged:** catalog candidate presets 40 / 80 / 160 / 320 (31422-31441), ordinary hydration cap 48 (31387-31389), current MMR/count handling, 1-20 prompt memories and 12,000 prompt characters.
- **New GRADIA read profile:** candidate frontier still follows the configured existing preset, currently up to 320; existing opt-in associative additions remain separately bounded by 2. Actual eligible corpus may be much smaller. Its hydration cap is the admitted MiB/item budget, so a valid >48-record result is required in testing.
- Hydrating more of the same frontier can change corpus-relative score statistics. The scoring/eligibility algorithm remains unchanged; do not claim numerical rankings are identical to a 48-record sample.
- Model selection retains existing MMR diversity, redundancy penalties, forced-item behavior and score-floor rules. Its count allowance is determined by the v2 complete-item/context budget, not the ordinary prompt path's 20/40 packaging count. The ordinary call retains its old limit argument.

Hydration is a declared ordered, budget-bounded read. Count narrative bytes hydrated even for subsequently ineligible candidates; rejected candidates do not create an unbounded free scan. Stop before admitting a candidate that would exceed the configured byte/item budget. Report exact coverage with `frontierCount`, `visitedCount`, `returnedEligibleCount`, `frontierExhausted`, `stopReason` and a witnessed unread-frontier descriptor. A bounded prefix may be complete for its declared range while not exhausting the candidate frontier. Do not call it a complete full-frontier search. If one source item cannot be read/verified within the remaining budget, do not partially include it or silently skip it to manufacture completion; stop with the explicit reason. No automatic second recall is added.

Every returned body and required proof must be complete. If dependency/metadata proof for the declared bounded unit cannot be completed, the unit is unavailable. One oversized first item can therefore yield a clear read-limit result with no usable evidence. The per-item limit is the full corpus content cap, so no smaller arbitrary default prevents an otherwise valid large item.

Hydration requires authoritative size admission before fetching/parsing a body: the strict owner/server reader supplies verified serialized-record/proof and fixed-profile narrative sizes under the same capture guard, reserves credit, and materializes only that bounded projection. A huge record must not be fully loaded and only then declared over budget. If bounded size/read cannot be established, that source is unavailable. Track visited/scanned metadata, hydrated narrative bytes, raw transfer bytes and returned eligible bytes separately.

Complete semantic body profiles are explicit: `libra.canonical.memory-text.v1` means the entire verified stored canonical `memory.text` field; it is not the entire storage object or a packed excerpt. `libra.micro.claims-text.v1` is the existing micro renderer's full set of verified claims plus exact evidence quotes (47238-47291), never its 600-character summary. `libra.micro.source-span.v1` is the existing minimum_source_bound record's verified declared exact source span, explicitly not a whole-turn transcript. Profile/version, exact fields/spans, source hashes and required group dependencies are pinned in the manifest. Vectors, credentials and unrelated internal fields are not model content. Unsupported/empty/non-complete source profiles are unavailable; do not fall back to excerptForMemory or packed.selected.

## Coupled configurable limits

| Quantity | Default | Hard maximum | Meaning |
|---|---:|---:|---|
| Corpus content UTF-8 bytes | 4 MiB | 32 MiB | Sum of complete returned source bodies |
| Corpus items | 1,024 | 8,192 | Transfer ceiling, not a search frontier |
| One item content | Same as corpus cap | Same as corpus cap | No arbitrary smaller per-item default |
| Corpus/owner proof metadata | 2 MiB | 16 MiB | Canonically serialized metadata, including selection/range/absence witnesses |
| Native request/projection metadata | 1 MiB | 8 MiB | Independently bounded; no source bodies hidden in metadata |
| Semantic query text | 32 KiB | 128 KiB | Full query budget; never an excuse to mint a new vector |
| One serialized transport frame | 1 MiB | 1 MiB | Measured complete JSON UTF-8 frame, including framing fields |
| Content per transport fragment | 128 KiB | 128 KiB | Fragmentation only; never a partial semantic item |
| Transfer frames per logical read | 256 | 2,048 | Control/data pages combined |
| Aggregate serialized transfer | 32 MiB | 256 MiB | Includes repeated framing; one logical capture only |
| One retained issued record | 8 MiB | 64 MiB | Content plus all serialized retained metadata; separate from memory accounting |
| Retained issuance records | 4 | 4 | One active GRADIA run; retired records/operations retain ownership as needed |
| Physical unfinished owner reads | 4 | 4 | Includes timed-out/canceled reads until they settle |
| Managed allocation credit per endpoint | 64 MiB | 256 MiB | Byte backpressure for application-owned representations, not a global heap claim |
| Rendered model-evidence block | 256 KiB | 4 MiB | Additional ceiling, always limited by actual model-call capacity |

Item count, metadata, node count and byte limits all apply. Use the fixed protocol schema, a maximum nesting depth of 8, and metadata node limits of 131,072 default / 1,048,576 maximum. IDs retain bounded string lengths; metadata cannot smuggle unbounded bodies. A configured read limit must be accepted explicitly or rejected before capture, not silently lowered.

All byte/count/index/deadline/token fields require finite nonnegative safe integers, with strictly positive values where the schema requires them. Reject NaN, Infinity, fractions, negatives and overflow rather than coercing/clamping external values. Check additions/multiplications before reservations, allocations, sequence arithmetic and deadline calculation. Internal monotonic time is converted once to a safe integer millisecond tick; client timestamps are not authority. Scoring values have their separate existing finite-number schema and are not mistaken for byte counters.

The query cap is separate from the corpus size. Existing GRADIA compacts the resolved query text to at most roughly 6,000 UTF-16 code units before its old 4 KiB cut, while hashing full input independently. 32 KiB accommodates that existing resolved text without the 4 KiB prefix changing a warm-cache key. V2 does not silently truncate or normalize a query into a different semantic query. Require the exact existing owner query-bundle/cache-key semantics; if the complete semantic query exceeds the selected query cap, unavailable. Full current-input hashing remains unchanged.

## Serialization and memory ownership

Small results may travel in one frame. Use paging/fragmentation only when the measured frame/copy budget requires it. This is necessary at MiB scale: valid JSON escaping can expand ASCII control characters by approximately six times, and the old stringify/parse clone path holds more than one representation at once. A 4 MiB logical corpus can exceed the 64 MiB managed budget if blindly copied as one escaped payload.

Every frame is bounded, including client native/projection metadata and owner manifest/proof metadata. Stage large request metadata as fixed-schema pages under the issued admission, then verify its declared root/length before any owner recall. Return only a small sealed response header rooting paged item/proof metadata. There is no multi-MiB inline request/response exception. All staging shares the same caller/issuer/request binding, aggregate credit, cancellation and one capture/transfer deadline.

The 1 MiB frame limit is an application copy-control limit, not an assertion about Risu's undocumented maximum IPC payload. A content fragment is at most 128 KiB raw UTF-8, leaving room for worst-case JSON escaping and bounded framing. Measure the final frame before sending. Data frames pack multiple small content items/fragments, and metadata frames pack multiple bounded entries; an item does not mandate its own frame. Thus 1,024 small items do not require 1,024 pages. Frames carry corpus/request/issuer identity, monotonically ordered page index, item/fragment identity, lengths and hashes.

Never split a Unicode code point or surrogate pair. Require well-formed Unicode for certified UTF-8 source content; malformed/unpaired surrogate data returns an explicit unsupported-text result without modifying the source or silently replacing it. Test quotes, backslashes, controls, emoji, combining marks, CJK and U+2028/U+2029. Full item length/hash is checked after reassembly; only then can that item be complete. Missing/reordered/duplicated/conflicting fragments cannot create usable evidence.

All outgoing data/metadata pages come from immutable sealed capture bytes. Never reread source bodies to generate later pages. The sealed header binds canonical manifest hash, ordered item/range hashes, page hashes/counts and lengths; the final owner currentness check is additional to transport verification. A changed source revokes the capture instead of producing a mixed-generation transfer.

Managed credit is reserved before application-controlled allocation and includes retained text, metadata, encoding/decoding buffers, reassembly, queued frames and selected-prompt copies. Charge string representations conservatively by UTF-16 code units as well as actual byte arrays; account for the simultaneous old/new strings during a join or render. Do not stringify/parse-clone the entire corpus for getEvidence, every stage, logs or snapshots. Use immutable corpus ownership and bounded selected views.

Four reads is a concurrency ceiling, not permission for four maximum-size reads without credit. Retired/canceled reads keep their physical slot and byte reservation until settled. Admission may therefore allow fewer than four large operations. Late results are discarded without recreating issuance entries. The owner and client each enforce their own credit ledger; these ledgers are not a combined system-memory or peak-heap guarantee. Host-side database snapshots, VM overhead and engine allocations require separate measured qualification. Do not retain full host DB/chat snapshots in receipt closures.

Count actual data-bearing source operations, including nested hydration/vector/native-snapshot fan-out, rather than counting only outer RPC methods. One capture RPC cannot bypass the four-read limit by starting unbounded Promise.all work. Transfer/reassembly reservations are separately charged while queued or unfinished.

Worst-case aggregate wire remains independently bounded: at maximum settings 6 × 32 MiB content + 16 MiB corpus metadata + 8 MiB native metadata + at most 32 MiB bounded page framing fits the 256 MiB aggregate cap. The default corresponding bound is 24 + 2 + 1 + 4 = 31 MiB, within 32 MiB. Exceeding any measured bound rejects the transfer; it never weakens completeness.

## Corpus and model selection are different proofs

`gradia.owner-corpus.v2` certifies the complete declared budget-bounded read unit from that frontier: ordered item manifest, source IDs/revisions/variants, per-item body SHA256/bytes, semantic query/policy identity, owner closure, total counts/bytes, native boundary, semantic modeEpoch, DATA/reset/server generation and issuer-instance handle.

It does not claim to represent every memory, the entire candidate frontier when frontierExhausted is false, or all 2,000 turns. A successful corpus capture and a completed transport are separate states. The client cannot consume a partial transfer even if the owner already completed its capture.

`gradia.model-evidence-selection.v2` certifies an intentional per-stage/per-phase selection from that corpus. Its manifest names the selected complete items or existing owner-defined complete subunits, their hashes/source handles, rendered evidence hash, and omissions with reasons. It also binds the corpus identity and existing MMR policy. A raw string slice is not a complete subunit. Oversized whole items are omitted from the model selection, not falsely marked partially read or silently summarized.

Both projects consume the same pinned pure selection/render module, `GRADIA/src/GradiaEvidenceRender.source.js`, contract `gradia.evidence-render.v2`. LIB independently recomputes the exact rendered evidence hash from its issued complete source units and ordered selection, rather than trusting the submitted hash. Its copied dependency is `LIB/PROGRAM/sdk/GradiaEvidenceRender.v2.source.js`, verified byte-identical at build time.

Retain the existing MMR diversity/redundancy policy at model-selection time, including its existing diversity/score rules; the new profile supplies the context/read-budget count allowance explicitly. Do not replace it with first-in-text order, a new lexical fallback, a model reranker or extra retrieval. Closure-required semantic groups must be selected together or omitted together. Proof-only dependencies may remain outside the rendered model text, but must remain in the owner currentness closure.

Every stage can have a different model/input budget. One logical corpus acquisition may therefore support several deterministic selection receipts, without another recall or embedding. Later stages must retain binding to all evidence already consumed by earlier derived drafts. Finalization validates the corpus and all consumed selection receipts; reducing a later selection does not erase earlier dependencies. Existing no-cache/no-persistent-evidence-derived-output rules remain.

## Real model context path

Actual GRADIA has explicit `preset.context_window` and `catalog_context_window` (sanitizePreset:5023-5025), model metadata at 2856, catalog selection storage at 38426-38430, and per-stage resolution at 21324-21350. `max_tokens` is output, not context. Existing reference/engine capacity functions use character heuristics, small output-reserve caps and profile fallback. Existing Ollama default 32,768 and learned character ratios are not verified free context.

The new evidence budgeter begins after current system/user/shared/CBS content and effective preset/output settings are assembled in `callLLMWithPreset` (24753-24835), but its decisive check is after the provider adapter has materialized the actual final payload and before any network dispatch. Count the serialized text/roles/envelope for that supported provider format, include native/current input and previous draft, then reserve the actual effective output/reasoning budget from the final provider payload. Do not cap this reserve arbitrarily at 8,192. The materialized body/model/route must remain identity-bound through dispatch; a later transform invalidates the selection rather than silently sending a different payload.

Accepted capacity sources are a positive explicit manual context_window, or a positive catalog limit tied to the exact current model and provider route. Existing blank metadata_model_id or stale provider-route metadata cannot be treated as verified catalog authority. Manual capacity is labeled configured, not remotely verified. The source/provenance and current model/route are recorded in the budget witness.

Use a qualified local tokenizer for the current model/format, or a documented conservative token upper bound valid for that exact supported text profile. The current chars/2.4, chars/3.4 and profile guesses are not such proof. No remote counting/model call is added. When context or token accounting is unknown, expose model_context_unavailable/token_accounting_unavailable and do not inject extra evidence. Native-only behavior remains unchanged before evidence has been consumed; after consumption, lost capacity/model binding fails the evidence run rather than recovering a native-only draft.

For a qualified total-context profile: available evidence tokens = max(0, context limit - actual base input tokens - actual output reserve - margin), with margin = max(1,024 tokens, ceil(5% of context limit)). Measure the final escaped evidence block and final payload again; fit complete units under both this limit and the configured rendered-byte ceiling. Provider input-only context profiles must explicitly identify that accounting model rather than double-count output. Automatic provider fitting that changes bound native/evidence prompts remains rejected, with no extra model retry.

Implementation must supply at least one genuinely qualified local token-accounting profile; a synthetic test tokenizer cannot be called production support. Other model profiles remain honestly unavailable until qualified. Merely knowing a numeric context_window does not create a tokenizer.

First named production profile: `openai-gpt4omini-20240718-chattext-conservative.v1`, exact `gpt-4o-mini-2024-07-18` on the official OpenAI Chat Completions route, ordinary system/user string messages only. It excludes tools, images, arbitrary message keys, Responses format, native JSON schema/response_format and custom proxy transformations. The local ordinary-text upper bound uses UTF-8 byte length because the audited o200k byte-BPE vocabulary includes all 256 single-byte values and merging cannot increase that initial count. Provider framing is a separate version-qualified estimate, not part of that mathematical proof. Reserve the larger of published framing and actual final serialized-payload overhead, plus the stated safety margin. The pinned host contains the o200k vocabulary and loader but does not expose a standalone count API; parseRisuChat(tokenizeAccurate) is not a token counter. No tokenizer asset download or count/model request is required for this conservative profile. The positive actual-code fixture is the existing SHADOW-only plain-text configuration; it must not be relabeled general 4/8 structured-evidence support. Structured AIDE profiles remain unavailable until independently qualified. Existing native-only 4/8 behavior is unchanged.

The profile uses the documented dated-model text framing, while retaining the provider documentation's warning that framing counts are version-qualified estimates rather than timeless guarantees. Cap effective context at the documented 128,000 and reserve the actual final output parameter up to the documented 16,384 output maximum. This does not change user-selected models or send a probe. Unknown route/model/normalization is rejected. Sources: [OpenAI token counting guide](https://developers.openai.com/cookbook/examples/how_to_count_tokens_with_tiktoken) and [GPT-4o mini model reference](https://developers.openai.com/api/docs/models/gpt-4o-mini). The local content-bound proof and its exact source pins are in TOKEN-ACCOUNTING-PROFILE.md.

BudgetWitness has fixed fields: providerId, modelId, routeIdentity, requestFormat, contextLimit/contextSource/contextSourceIdentity, meterId/meterVersion/meterKind, baseContentTokenBound, framingAllowance, effectiveOutputReserve, explicitReasoningReserve, safetyMargin, selectedContentTokenBound, renderedEvidenceBytes, finalInputAllowance and finalPayloadHash. meterKind distinguishes exact local counts from the initial content-bound-plus-framing-estimate profile; do not label the latter an exact total token count or a mathematical provider-framing guarantee. LIB certifies source/membership/MMR/render binding; GRADIA owns and rechecks this model-capacity/dispatch witness. The witness does not turn LIB into an authority on the client's model configuration.

## Proposed cross-project APIs

Transport schema: `gradia.owner-read.v2`; separate request/response IPC channels `gradia_libra_read_request_v2` / `gradia_libra_read_response_v2`. Authenticate host metadata.sender and issuer-instance identity; payload sender claims are never authority.

1. `admitReadV2({requestId, projectionVersion, stagePolicy, executionBudget, readLimits})` returns disabled/unavailable or an issued admission plus accepted limits/limitsHash. The native projection handshake and strict observer requirements remain unchanged.
2. `startCorpusTransferV2({admissionId, requestId, requestMetadataHeader, limitsHash})` accepts a small header declaring exact request-metadata length/page count/root and starts the one logical capture/transfer deadline. `stageRequestMetadataPageV2({admissionId, requestId, pageIndex, pageHash, payload})` supplies bounded pages of projectionRequest/nativeReadSet/input hashes/query. Verify the complete staged root before recall; no arbitrary object/body fields or unbounded inline payload are accepted.
3. `captureCorpusV2({admissionId, requestId, requestMetadataRoot, limitsHash})` performs exactly one cache-only query against the defined existing ranked frontier with v2 byte/item-bounded hydration. It captures full eligible bodies/closure and explicit coverage, then returns a small sealed corpus header rooting the paged receipt/manifest/proofs. No automatic second retrieval on a miss/overflow.
4. `readCorpusPageV2({corpusId, requestId, pageIndex})` transfers only a predeclared immutable page of that issued corpus, including metadata pages when necessary. It is not a new recall or arbitrary KV read. Check issuer/request/revocation/mode/DATA on every page; complete relevant closure is revalidated before corpus acceptance and each evidence use.
5. `completeCorpusTransferV2({corpusId, requestId, manifestHash, receivedDigest})` follows local complete-page/item verification with authoritative currentness. No partial corpus becomes ready.
6. `startPromptSelectionV2({corpusId, requestId, stage, phase, selectionMetadataHeader})` starts bounded fixed-schema selection staging and returns selectionTransferId. `stagePromptSelectionPageV2({corpusId, requestId, selectionTransferId, pageIndex, pageHash, payload})` carries ordered selectedItemIds, renderedEvidenceHash, selectionPolicyHash and BudgetWitness within frame limits. Its one absolute 30-second staging deadline is also capped by the existing receipt lifetime; pages cannot reset either deadline.
7. `bindPromptSelectionV2({corpusId, requestId, selectionTransferId, selectionMetadataRoot})` verifies the complete staged selection/MMR policy, independently recomputes renderedEvidenceHash, and issues a selection receipt. BudgetWitness is GRADIA's qualified model-capacity calculation, not a claim that LIB owns the model configuration. Selection staging shares all managed/aggregate/record limits and does not rerun capture or extend the corpus lifetime.
8. `assertSelectionCurrentV2({corpusId, requestId, selectionHandle, receiptDigest})` checks issued identity, native facts, stable mode/DATA/server generation, corpus/selection closure and revocation. Completed unrelated writes remain harmless when the relevant closure is unchanged.
9. `cancelReadV2({requestId, admissionId, corpusId})` revokes access and releases settled ownership; unfinished physical reads remain counted until settled. Unload/supersession/late-reply handling stays fail-closed.

Admission expires after 30 seconds if startCorpusTransferV2 has not begun. One absolute capture/complete-transfer deadline is anchored at that initial start, covering request staging, capture, every data/metadata page and completion: `min(120000, max(30000, contentMiB × 5000))` milliseconds, with the existing at-most-5-second callback bound. Pages/retries/completion cannot reset it. This is a deadline, not a throughput guarantee. It permits 30 seconds at the default and 120 seconds at 32 MiB. Timeout causes unavailable, not partial success or another recall. After complete capture, the existing executionBudget-derived 4/8-phase receipt lifetime is retained, enforced by issuer monotonic elapsed time; model stage deadlines are not shortened.

## Ownership and implementation boundaries

- Real server worker: control authority, modeEpoch, qualified strict observer and full source-closure capture/assert APIs. This foundation is unchanged by the capacity revision.
- LIB producer adapter worker: isolated v2 ranked-frontier hydration/corpus extraction, existing cache-only vectors, full closure, paged issued corpus, owner MMR selection validation and selection receipts. It must not alter ordinary recall/prompt-packing behavior or silently enable a retired search fallback.
- GRADIA worker: independent pure native codec, v2 consumer/page verification, managed-byte ownership, per-call evidence budgeter/selection binding and unchanged native-only/G03 privacy behavior.
- Shared codec remains `GRADIA/src/GradiaNativeProjection.source.js`, contract `gradia.native-projection.v1`, consumed by LIB as a version/hash-pinned dependency. New client budget logic lives in `GRADIA/src/GradiaEvidenceBudget.source.js`, contract `gradia.evidence-budget.v2`. Integration/build tooling is explicit; projects remain separate.

The first actual implementation gate is interface review of the shared limits and real closure/metering inputs. No product code is authorized by the existence of this draft alone.

## Required test matrix

1. A real owner fixture spanning 2,000 turns, warm compatible query, unchanged candidate preset/scoring, a successful new-profile read exceeding 48 complete records and 8 KiB, and valid GRADIA delivery. Independently prove ordinary LIB recall still retains its 48-record hydration and 20-item/12k prompt limits. Report actual corpus items/bytes; do not claim all raw turns were returned.
2. Several full large source items totaling above the old 8 KiB limit and near 4 MiB; configurable 32 MiB coverage; one item near the whole corpus cap; one byte/item over each cap. Full bodies survive hash/transfer exactly.
3. Synthetic protocol cardinality boundaries at 1,024/8,192 items, explicitly labeled transport tests rather than a widened real retrieval frontier.
4. CJK/emoji/combining/control/quote/backslash text, escaped wire expansion, UTF-8 versus UTF-16 accounting, malformed surrogates, fragment boundary/reassembly/hash/duplicate/order failures, metadata and aggregate overflow.
5. Four physical reads with deferred completion, repeated cancel/supersession/timeouts, actual byte-credit exhaustion, delayed large results, and no read-slot release before settlement. Include whole-corpus JSON-copy regression and large host snapshot retention qualification.
6. Complete corpus with a smaller intentional model selection; large unfit item omitted with reason; semantic dependency groups remain complete; corrupted/missing transport never reported complete.
7. Verified/manual context paths, stale catalog model/route, unknown context or tokenizer, large prior draft, large output/reasoning reservation, exact final escaped block/payload count, and rejection of provider-side fitting without retry.
8. Existing warm/cold/in-flight cache policy, issuer affinity, sender/handle spoofing, mode ABA, DATA/reset/server generation, native facts, full alias/manifest/range/absence closure, unrelated-write positive control, all Full/Min evidence/privacy/4-8-call regressions.

No test result or live qualification is claimed in this design. The prior v1 artifacts and source pins remain intact.
