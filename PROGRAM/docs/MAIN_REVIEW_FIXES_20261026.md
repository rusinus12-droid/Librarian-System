# Main review regression fixes — 2026-10-26

Base: `d923d67` (`36fcba7`, `11fa816`, and `d923d67` reviewed).

## Changes

- LIBRA and GRADIA now keep module/persona entities intact in `collectionFrom`.
  Only `loreCollectionFrom` unwraps lorebook containers. Selected modules retain
  their identity, enabled state, catalog entries, and reference candidates.
  Unselected/disabled modules remain excluded; nested character/module books and
  persona embedded modules continue to work.
- GRADIA resolves GPT-4.1, mini, nano, dated, and provider-prefixed identifiers
  before legacy GPT-4. Without manual/catalog metadata, the balanced reference
  budget was incorrectly reduced from 96,000 to 1,000 characters; it now retains
  the configured profile. Manual and matching catalog limits still take priority.
  Unknown GPT-4 variants stay unverified rather than inheriting the legacy 8K
  limit. Gemini 2.5 Pro no longer inherits the 2M Gemini 1.5/2.0 Pro estimate.
- The LIBRA canonical storage SDK now includes the existing embedded local-only
  settings policy and device scope-registry fallback. A normal SDK sync retains
  both changes and leaves all six plugin bodies unchanged.
- Replaced the lore contract test's CRLF requirement and copied implementations
  with runtime checks against both plugins' actual collectors.

## Verification

Before the fixes, the replacement lore test failed for both plugins (the module
ID became its child lore ID), and GPT-4.1 capacity was 1,000 instead of 96,000
characters. After the fixes, these and the existing module-origin regression pass.

Passed test files:

- `lore_collection_contract_test.cjs`
- `gradia/model-context-heuristic.test.cjs`
- `libra_unified_lore_origin_identity_test.cjs`
- `sdk_variant_build_test.cjs`
- `libra_read_context_basic.test.cjs`
- `libra_offline_server_settings_save_test.cjs`
- `gradia/manual-skills.test.cjs`
- `gradia/lore-activation-scale.test.cjs`
- `libra_lore_unified_activation_runtime_test.cjs`
- `libra_lore_unified_semantic_retrieval_test.cjs`
- `gradia_manual_skills_gui_runtime_test.cjs`
- `gradia/model-context-budget.test.cjs`
- `plugin_version_byte_provenance_test.cjs`
- `plugin_version_provenance_contract_test.cjs`

SDK synchronization and plugin syntax checks also pass. Tests use synthetic/offline
fixtures; actual-host verification and deployment are not included. These fixes
and the earlier HAYAKU recovery/connection and LIBRA recall changes are combined
in the main integration documented in `MAIN_INTEGRATION_20261026.md`.
