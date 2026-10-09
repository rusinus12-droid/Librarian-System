# Client probe display currentness

## Scope and provenance

Current-source integration: the reviewed corrected StorageSDK-only patch was applied at zero fuzz onto the adopted `flashback-pending-vector-candidate-20261005T0904Z/LIB` source in the isolated `client-probe-current-integration-20261005T1039Z` candidate. All bytes outside each embedded StorageSDK region remain identical across the five plugins; the common HealthSDK and current strict physical-repair logic, mutation tail, and receipts are preserved. This candidate remains unadopted pending parent acceptance. The historical results below describe the reviewed patch source; current-source and freshly emitted Full/Min verification is recorded in the integration handoff.

This isolated successor extends `client-probe-ui-candidate-20261005T1020Z`, itself based on reviewed `client-probe-status-integration-20261005T0824Z`. The first UI candidate failed independent review on range-selection ABA and remains untouched; use this successor for any further review. It is not an adopted package or a replacement for the subsequently adopted physical-repair source. Port only the StorageSDK probe/UI changes and tests to that newer source, resync its embeddings, and rebuild there. Preserve its HealthSDK and strict physical-repair mutations.

## Plan and reproduction

1. Mount the actual public `mountConnectionPanel` with fake DOM/transport and defer an integrity response.
2. Complete a newer probe/bootstrap, change selection/URL, dispose, or detach the panel; then release the old response.
3. Keep returned per-attempt diagnostics intact, but require attempt, connection, panel, and lifecycle currentness for display.
4. Sync both SDK variants into five Full plugins, build the five actual Min artifacts, execute extracted actual factories, and run relevant offline regressions.

The public export is `scopedMountConnectionPanel`; guarding only the older `mountConnectionPanel` would miss the user-facing bug. The new source test mounts the actual public export. Legacy callback cases explicitly bind the legacy implementation only in the test harness, without production test exports. The initial 60-case suite against the reviewed pre-fix source failed 54 cases and passed 6 control/already-safe cases. Independent review then identified missing range revision fencing and inaccurate initial aria attributes in the fake DOM. The realistic 84-case suite against the first UI candidate fails 8 ABA cases and passes 76; this successor passes 84/84. Both range directions, Storage and delayed Compute, single changes, ABA, and same-range controls are exercised.

## Implementation

A private WeakMap associates each returned probe result with a currentness receipt, without adding fields or changing per-attempt `ok`, `error`, timing, or connection diagnostics. Receipts capture accepted probe/bootstrap/binding generations and reject lifecycle disposal. Alternate-URL success is also fenced against a newer bootstrap.

Each panel captures its own attempt, input revision, selected URL/mode/range, and attachment. Input/change events invalidate even a change-away-and-back. Range buttons use click events, so setScopeTarget explicitly invalidates on an actual range change; clicking the already-selected range preserves a current attempt. Explicit messages invalidate an earlier display attempt. Before applying a result, the guard checks the receipt and current configured URL, then rechecks all tokens after that asynchronous read. The integrated Storage/Compute handler checks both before launching Compute and after Compute settles. Legacy manual, initial, and terminal-refresh probe callbacks use the same guards.

## Verification

- Source fake-DOM/transport suite: 84/84 pass. Covers overlapping successful/failing probes, configured/alternate URLs, bootstrap replacement, dispose, detached panel, mode/URL edits, ABA events, delayed Compute, and genuine current failure.
- Actual five Full plus five Min extracted SDK factories: 350/350 public mounted-UI cases pass. Factory extraction preserves the emitted self-reference name and does not substitute standalone SDK code. Legacy-only harness rebinding is omitted from emitted parity tests.
- Build: all 5 actual Min artifacts generated and syntax checked. HAYAKU exceeds the reporting-only historical size baseline by 2,406 bytes; no size threshold was weakened.
- Relevant runner: 19 suites selected, 17 pass, 2 fail. `docker_connection_contract_test.cjs` fails with `MEMORY_SUITE_DATA_INSTANCE_CONTRACT`; `server_connection_gui_contract_test.cjs` fails on `LIBRA.js side navigation`. Both reproduce on the untouched reviewed baseline. Neither was changed or treated as passing.
- Initial build/default-path regression attempts could not resolve acorn/jsdom. Reusing the existing offline toolchain resolves those environment failures. The initial emitted harness lost the minified self-reference; corrected harness passes 230 cases.
- No live providers, actual user data, network/security/authentication settings, server code, or adopted source were changed. A full 941-suite sweep is not claimed; the assigned task remains bounded to this client-only defect and relevant offline regressions.

## Commands

Set NODE_PATH to the existing `min-verification-20261004T2120Z/toolchain/node_modules` directory.

- `node --test LIB/PROGRAM/tests/sdk_probe_ui_currentness_client_test.cjs`
- `node verify-embedded-ui.cjs`
- In PROGRAM: `node tools/check_sdk_sync.cjs`
- In PROGRAM: `python run_regression_batch.py --match '*sdk*' --match '*connection*' --match '*global_storage*'`

The sibling evidence directory preserves RED/GREEN logs, actual artifact factory byte offsets/hashes, baseline failure logs, build logs, patches, and hash manifests.
