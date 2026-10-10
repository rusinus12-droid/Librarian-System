# Queued reset choice retains its original target

Base: `c4e05e3534a0ccc6e30ead6250d9455591ce93e3`. This independent follow-up changes the two canonical SDK templates and adds one bounded actual HTTP/SQLite test. Product embedding is a separate root integration unit.

## Reproduced regression

Independent review of c4 held a real bootstrap response from server A while `acceptServerReset('empty')` queued behind it. A and B were distinct physical DATA directories, both with `flashback:1`. After switching to B and explicitly bootstrapping B, releasing A made the queued choice persist `{epoch:1,url:B,choice:'empty'}` in both variants. The choice had started for A. Canonical 542 refused the same destination-switch control without writing a preference. c4's recursive forced refresh discarded the invocation target and read the new configuration after its wait.

The new frozen test reads exact c4 Git blobs into its VM without changing source files: **20 cases, 6 PASS / 14 FAIL**. Both already-reset-destination cases and the additional immediate host URL switch during the action's initial config read fail on c4. The 542 destination-switch replay remains **2 PASS / 0 FAIL**. Prior c4 93 PASS and 542 75 cases / 74 PASS / 1 FAIL records are preserved; they did not cover this cross-target regression.

## Captured readset and publication

An explicit reset action captures an already-known URL and physical binding before its first await. Its mode is pinned from the first actual forced configuration read. The snapshot includes namespace, URL, mode, binding generation, DATA instance ID, certification, identity contract and rejection state. Forced recursion carries the same intent instead of choosing a new target. Before fresh dispatch and response publication, and before preference write and after readback, the SDK checks this intent against current settings, binding and disposal.

An initially unknown DATA binding may be pinned only by a successful, still-current, original-target bootstrap result whose adoption accounts for one generation increment. A failed pending response supplies no binding proof. A new valid request for the unchanged target can still establish DATA and accept the explicit reset choice. Established bindings keep their generation, DATA, certification and contract fences. Queueing continues to dispatch a fresh HTTP request for every force caller; no FIFO fairness claim is made.

Only the new intent-fence rejection bypasses availability-error normalization. It retains `MEMORY_SUITE_CONNECTION_STALE` and the existing pending cleanup, rather than matching the broad transport substring `connection` and creating a URL-wide outage. Actual transport failures retain the existing retry/outage behavior. Metadata validation, epoch headers, explicit choices, reload requirement, authentication and timeouts are unchanged.

## Preserved positive controls and policy correction

The first final scoped run was **113 cases, 112 PASS / 1 FAIL**. Its existing registered Flashback GUI control revealed an over-refusal: synchronous capture used cached mode `mirror`, but the first actual scoped configuration read returned `plugin_only`. URL, DATA, certification, identity contract, generation 2 and disposal were unchanged. An evidence-only preload added these failed-fence fields to the error message without changing control flow.

The correction keeps the synchronous known URL/binding pin and captures mode from that first actual configuration read. It does not relax generation or physical identity. The existing GUI assertion and timeout remain intact. Actual mode changes after capture still refuse both while waiting and during the fresh HTTP response. The 38-case focused run (new 20 plus existing sequence 18) passes after this correction. The failed 113-case run and the GUI observation are retained.

The new test covers both canonical variants with isolated local HTTP/SQLite servers: two already-reset destinations; immediate URL switch during initial config read; failed initial metadata followed by a valid same-target fresh request; failed initial metadata followed by changed target; explicit same-URL settings generation change; explicitly adopted different physical DATA at the same URL; mode changes during pending and fresh HTTP; disposal; and initially uncertified binding with one initial request, an explicit-choice request and two additional forced requests. The last control requires all four callers to fulfill with four separately dispatched responses and preserves the reload refusal.

The final named 11-file run is **113 cases, 113 PASS / 0 FAIL**, including these 20 cases and the previous 93. Its canonical-SDK overlay also runs the unchanged full Flashback reset-owner workflow and the actual registered GUI reset button. The overlay replaces only SDK bytes in a fixture VM string and writes no product or existing test. Final counts and source hashes are pinned in `evidence-server-authority/sdk-intent-proof-index.json`.

## Exact commands and evidence

Run from `Librarian-System/PROGRAM` in the isolated clone:

```powershell
$env:NODE_OPTIONS='--require=C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs'
$env:NODE_PATH='C:/Users/rusin/AppData/Local/Temp/LIB-WM-Recovery-20261002/test-deps/node_modules'
$env:RECOVERY_NETWORK_LOG='evidence-server-authority/sdk-intent-network-guard.jsonl'
$env:RECOVERY_TEST_LABEL='SDK original intent certified final scoped GREEN'
Remove-Item Env:SDK_INTENT_SOURCE_BASE -ErrorAction SilentlyContinue
Remove-Item Env:SDK_OVERLAY_FILE -ErrorAction SilentlyContinue
$env:SDK_INTENT_EVIDENCE_DIR='evidence-server-authority/sdk-intent-certified-final-GREEN-http'
$env:SDK_SEQUENCE_EVIDENCE_DIR='evidence-server-authority/sdk-intent-certified-final-sequence-http'
$env:SDK_RESET_EVIDENCE_DIR='evidence-server-authority/sdk-intent-certified-final-reset-http'
& 'C:/Program Files/nodejs/node.exe' --require ./evidence-server-authority/sdk-canonical-flashback-overlay.cjs --test --test-concurrency=1 --test-reporter=tap --test-timeout=60000 tests/sdk_reset_intent_readset_runtime_test.cjs tests/sdk_reset_bootstrap_sequence_runtime_test.cjs tests/sdk_reset_refusal_availability_runtime_test.cjs tests/sdk_data_instance_binding_runtime_test.cjs tests/sdk_lifecycle_hardening_test.cjs tests/sdk_integration_test.cjs tests/server_data_instance_identity_runtime_test.cjs tests/memory_suite_durable_job_data_pin_runtime_test.cjs tests/namespace_reset_runtime_test.cjs tests/namespace_reset_recovery_test.cjs tests/reset_owner_reconnect_test.cjs
```

For the read-only c4 RED, set `SDK_INTENT_SOURCE_BASE` to the exact base above, set `SDK_INTENT_EVIDENCE_DIR` to a new evidence directory, omit the overlay, and run only `tests/sdk_reset_intent_readset_runtime_test.cjs` with the same flags. For the 542 destination control set it to `542d823d85e73fee6cf2d4a7c360df39d86bdf4b` and add `--test-name-pattern='queued explicit choice for reset A'` before that filename.

Frozen final logs are `sdk-intent-frozen-c4-RED.log`, `sdk-intent-542-destination-control.log` and `sdk-intent-certified-final-scoped-GREEN.log`. Per-case events and outcome/preference JSON are under `sdk-intent-frozen-c4-RED-http` and `sdk-intent-certified-final-{GREEN,sequence,reset}-http`. The over-refusal record is `sdk-intent-frozen-final-scoped-GREEN.log` (112/1), with `sdk-intent-GUI-readset-observation.{log,cjs}` and its HTTP directory; its observation preload is not used for final verification. Earlier intermediate logs remain separately named.

The network guard is active for every Node invocation; the violation log has zero events. Final GUI denied-transport evidence is an empty array. Both SDKs and the new test pass syntax checks; `git diff --check` passes. No existing assertion or timeout was changed.

Product embedding and installation acceptance remain UNRUN, pending root exact synchronization and review. Whole-installation inventory, global authority publication/currentness, full repository suite, release build and native RisuAI GUI remain UNRUN. Models, real embeddings, external services and original workspace writes were not used.
