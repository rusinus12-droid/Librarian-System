# T12 capture and memory-read repair (2026-11-03)

## Evidence and diagnosis

Inputs were the user's HAYAKU packet, GRADIA 0.28.13 debug export, Flashback 1.3.16 debug export and LIBRA 2.6.15 debug export. Private transcript/packet bodies and credentials are not copied into this repository.

- HAYAKU: the supplied packet is parseable JSON and the unmodified public parser reports validCount=1 and canonicalCount=1. A format rejection of this exact packet is not established. Its stateAuthority=false is not a marker parsing error. The existing storage scanner locates marker strings, but the public inspector requires an HTML-comment envelope and decorations inside the marker pair can break JSON admission.
- GRADIA: connected, externalEvidence=false, LIB_READ_STALE after 40,943 ms. LIBRA reports an earlier successful unified query (36,549 ms, 9,575 characters). The bf04446 diff changes receipt/native-view handling, not the SDK authorization path. The supplied export does not establish a new direct regression in bf04446. A reproducible existing race is an obsolete server authorization corpus witness after a long owner query that prepares/publishes data.
- Flashback: T12 response candidate received; assistant_not_found persisted until finalized_capture_max_age (240,903 ms). The v2 resolver rejects a committed response that differs from its earlier candidate even when the exact bound user and logical pair match. This source-level case reproduces on bf04446. The export does not retain the two full bodies, so their exact difference remains unverified.
- LIBRA: observedTurns=12, canonical committedTurn=10 and waiting_for_five_turn_boundary are expected for five-turn canonical batching. The last Micro publication remains T11; T12 publication is not proved. The backend silently failed over to legacy script output. The legacy callback ignored its final response content, so later hook transformations could fail the exact main-completion Micro admission hash. A separate sourceDigest response-boundary failure is present; its precise association with T12 is not established by this export.

## Changes

- HAYAKU 3.3.12: public inspection shares the marker-string scanner. Peel only boundary whitespace, angle/comment decoration and JSON code fences; retain schema, grounding, lineage and native-turn binding validation. No paid repair call is introduced. Angle, fence and stray-comment packets are physically saved and bound to their observed native turn in the runtime tests.
- GRADIA 0.28.14: when the server witness advances during an initial unified capture, refresh that authorization witness and revalidate the already issued LIBRA receipt before accepting it. Existing/consumed reads still reject changes. Principal revocation, scope/route/reset changes and stale owner receipts remain fatal. Update the preserved GRADIA SDK byte pin.
- Flashback 1.3.17: allow response drift only for a bound stable user identity with unchanged user text and the same unique logical pair. Persist the settled live response. Unbound requests still require exact candidate affinity, and reroll baseline guards remain active. Existing monitor stability timing is preserved.
- LIBRA 2.6.16: bind legacy output's final response hash to the existing same-scope main-completion proof. Still require unchanged user, historical prefix, turn, fresh request and matching settled live response. Use the freshly settled host snapshot for receipt candidates and their authority checks.
- Repair the selected-receipt regression's obsolete instrumentation anchor to the current implementation helper; keep all functional/cancellation assertions.

## Validation boundaries

New reproductions fail on the original bf04446 bytes and pass with the patch: marker-first inspection, authorization advancing during capture, committed Flashback response drift, and legacy final-response Micro admission. Negative cases cover edited users, stale owners, route changes and principal revocation.

Focused and neighboring checks include actual HAYAKU/Flashback producer records, temporary local HTTP/SQLite, real host-channel IPC implementations, GRADIA model-payload delivery, all three receipt storage modes, receipt recovery, native identity changes, schema/admission and cancellation. Model responses are controlled fixtures; no live provider is called. The Windows sandbox temporary-directory rename error was avoided by placing disposable test data under the workspace.

Live RisuAI GUI/provider execution and recovery of the user's already expired T12 data have not been performed. A source patch and synthetic-host success do not constitute those validations.

Final versioned-source core run: 53/53 Node subtests pass across flashback_committed_response_drift, hayaku_marker_first_packet, gradia_three_owner_sdk, libra_capture_lifecycle_accuracy, gradia_three_owner_pipeline and libra_selected_receipt_preparation_boundaries.

Additional neighboring runs passed storage/admission, real IPC lens delivery in plugin_only/server_only, receipt 3-mode/recovery, read-only SDK/server principal and response-boundary checks. The broader run also found two pre-existing failures in libra_receipt_deadline_publication_test.cjs: the expected 1000-1400 ms inner timer was not reached (both original bf04446 and patched source). They remain failing; no assertion or timeout was relaxed. Therefore this is not a full regression pass.

SDK synchronization, preserved GRADIA SDK pin, unified-read embedding, Source provenance and final manifest/checksum physical readback are the release-integrity checks for this change. Source candidate versions are not a published ZIP or a live-host qualification.
