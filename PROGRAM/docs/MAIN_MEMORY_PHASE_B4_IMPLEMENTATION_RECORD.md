# Main Memory Phase B4 implementation record

Date: 2026-09-26  
Branch: `codex/libra-worldmaker-remaining`  
Product source frozen for this B4 record: `Librarian-System/PROGRAM/plugins/LIBRA.js` SHA-256 `cbfb5eddc27ec13e19dfda828eac0ef663a376fd043929f73ca44bc5539eb974`.

## Runtime contract

The existing Librarian provider boundary receives a short promise summary, role-labelled participant names, and a request-local alias. It does not receive persistent person/lifecycle/fact/cursor/storage IDs. The alias is removed before canonical storage. `owner` means the person obligated to act; `target` means the addressee or beneficiary.

LIBRA seals v5 lifecycle metadata into canonical facts: `lifecycleId`, `linkStatus`, role-bound `participantIds`, and, for accepted links, a keyless `linkTarget` (`libra.thread_link_target.v2`) containing canonical origin/revision, artifact and source digests, active-lineage cursor, fact ID, participant roles, transition kind, target status, and lineage digest. `pending` carries a reason and no target; it remains an independent historical fact. State projects the latest lifecycle status, removes closed items from its active thread list, and preserves their canonical facts and History. Explicit `reopen` restores the same lifecycle; a similar new promise remains separate.

Recall grants v5 closure authority only to accepted lifecycle targets. It verifies the ref/body identity and schema, artifact digest, active prefix/revision, lifecycle, participant roles, kind/status/transition, anchor, and direct evidence before attaching a successor. It shares a 48-ref and 240-fact ceiling across discovery and target proof reads. A missing, stale, invalid, aborted, or over-budget proof does not become a closure row and reports `last-known` or `unknown` with a reason. v4 and pre-lifecycle v5 records retain their previous read meaning and are not automatically upgraded.

## Executed evidence

Every passing command below exited 0. Raw output includes the source hash. The portable evidence label is `phase-b4/`; the host artifact root is recorded in the supervisor snapshot, not in product source.

| Command | Mode and observed boundary | Evidence |
|---|---|---|
| `node tests/libra_main_memory_thread_lifecycle_boundary_matrix_test.cjs` | Actual provider-prompt-to-canonical-to-State-to-Recall/packet/History path in `plugin_only`, `mirror`, and `server_only`. Per mode: three batches; fulfilled, broken, cancelled, blocked-to-resolve, same-item reopen; similar new promise; same-title participant separation; mismatch/different-anchor/ambiguous/unknown/missing/stale alias; eight target/ref/body integrity cases; Recall 48-ref cap; abort after one proof read. | `matrix-target-proof-final.log` |
| `node tests/libra_main_memory_thread_lifecycle_transfer_test.cjs` | Actual two-batch lifecycle through native prefix copy, cold replay, immutable session handoff, and a new local batch. Single `plugin_only` fixture. Handoff keeps the active inherited source epoch (`-1`, turns 6–10); actual reopen is in epoch `0`, turns 1–5. Selected old record yields one forward closure and packet row; selecting the new record yields zero backward closures. Replay/provider calls: 0; canonical bytes unchanged. | `transfer-epoch-final.log` |
| `node tests/libra_main_memory_recall_successor_delivery_test.cjs` | Actual final Input Writer packet plus empty-store control in all three modes; selected record constrained to one so the later accepted outcome must arrive by closure. | `focused-successor_delivery_3mode.log` |
| `node tests/libra_main_memory_thread_lifecycle_e2e_test.cjs` | Actual accepted successor with both entity name and promise expression changed reaches Recall and the final Input Writer packet; cold replay preserves v5 bytes and History with no provider call. `plugin_only`. | `focused-thread_lifecycle_e2e.log` |
| `node tests/libra_main_memory_candidate_boundary_test.cjs` | Missing-alias successor remains pending; State remains open, Recall and packet closure counts are zero, currentness is `last-known`. `plugin_only`. | `focused-candidate_boundary.log` |
| `node tests/libra_main_memory_continuity_link_test.cjs` | Three actual committed artifacts use real request aliases and role-labelled participants. Same participants with different promise anchors remain separate; accepted fulfillment closes only its declared lifecycle; backward state is excluded while later possession changes still close forward. `mirror`. | `focused-continuity_link-accepted-alias.log` |
| `node tests/libra_main_memory_thread_identity_test.cjs` | Existing thread kind, link, reason, and participant validator contract. | `focused-thread_identity.log` |
| `node tests/libra_main_memory_v4_thread_binding_compat_test.cjs` | Legacy v4 binding behavior retained: canonical `f12`/`f14` remain readable; only the explicit thread is projected. | `focused-v4_thread_binding_compat.log` |
| `node tests/libra_main_memory_v5_schema_boundary_test.cjs` | v4 rejects v5-only thread fields and old stored bytes stay unchanged. | `focused-v5_schema_boundary.log` |
| `node tests/libra_main_memory_recall_currentness_test.cjs` | Existing currentness and uncertainty boundary in all three modes. | `focused-recall_currentness-rerun.log` |

The 48-ref budget/abort assertions use an actual committed lifecycle as the selected seed and a boundary helper with synthetic intervening refs/read callbacks. They verify the shared cap and cancellation behavior; they are not a 48-ref live storage stress benchmark. The source tamper/ref tests in the matrix mutate actual stored canonical records and then execute Recall and the final packet path.

## Acceptance scope and limits

| Original acceptance | B4 result |
|---|---|
| A11 — same-title promises, close one while the other stays open | Partial only: matrix proves same-title/different-participant lifecycles are separate; the full “close only one, leave the other open” original scenario is not exercised. |
| A12 — changed wording identifies the same item | Verified in the `plugin_only` E2E packet path. Not repeated across all three modes. |
| A13 — one initial promise across four independent sessions/branches with GUI, History, and Recall comparison | Not run. |
| A14 — reopen the exact closed item vs a similar new promise | Verified in the three-mode matrix, including lifecycle IDs and active State rows. |
| A15 — all future/inactive/self/cycle/sibling targets | Partial only: non-existent fact, stale lineage, stale revision absent from active prefix, mismatched anchor/evidence, and outer/inner schema corruption fail closed. Future, inactive-worldline, self, cycle, and sibling-target cases remain unverified. |
| A16 — optional candidate/alias-map pressure while preserving exact 5 U+A | Not run. Recall proof-read budgeting does not verify producer prompt pressure. |

The three-mode matrix is evidence for the cases it actually executes; it does not convert A11–A16 wholesale to PASS. The acceptance runner's prior aggregate counts are historical and its action accounting is not updated by this B4 record. Full product regression remains `PAUSED_BY_USER`. The controlled fixtures used the configured Librarian adapter boundary; no live external model trial was performed. Requested `gpt-6-luna/max` was not runtime-verified.

## Evidence corrections and remaining work

- Preserve `phase-b4-red-accepted-recall.log` as originally captured. It is an invalid RED: the assertion read `closure.text` although closure is a structured object, so the baseline defect was not established by that output. The attempt to restore and overwrite the baseline was rejected by automatic approval review; no retry or alternate overwrite was performed. The baseline for that exact probe remains unverified. The corrected GREEN is separate evidence and is not a retroactive RED.
- `matrix-anchor-red.log` is a valid captured pre-fix failure for the target-anchor authority path. `phase-b4-red-pending-recall.log` is the valid pending-state/zero-closure case; independent supervision confirmed the same test and source bytes.
- D05 remains open for candidate-context full-scan cost and abort checks: `buildContinuityCandidateContext` currently reads refs before applying its visible-40 limit and has no cancellation check. A16 candidate-pressure and the 100/1,000/10,000 final implementation benchmark remain separate work.
- Phase C remains: structured v5 preference/boundary items, exact replacement/removal/correction history, and lifecycle timeline projection.
- Phase D remains: 105-turn LETTER-LIFECYCLE, A04–A06 fault/race/outage paths, true 3×3 portable transfer, A43/A44 live checks, G02–G18 re-accounting, and final D05 thresholds.
- Phase E remains: self-contained acceptance fixtures, hanging-test cleanup, portability scan, version/release provenance, fresh full regression, and release/source checksums. The audit's hanging-test concern was not reproduced in the current snapshot; cleanup remains unverified.
