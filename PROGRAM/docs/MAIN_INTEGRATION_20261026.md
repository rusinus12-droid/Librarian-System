# Main integration — 2026-10-26

## Branch inventory

Remote main before integration: `d923d67`.

- `feat/explicit-reanalysis-review` (`50bbe3a`) was already an ancestor of main;
  it has no additional commits to merge.
- `fix/main-review-regressions-20261026` contributes `519f5e9` (module lore,
  model context capacity, canonical LIBRA storage SDK, runtime regression tests).
- `investigate/hayaku-connection-recovery-20261026` contributes `57ff68e`,
  `9948026`, and `88809e9` (recovery storage latency, owner recall guards,
  self-write snapshot currentness, replay diagnostics, and status refreshes).

Both unmerged branches are retained in the main ancestry. The merge has no text
conflicts. Source provenance and the program manifest are regenerated from the
combined plugin bytes and the combined LIBRA SDK, rather than either branch's
previous hashes. Branches are retained; no release or deployment is performed.

## Integration verification

Passed 19 test files on the combined source:

- `hayaku_recovery_storage_latency_runtime_test.cjs` (including slow HTTP/SQLite
  acknowledgement and readback, a bounded unacknowledged write, and no extra model call)
- `gradia/readonly-connection.test.cjs` (28 connection/currentness cases)
- `lore_collection_contract_test.cjs`
- `gradia/model-context-heuristic.test.cjs`
- `libra_owner_reset_recall_route_test.cjs`
- `hayaku_host_database_recall_runtime_test.cjs`
- `libra_unified_replay_diagnostic_runtime_test.cjs`
- `libra_current_status_refresh_runtime_test.cjs`
- `current_status_gui_runtime_test.cjs`
- `retrace_server_control_currentness_test.cjs`
- `libra_unified_lore_origin_identity_test.cjs`
- `libra_read_context_basic.test.cjs`
- `libra_offline_server_settings_save_test.cjs`
- `gradia/manual-skills.test.cjs`
- `sdk_variant_build_test.cjs`
- `gradia_manual_skills_gui_runtime_test.cjs`
- `hayaku_recovery_storage_error_surface_test.cjs`
- `plugin_version_byte_provenance_test.cjs`
- `plugin_version_provenance_contract_test.cjs`

SDK synchronization, syntax checks, manifest byte bindings, and diff whitespace
checks also pass. Fixtures are synthetic/offline, with temporary local servers
where needed; actual-host/model validation and the full publication gate are not
claimed. The exact cause of the uploaded LIBRA replay artifact mismatch still
requires the affected canonical record or the added replay diagnostics; its
integrity check remains enforced.
