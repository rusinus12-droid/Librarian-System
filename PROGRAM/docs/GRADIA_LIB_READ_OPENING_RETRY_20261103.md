# GRADIA memory opening follow-up (2026-11-03)

## Supplied evidence

GRADIA 0.28.14 on RisuAI 2026.10.292, local Windows/Tauri. The supplied export shows a connected three-owner unified reader, 61,475 ms elapsed, zero provider attempts, no stages, no final draft, lastLibReadDiagnostic=null and pipelineWorkStatus still busy in pipeline_preparing. LIBRA open time reached 49,314 ms. These facts establish a failure before model dispatch, not successful model use of memory.

The original owner dispatch reason is absent. This export alone does not identify a particular corrupt record or establish the exact underlying LIBRA graph invalidation. No live RisuAI/provider run was performed here.

## Confirmed code paths and changes

- openLibEvidenceRun accepts an initial session, then getEvidence performs another owner currentness check. Failure there escaped before runPipeline created its diagnostic. The consumer rebuilt the error from its code and discarded owner details. beforeRequest rethrew LIB_READ errors without ending pipeline work status. Five new composed cases fail against the original 0.28.14 bytes.
- GRADIA 0.28.15 performs one fresh acquisition for LIB_READ_UNIFIED_UNAVAILABLE during opening. The previous handle is closed; model dispatch has not started. Both attempts share the existing 110-second read allowance, and timeout aborts the active transport. A bounded native revalidation and unchanged request/settings are required before retry. Persistent failure stays fatal. Actual stale, cancellation, scope and native-source changes are not retried.
- Connected requests retain a real host witness even when request rows already carry native IDs. Host changes during the failed opening cannot be silently rebound on retry. Conflicting native identity/view changes remain fatal before dispatch.
- Error code, a token-only dispatch reason and an allowlisted owner diagnostic survive consumer wrapping and cleanup. Unknown diagnostic properties, transcript, memory content and credentials are not exported by this diagnostic. Opening status includes attempts/retryCount/elapsedMs; a successful reacquisition also records the earlier failure.
- The failure path ends pipeline_preparing with busy=false and pipeline_error.
- LIBRA 2.6.17 and the shared unified-read transport preserve exact LIB_READ codes carried by plain Error messages (for example LIB_READ_STALE), instead of disguising them as LIB_READ_UNIFIED_UNAVAILABLE. The canonical transport and both embedded copies are synchronized.

## Validation

- Focused run: 98/98 pass across real three-owner producer/server/SQLite/model-payload fixtures, opening deadline, authenticated owner transport, connection lifecycle and Input Writer compatibility.
- New cases cover successful reacquisition with exactly one model call, persistent unavailable with zero model calls, native mutation and typed stale without reacquisition, diagnostics after beforeRequest rejection, UI work-state completion, plain owner errors, and a controlled 90-second first attempt leaving only 20 seconds for the second.
- Native binding and existing evidence adapter cases were also exercised; the native-ID rejection found during development was corrected without relaxing its assertion and passes in the final focused run.
- This is focused offline/loopback validation, not a full regression or live-host qualification. The supplied generic owner error may still persist for a real underlying owner failure; the patch preserves the reason on the next export rather than bypassing its validity checks.

The legacy-LIBRA generic error with dispatchReason=LIB_READ_STALE is also rejected without retry. Final versioned core run: 35/35 tests pass (pipeline, transport, shared deadline).
