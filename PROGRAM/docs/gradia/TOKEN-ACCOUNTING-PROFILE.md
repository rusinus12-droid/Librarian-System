# Historical G2 accounting profile

2026-10-15: The live GRADIA path now uses [model-configured context and separate transport budgets](MODEL-CONTEXT-BUDGET-20261015.md). The fixed model/route and byte-as-token bound below describe the retained v2 component and its historical fixtures, not current runtime admission.

# First local model accounting profile

Profile ID: `openai-gpt4omini-20240718-chattext-conservative.v1`.

This is a production implementation profile with offline control evidence, not an executed tokenizer/model test or live validation. It has a provable ordinary-content bound plus a separately qualified framing estimate. It must never be described as a universal or mathematically guaranteed provider token count.

## Supported payload

- Exact model `gpt-4o-mini-2024-07-18` on the official OpenAI `/v1/chat/completions` route.
- Actual final payload from GRADIA's existing OpenAI-compatible builder, after shared-system-prefix assembly and all adapter transforms.
- Only ordinary string `system` and `user` messages; no name, tools, function calls, images, cache-content references, multipart input, Responses format, extra body override, unknown proxy normalization or unqualified field. The separate narrow structured profile below admits only seven exact production schemas.
- Effective context is a positive configured/qualified catalog limit capped at 128,000; effective output reservation is the actual final max_tokens/max_completion_tokens, capped consistently with the documented 16,384 model output limit. Reject conflicting/unknown settings rather than silently changing them.
- Other profiles are unavailable for added evidence until qualified. Native-only behavior is unchanged. The original plain-text fixture uses SHADOW-only. Normal four-stage and heavyweight eight-stage evidence calls use the separately identified structured profile below.

## Bounded normal/heavy structured profile

Profile ID: `openai-gpt4omini-20240718-gradia-schema-conservative.v1`.

The same exact model, official route, ordinary string messages, context/output limits, and body binding apply. Only `response_format: {type:'json_schema', json_schema:{name, strict:true, schema}}` is added. The complete serialized wrapper must match a pinned SHA-256 in `sdk/GradiaEvidenceBudget.source.js` for one of these production names:

- `gradia_shadow_act_analysis`
- `gradia_aide_character_analysis`, `gradia_aide_world_analysis`, `gradia_aide_plot_analysis`
- `gradia_aide_character_patch`, `gradia_aide_world_patch`, `gradia_aide_plot_patch`

These are the actual closed schemas emitted by the existing normal/heavy builders. Name, schema, description, strictness, or serialization drift fails closed. Generic JSON-object mode, arbitrary schemas, references/combinators, tools, and adjacent retry/repair names remain unqualified. This does not claim support for every provider, model, or recovery path.

The complete serialized request already charges every schema byte through its envelope overhead. The structured profile additionally reserves the UTF-8 byte size of the entire serialized response-format wrapper, before the unchanged output reserve and context margin. Thus the schema is never omitted from accounting or charged only as its name. This extra structured-framing allowance is a conservative engineering estimate; provider-side schema conversion and real tokenizer usage are not measured or mathematically guaranteed. The witness records the exact schema name, wrapper hash, and additional byte allowance. Actual four/eight-stage mock tests must still verify dispatch, parsing, and applied draft edits.

## What local source actually provides

The pinned Risu tree's `src/ts/tokenizer.ts:267-292` uses Tiktoken with `src/etc/o200k_base.json`. The latter is already present locally, SHA256 `a2c363f80642c0f07d916716b3940ff030121f3b5cef72b2c5bd1d4f64c14fb8`. Static inspection of its encoded vocabulary found all 256 one-byte values. No asset was downloaded or tokenizer package installed.

Risu's internal tokenize/ChatTokenizer functions are not a standalone v3 plugin API. `parseRisuChat({tokenizeAccurate:true})` returns parsed text; its flag does not return a token count. Calling it and interpreting text length as tokens would be incorrect. Internal tokenizer routing can also depend on the host model rather than the GRADIA stage model, so it is not borrowed as an implicit stage counter.

## Content proof and framing limitation

For well-formed ordinary text under the byte-BPE profile, begin with one symbol per UTF-8 byte. Each BPE merge replaces multiple symbols with one and cannot increase their count. Therefore content token count is at most its UTF-8 byte length. Summing each actual role/content string gives a conservative content bound without downloading/running a tokenizer. Reject unsupported normalization or tokenization profiles; this argument is not universal to every tokenizer.

The OpenAI guide supplies dated-model chat framing estimates and explicitly warns they are not timeless guarantees. Use its plain-message estimate only as a version-qualified framing assumption, alongside a larger actual-payload-overhead allowance and the v2 safety margin. The model reference lists 128,000 context and 16,384 maximum output for the named model. These are documentation facts, not a live account/model availability test. Sources: [token-counting guide](https://developers.openai.com/cookbook/examples/how_to_count_tokens_with_tiktoken), [GPT-4o mini reference](https://developers.openai.com/api/docs/models/gpt-4o-mini).

The initial local allowance is:

- contentBound = sum of UTF-8 bytes of every actual role/content string
- framingEstimate = 3 × message count + 3, for this nameless dated plain-chat profile
- framingAllowance = max(framingEstimate, complete serialized payload UTF-8 bytes minus contentBound, 0)
- inputAllowance = contentBound + framingAllowance
- require inputAllowance + actual output reserve + max(1024, ceil(5% of effective context)) <= effective context

The byte-BPE content inequality is the proof. The framing allowance/margin is an explicit conservative engineering policy with the documented limitation; do not upgrade it into proof of unknown server internals. Materialize and measure the exact body, then hash-bind model/route/body through dispatch. Context errors fail without another model call. Do not use output max_tokens as context size.

## Required implementation evidence

The positive fixture must exercise the actual named production meter and actual GRADIA payload builder with a real model ID/context configuration, using trapped dispatch rather than a remote model/count endpoint. It must admit nonzero memory that fits the conservative allowance. Negative cases include unqualified or changed structured schemas/names, unknown models/routes, proxies, mismatched payload after metering, Unicode/control/escaped text, missing context, excessive output reserve and budget overflow.

Test the content-bound arithmetic against the pinned single-byte coverage and independently generated byte-length cases. Do not replace the meter with an always-true test callback. These offline checks qualify the implementation/profile; they do not demonstrate live end-to-end model execution or universal 4/8 evidence support.
