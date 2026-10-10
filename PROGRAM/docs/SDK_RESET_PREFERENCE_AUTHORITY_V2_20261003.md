# Reset preference authority v2 (2026-10-03)

Base: `7080c72f66ed1933383526215c6f6197b7c4768e`. Scope is the two canonical SDK variants, SDK tests and this document. Product embedding and original-tree promotion belong to root.

## Approved behavior and outer qualification placements

The existing `memory_suite_reset_choice.<namespace>` row has URL/epoch/choice but no certified physical DATA authority. Its bytes remain untouched. A legacy row cannot authorize a reset read, change a scope mode, cause upload, or be upgraded from a current connection. Explicit choice writes use `memory_suite_reset_choice.v2.<namespace>` and schema `memory-suite.reset-choice.v2`, namespace, normalized requested URL, certified DATA instance ID, physical identity contract, certification flags and positive certified namespace reset epoch. LIBRA keeps its existing `owner_scope_deleted` and `deletedScopeIds` semantics only within that same authority.

`readResetChoice(connection)` reads and qualifies the v2 row against an already accepted, current connection and binding. It never calls bootstrap. It checks current URL and binding after native storage awaits; a cached row is not an independent capability. Reset cache invalidation clears the cached choice. The request guard already has its accepted connection, so it supplies that connection directly before any namespace request.

Cold scope recovery is qualified at the outer consumer, before using a choice to select server-only mode or suppress local fallback. `readScopeModeValue` first resolves/imports the scope registry, then qualifies a well-formed empty/deleted-scope v2 candidate for the current URL through bootstrap, then applies the existing override. Legacy, malformed, foreign-namespace/URL rows and healthy plugin-only operation with no recovery candidate cause no bootstrap. An upload choice alone does not trigger a cold plugin-only bootstrap or automatic upload. Global scope registry handling is unchanged.

`scopedGet` re-reads qualified authority before its empty-choice remote-only shortcut rather than consulting a raw cached row. `scopedSynchronizeSpace` and `scopedSetModeSafely` resolve their scope and perform the same outer recovery qualification before their empty/deleted-scope guards. Their later network requests retain ordinary currentness and reset guards. These placements avoid bootstrap recursion through the reader: bootstrap reads raw native arguments through `readConfig`, not scope modes. Explicit registered GUI reset choices remain reachable even when a legacy row is quarantined.

Preference publication is a same-runtime, per-namespace FIFO shared by bridge instances of one canonical SDK factory. HTTP bootstrap remains outside this queue. Each admitted choice retains its original URL/mode/DATA/contract/certification/generation/disposal intent and accepted connection. At the queue head it rechecks that intent and accepted connection before reading any previous qualified LIBRA choice, merging deletion state and writing. It holds the queue through native setItem, readback, post-await intent/currentness and exact row comparison. Rejection releases the queue; it never rolls back or deletes a row that could belong to a newer choice. A held old physical write may finish, but its A-scoped authority cannot admit B, and the later queued B commit leaves B's row. There is no cross-runtime CAS claim.

## Verification plan

Both variants use isolated real loopback HTTP servers and temporary physical DATA directories. Baseline RED preserves held A writes across same-URL B DATA replacement, newer B choice overwrite, and legacy preference authority. Candidate GREEN must cover FIFO across bridges, stale queued A refusal, failures releasing the queue, delayed readback/currentness fences, certified tuple rejection, cold empty/upload/deleted-scope behavior, exact raw retention and untouched legacy bytes. Existing 125 cases retain behavior assertions; owned preference assertions explicitly move to the new key and require the full v2 tuple. The actual registered Flash GUI and reset owner reconnect controls retain their timeouts and assertions. Guard preload forbids model, embedding and external transport.

No global installation inventory, whole-installation authority, product embedding readiness or cross-runtime publication guarantee is implied by this unit.

## Format and compatibility

The new row's required fields are `schema`, `namespace`, `url`, `dataInstanceId`, `dataIdentityContract`, `dataIdentityCertified`, `resetEpochCertified`, `epoch` and `choice`. IDs are strings matching the bootstrap's certified 32-character format; the contract is exactly `memory-suite.physical-data-identity.v1`; both certification flags must be true; epoch is a positive safe integer. A reader requires exact equality with the accepted connection's requested URL, DATA ID, contract and namespace epoch. A LIBRA deletion choice also requires nonempty string `deletedScopeIds`; it merges IDs only from a qualified preceding row inside the commit queue. A qualified empty row retains precedence over a later deletion choice. Namespace choices `empty` and `upload` retain their reload barrier. Neither row persistence nor reader qualification uploads data.

Legacy three-field rows have no physical DATA proof in any traced producer. They remain in their original key, including whitespace and raw byte representation, but do not confer reset authority. Ordinary transport to an uncertified legacy server is still governed by the existing SDK contract; explicit reset preference publication refuses uncertified DATA/reset maps rather than fabricating v2 identity. Malformed v2 rows are preserved and inactive until an explicit successful rechoice replaces the v2 row. A valid upload row can qualify a requested server operation after bootstrap, but alone does not enable or bootstrap a cold local scope.

The commit intent includes original namespace/URL, actual mode from the first forced native settings read, physical binding ID/contract/certification, generation and disposal. Pending publication proof fixes from 9edace/7080 remain unchanged. The latest accepted namespace epoch is compared before and after a preference write. Native host storage is unconditional: an already entered stale write can have a physical effect, so post-await refusal is not rollback. The row's DATA authority prevents that A row from admitting B; the same-runtime namespace queue orders a newer B commit after the old host call settles. Separate SDK factories/runtimes and host processes do not share this queue. Reload, crash and cross-runtime conditional publication require a separate host storage contract and are not claimed here.

## Preserved intermediate failure and correction

The first expanded run recorded 161 cases, 158 PASS and 3 FAIL: the standard competing-force positive, actual registered Flash GUI positive and unchanged full owner reconnect. Evidence-only replay of each failure showed `currentMissing:true`, `pendingNow:true`, unchanged URL/DATA/contract, certified binding, generation and intent generation both 2, original epoch 1 and `disposed:false`. The helper sampled pending before native settings/currentness awaits; a subsequent force started during those awaits. It now rewaits the actual pending that exists across the awaits and repeats the unchanged original intent and certified binding checks. Epoch comparison is synchronous only when no pending remains. It does not call bootstrap from the preference reader, relax generation, await its own bootstrap or reuse the old response in place of a forced HTTP request. Saved intermediate observations are not part of the final source or final execution preload.

## Exact commands and evidence

Run from `C:/Users/rusin/AppData/Local/Temp/LIB-server-authority-20261003/Librarian-System/PROGRAM`:

```powershell
$env:NODE_OPTIONS='--require=C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs'
$env:NODE_PATH='C:/Users/rusin/AppData/Local/Temp/LIB-WM-Recovery-20261002/test-deps/node_modules'
$env:RECOVERY_NETWORK_LOG='evidence-server-authority/sdk-preference-network-guard.jsonl'
$env:SDK_PREFERENCE_SOURCE_BASE=''
$env:SDK_INTENT_SOURCE_BASE=''
$env:SDK_OVERLAY_FILE=''
$env:SDK_PREFERENCE_EVIDENCE_DIR='evidence-server-authority/sdk-preference-final-GREEN-http'
$env:SDK_INTENT_EVIDENCE_DIR='evidence-server-authority/sdk-preference-final-intent-http'
$env:SDK_SEQUENCE_EVIDENCE_DIR='evidence-server-authority/sdk-preference-final-sequence-http'
$env:SDK_RESET_EVIDENCE_DIR='evidence-server-authority/sdk-preference-final-reset-http'
& 'C:/Program Files/nodejs/node.exe' --require ./evidence-server-authority/sdk-canonical-flashback-overlay.cjs --test --test-concurrency=1 --test-reporter=tap --test-timeout=60000 tests/sdk_reset_preference_authority_runtime_test.cjs tests/sdk_reset_intent_readset_runtime_test.cjs tests/sdk_reset_bootstrap_sequence_runtime_test.cjs tests/sdk_reset_refusal_availability_runtime_test.cjs tests/sdk_data_instance_binding_runtime_test.cjs tests/sdk_lifecycle_hardening_test.cjs tests/sdk_integration_test.cjs tests/server_data_instance_identity_runtime_test.cjs tests/memory_suite_durable_job_data_pin_runtime_test.cjs tests/namespace_reset_runtime_test.cjs tests/namespace_reset_recovery_test.cjs tests/reset_owner_reconnect_test.cjs
```

The overlay substitutes canonical SDK bytes in the registered product fixture in memory; it writes no product or original file. The owned sequence and intent assertions explicitly use the v2 key and compare the full authority tuple; the unchanged owner reconnect test preserves its behavioral assertions and timeout. The registered Flash callback control additionally seeds a URL/epoch-only legacy row and verifies those exact bytes survive its explicit GUI rechoice. Its endpoint allowlist rejects model, embedding and external routes.

For exact baseline RED, set `SDK_PREFERENCE_SOURCE_BASE` to the pinned base above, use a distinct evidence directory, omit the overlay and run only `tests/sdk_reset_preference_authority_runtime_test.cjs` with the same test flags. `sdk-preference-baseline-RED.log` preserves the original 36-case RED; `sdk-preference-final-baseline-RED.log` uses the final expanded fixture. `sdk-preference-scoped-GREEN.log` preserves the intermediate 158/3 refusal. `sdk-preference-fence-observation` and `sdk-preference-owner-fence-observation` logs/JSON preserve the independent actual field traces. `sdk-preference-corrected-positive.log` records all four corrected existing controls (including the unchanged owner reconnect). Final proof is recorded separately in `sdk-preference-final-scoped-GREEN.log` and its four HTTP directories; `sdk-preference-proof-index.json` pins source and every supporting artifact hash.
