> 2026-10-02 retirement status: LIBRA uses Classic memory recall. GRADIA/SGA, Planner and InputWriter executors, model settings and delivery controls are retired. Existing raw memory, historical receipts, drafts and physical storage keys are preserved. Helper descriptions below are historical evidence, not active operational instructions.

# Storage-Mode Support Matrix

> Package 0.3.63. Generated from `feature_inventory.json` — do not edit by hand.
> Statuses: `verified_supported`, `conditionally_supported`, `intentionally_unsupported`, `defect`, `unverified`.
> `unverified` is never a claim of failure or absence of support.

정식 운영 모드는 `plugin_only`와 `server_only` 두 가지입니다. `mirror` 열은 퇴역 전 실행 및 기존 설정 호환성 근거이며, 새 운영 모드 선택이나 기능 동등성 보증에 포함하지 않습니다. 전환 계약은 `STORAGE_MODE_TRANSITION_CONTRACT.md`를 참조하세요.

## Totals

| Mode | verified_supported | conditionally_supported | intentionally_unsupported | defect | unverified |
|---|---|---|---|---|---|
| plugin_only | 70 | 0 | 0 | 0 | 0 |
| mirror | 48 | 0 | 1 | 0 | 21 |
| server_only | 48 | 0 | 1 | 0 | 21 |

## Features

| Owner | Feature ID | Class | plugin_only | mirror | server_only |
|---|---|---|---|---|---|
| libra | `LIBRA-CANONICAL-CAPTURE` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| libra | `LIBRA-ARIADNE-ITO-PIPELINE` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| libra | `LIBRA-CANONICAL-REVISION-ADOPT` | owner_authoritative | verified_supported | unverified | unverified |
| libra | `LIBRA-WORLD-MANAGER-STATE` | owner_derived | verified_supported | verified_supported | verified_supported |
| libra | `LIBRA-STATE-CORRECTION-JOURNAL` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| libra | `LIBRA-DUAL-WORLDLINE` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| libra | `LIBRA-RECALL-ENGINE` | owner_derived | verified_supported | unverified | unverified |
| libra | `LIBRA-EMBEDDING-VECTOR-LIFECYCLE` | owner_authoritative | verified_supported | unverified | unverified |
| libra | `LIBRA-PLANNER-RESPONSE-CONTEXT` | transient_cache | verified_supported | unverified | unverified |
| libra | `LIBRA-GRADIA-SGA` | transient_cache | verified_supported | verified_supported | verified_supported |
| libra | `LIBRA-INPUT-WRITER` | transient_cache | verified_supported | verified_supported | verified_supported |
| libra | `LIBRA-RAG-LORE-CBS` | transient_cache | verified_supported | verified_supported | verified_supported |
| libra | `LIBRA-CONFIG-PERSISTENCE` | local_configuration | verified_supported | intentionally_unsupported | intentionally_unsupported |
| libra | `LIBRA-MANUAL-RECOVERY` | owner_authoritative | verified_supported | unverified | unverified |
| libra | `LIBRA-SOURCE-EDIT-CONSENT` | owner_authoritative | verified_supported | unverified | unverified |
| libra | `LIBRA-WORLD-ADDITIONAL-RETIRED` | diagnostic | verified_supported | verified_supported | verified_supported |
| libra | `LIBRA-STORY-NARRATIVE-COMPAT` | archive_reference | verified_supported | verified_supported | verified_supported |
| libra | `LIBRA-PORTABLE-HANDOFF` | archive_reference | verified_supported | unverified | unverified |
| libra | `LIBRA-MAINTENANCE-DIAGNOSTICS` | diagnostic | verified_supported | verified_supported | verified_supported |
| libra | `LIBRA-GUI-OWNER-WRITES` | local_configuration | verified_supported | verified_supported | verified_supported |
| hayaku | `HAYAKU-INPUT-RECOGNITION` | transient_cache | verified_supported | unverified | unverified |
| hayaku | `HAYAKU-PACKET-CAPTURE` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| hayaku | `HAYAKU-SPEAKER-TURN-BOUNDARY` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| hayaku | `HAYAKU-CONTINUITY-PACKET-STORAGE` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| hayaku | `HAYAKU-TURN-WORLDLINE` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| hayaku | `HAYAKU-MISSING-PACKET-DETECTION` | owner_derived | verified_supported | verified_supported | verified_supported |
| hayaku | `HAYAKU-MANUAL-RECOVERY` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| hayaku | `HAYAKU-FAILED-ONLY-RECOVERY` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| hayaku | `HAYAKU-RECOVERY-VAULT-SHARDS` | owner_authoritative | verified_supported | unverified | unverified |
| hayaku | `HAYAKU-RECOVERY-LEASE-APPROVAL` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| hayaku | `HAYAKU-SOURCE-EDIT-SYNC-CONSENT` | owner_authoritative | verified_supported | unverified | unverified |
| hayaku | `HAYAKU-PACKET-DELETE-MAINTENANCE` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| hayaku | `HAYAKU-ARCHIVE-HANDOFF-EXCLUSION` | archive_reference | verified_supported | verified_supported | verified_supported |
| hayaku | `HAYAKU-BACKUP-EXPORT-IMPORT-RESTORE` | owner_authoritative | verified_supported | unverified | unverified |
| hayaku | `HAYAKU-LARGE-HISTORY-PACKET-SIZE` | owner_authoritative | verified_supported | unverified | unverified |
| hayaku | `HAYAKU-JSON-XML-ARTIFACT-PROTECTION` | transient_cache | verified_supported | unverified | unverified |
| hayaku | `HAYAKU-DIAGNOSTICS-AUDIT-LOGS` | diagnostic | verified_supported | verified_supported | verified_supported |
| hayaku | `HAYAKU-GUI-DURABLE-MUTATIONS` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-UA-CAPTURE` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-PENDING-CAPTURE-JOURNAL` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-RECORD-NORMALIZATION` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-EMBEDDING-GENERATION` | owner_derived | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-VECTOR-SIDECARS` | owner_derived | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-HYBRID-RECALL` | owner_derived | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-RECALL-GATES` | owner_derived | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-EPISODE-INDEX` | owner_derived | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-FILM-ARCHIVE-BROWSER` | owner_derived | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-SCOPE-CLASSIFICATION` | owner_derived | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-SCOPE-DELETE-CLEANUP` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-TURN-WORLDLINE` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-NATIVE-BRANCH-CLONE` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-SESSION-HANDOFF` | archive_reference | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-PORTABLE-BACKUP` | owner_authoritative | verified_supported | unverified | unverified |
| flashback | `FLASHBACK-COLDSTART-MAINTENANCE` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-EMBEDDING-MIGRATION` | owner_derived | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-SERVER-COMPUTE` | owner_authoritative | verified_supported | unverified | unverified |
| flashback | `FLASHBACK-DIAGNOSTICS-LOG` | diagnostic | verified_supported | verified_supported | verified_supported |
| flashback | `FLASHBACK-GUI-MUTATIONS` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| lia | `LIA-PERSONA-CREATE` | owner_authoritative | verified_supported | unverified | unverified |
| lia | `LIA-PERSONA-BIND` | owner_authoritative | verified_supported | unverified | unverified |
| lia | `LIA-LIVE-REFRESH` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| lia | `LIA-LIVE-CHECKPOINT` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| lia | `LIA-SAME-CHAT-RECOVERY` | owner_authoritative | verified_supported | unverified | unverified |
| lia | `LIA-BRANCH-INHERIT` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| lia | `LIA-BRANCH-STORAGE-MIGRATE` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| lia | `LIA-SESSION-HANDOFF` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| lia | `LIA-SOURCE-REVALIDATE` | owner_authoritative | verified_supported | verified_supported | verified_supported |
| lia | `LIA-PERSONA-RESTORE` | owner_authoritative | verified_supported | unverified | unverified |
| lia | `LIA-UI-PERSONA-OPS` | owner_authoritative | verified_supported | unverified | unverified |
| lia | `LIA-DIAG-INSPECT` | diagnostic | verified_supported | unverified | unverified |

## Shared-authority audit evidence (Tasks 13–16)

Executed by `PROGRAM/tests/storage_mode_owner_parity_audit_test.cjs` (81 assertions) and
`PROGRAM/tests/storage_mode_special_parity_gates_test.cjs` (48 assertions) for all four owners:

- `plugin_only`: zero Librarian backend requests for owner data (external LLM/embedding provider calls counted separately).
- `mirror` (legacy compatibility): previously stored local/server rows and reload behavior; not a selectable operational mode.
- `server_only`: zero local canonical writes; server value read back; unreachable server fails closed.
- Explicit user child mode (including `plugin_only`) survives reload and branch capability issue.
- A native-branch child view cannot overwrite a parent key or substitute a sibling scope in any mode.
- Retained retired local bytes are never adopted by a normal `server_only` read (R02).

These gates prove the **shared storage authority** for every owner. Per-feature
mirror/server_only semantic parity that is not listed as `verified_supported` remains
`unverified` and is tracked in `STORAGE_MODE_REMEDIATION_BACKLOG.md`.
