# GRADIA Input Writer context preflight (0.28.5)

## Report and diagnosis

The supplied 0.28.4 runtime reports `LIB_READ_MODEL_CONTEXT_UNAVAILABLE`, zero provider attempts, an empty generated input, and a logical `input_assist` call left `running` after the delivery cycle failed. The cycle lasted 61,457 ms before the first logical call. This is aggregate pre-model time; the supplied telemetry cannot separate settings, native context preparation, and owner retrieval/validation costs.

The evidence path required an explicit `context_window`, model-matching `catalog_context_window`, or an actual native Ollama request default. Missing metadata caused a hard failure after owner evidence was already acquired. A model-name capacity estimate used by reference selection did not meet the evidence path's stricter requirement. The 12,000-character reference omission warnings are separate selection diagnostics, not the direct cause of this exception. The supplied excerpt does not identify the provider or model.

## Change

- Resolve the Input Manager preset's verified context before opening the owner read. Reuse explicit limits, model-matching saved metadata, the native request default, or a matching entry in the existing route/credential-bound provider catalogue cache.
- If necessary, query the existing provider model-list endpoint once through the existing authorized fetch path. Bound the entire discovery, including response parsing, to three seconds. Existing configured limits incur no extra model-list request. This does not make a generation call or persist new preset settings.
- If no verified limit can be obtained before accepting any evidence, omit optional memory and generate from native conversation context. Display `기억 참고 생략: 모델 문맥 한도 미확인` in the choice screen and record `inputAssistSend.memory.status/reason` and a warning. To keep using memory with a provider whose catalogue omits context limits, configure the preset's actual context window.
- Cancellation, changed native context, accepted-evidence validation failures, insufficient configured capacity, and regeneration of an evidence-bound proposal still fail closed. A late catalogue response cannot resume the completed/fallen-back owner's read. Native prompt content and complete memory items retain the existing final-body budget and dispatch validation.
- Close logical telemetry records still marked `running` when their delivery cycle finishes. Record the selected context's provenance in the redacted model-selection status.

The shared budget-profile resolver can also use the matching catalogue cache for subsequent evidence-backed calls. Automatic discovery and optional fallback are added specifically to Input Writer preparation; this is not a redesign of every draft-stage/provider capability path.

## Verification

Real GRADIA source and production choice/delivery functions run in a controlled host/DOM fixture. Ten new cases cover catalogue discovery before retrieval, absent metadata, another model's metadata, a failed metadata endpoint, cancellation, the three-second deadline with a late response, native context changes, explicit-context no-request behavior, refreshed omission notices after regeneration, and failed-call telemetry closure. Existing configured-provider builders, atomic context fitting, source currentness, permissions, regeneration, cancellation, and model-budget witnesses remain covered.

Focused result: 71 tests executed, 70 passed. The remaining test, `malformed or truncated writer JSON is not retried and cannot persist its derived content`, expects one provider invocation but observes two. It was rerun against the exact committed 0.28.4 plugin and fails identically; its assertion was not relaxed. This pre-existing malformed-response recovery discrepancy is separate from the reported missing-context failure.

These are offline fixture results, not live RisuAI, provider metadata availability, billing, or device-performance validation. In particular, the supplied 61-second aggregate has not been reproduced or attributed to a specific owner read on the user's device.
