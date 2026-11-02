# LIBRA recall boundary diagnostics

The supplied LIBRA 2.6.15 export fails at `unified_response_boundary` with
`UNIFIED_RESPONSE_AUTHORITY_CHANGED` after 85.7 seconds, with 4.3 seconds of
request budget remaining. Graph selection and lens recall completed. The export
does not identify which authority field changed or who changed it.

This patch preserves rejection and adds `lastResponseBoundaryFailure` to the
debug export. It records only time, error code and changed field names. The
thrown error carries the same request-local diagnostic, and the recall failure
viewer includes it. No source text, settings values or memory values are added.

GRADIA owner-query diagnostics now distinguish missing graph authority from
`modelDispatchEligible` refusal at `graph_delivery_admission`. Existing transport
error codes remain unchanged. A generic owner refusal is not assumed to share
the response-boundary failure's cause.

The production boundary test verifies that derived manifest metadata remains
accepted, canonical revision changes remain rejected, and the resulting error
identifies exactly `manifestDigest` without including stored values.

This is a diagnostic patch. It does not establish that the live recall failure
is repaired. The next failing export can identify the changing field before
changing recovery ordering or authority semantics. No DATA migration, timeout
increase or authority-check bypass is introduced.
