# LIBRA 2.3.65 — provider record normalization

Provider responses sometimes contain substantive typed values but omit the redundant fact `text` field. Previously every such fact was quarantined, leaving zero accepted facts and `UNIFIED_FACTS_INVALID`. The new provider-admission normalization step derives missing/null/blank text from existing typed values and corrects missing domains or a claim-name alias such as `knowledge` to its fixed `character` domain.

Existing nonblank text is preserved. Other valid domain disagreements and unknown domain typos remain errors. No new facts, entities, evidence quotes, certainty, temporal roles, relationship dimensions or dependencies are invented. Scalar summaries copy the original value. Knowledge lists retain their entries, and structured rule/thread/access/affiliation summaries retain scope, exceptions, status and interpretation. Reference summaries use the existing entity names. If no bounded valid summary can be formed, the fact remains subject to ordinary rejection.

All existing type, source quote, entity identity, reference and dependency checks still run after normalization. Invalid later State updates retain their existing per-field holds; unrelated valid records can commit. Strict validation of stored/manual artifacts remains unchanged. No automatic model repair request or rewriting of previously stored memory is introduced.

Admission diagnostics now include `normalizedFields`, `normalizedTextCount`, `normalizedDomainCount` and grouped `rejectionReasons`. These fields are protected by the existing admission digest and survive persistence/restart. Raw provider output remains in the analysis diagnostic. Completion reports distinguish text repairs/domain corrections from rejected records. Zero accepted facts reports a specific failure with accepted/rejected/normalized counts.

## Validation boundaries

Synthetic fixtures reproduce missing text across the entire response and the knowledge/domain error. Tests exercise scalar and structured values, partial admission, invalid quotes/entities/dependencies, conflicting domains, unchanged existing text, zero-valid-record failure, strict stored validation and receipt tampering. Local KV and real local HTTP/SQLite restart tests verify persistence without additional analysis calls. These are not real-provider semantic evaluations. The user's sensitive transcript is not used as a test fixture or reanalyzed.

During this task, the shared source and the initial task backup contained four truncated spans in the existing State/worldline code. Those exact spans were restored from the validated 2.3.64 artifact, preserving other edits. Readback hashes and the original damaged bytes are retained in `review_artifacts/libra_record_normalization_20260908/` outside the distribution.
