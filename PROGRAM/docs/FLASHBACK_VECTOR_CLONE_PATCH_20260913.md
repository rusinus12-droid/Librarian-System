# Flashback 1.0.74 vector clone patch and re-audit

The reproduced persona recovery path accepted missing source vector payloads and published copy completion with dangling source references. This patch physically reloads source payloads without trusting the decoded cache, rejects retained records with missing referenced or invalid hydrated vectors, and verifies the staged destination before publishing its worldline and completion manifest. Source commit/count/shard count are rechecked before publication. Pre-publication verification failures clean staged records/sidecars. Intentionally vectorless records without references remain accepted.

Portable backup version metadata now matches plugin version 1.0.74. No automatic embedding, live-source replacement, source-edit consent, or tracking-mode changes were introduced.

## Verification

- `flashback_clone_vector_integrity_test.cjs`: healthy destination-owned vectors; missing physical source with hot cache rejected; no false target completion; original manifest preserved; restored sidecar allows retry; destination payload removed after write prevents publication; rejected writes preserve source. PASS.
- `flashback_scope_registry_safety_test.cjs`: PASS.
- `source_tracking_modes_test.cjs`: 20 PASS.
- `source_tracking_audit_regressions_test.cjs`: F1/F2/F3 PASS.
- `source_edit_flashback_runtime_test.cjs`: 8 PASS.
- `source_edit_flashback_suffix_test.cjs`: 9 PASS.
- Syntax, program layout, distribution metadata coherence: PASS.
- Older `flashback_source_diff_transaction_v130_test.cjs`: timeout waiting for confirmation at line 14. Same timeout reproduced with vector-clone patch removed by the diagnostic source loader. This older test is not counted as passing.

## Limits and remaining recovery work

These are local VM/storage fault-injection checks, not live RisuAI, server, or provider tests. The historical cause of the attachment's 220 missing vector payloads is not established. This change prevents propagation; it does not restore already missing payloads. Verified backup recovery and explicit selective re-embedding of affected saved text remain separate recovery work requiring the physical data. No user data or paid embedding calls were touched. Manifest/worldline multi-write atomicity after publication begins is not expanded by this narrow patch. No release ZIP was rebuilt.
