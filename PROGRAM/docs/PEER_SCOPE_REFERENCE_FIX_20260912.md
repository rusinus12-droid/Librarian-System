# Peer scope references patch — 2026-09-12

- Flashback 1.0.69: strategy未指定 fallback uses recallStrategyForQueryType, preserving the current DEFAULT_RECALL_STRATEGY policy.
- HAYAKU 3.0.108: lease release returns nextRetryAt mapped to the persisted nextRepairAt. Storage and failure semantics are unchanged.
- LIA 0.26.67: empty Persona selection reads the current binding before fallback; absent Persona still follows the existing selection error. Debug export calls readPersonaProofForContext.
- RE:TRACE unchanged.

Validation: new peer_scope_reference_regression_test exercises HAYAKU failed/deferred/suspended lease release and write failure; LIA explicit/fallback/missing Persona and proof lookup; Flashback explicit/default strategy. HAYAKU native OtherAx recovery runtime, Flashback query policy and context recall, LIA binding transaction safety and native branch runtime (8 cases) pass. Syntax and lexical reference scans repeated; four targeted undefined references are gone. Tests use controlled/offline dependencies; no live RisuAI or real-provider validation claimed.
