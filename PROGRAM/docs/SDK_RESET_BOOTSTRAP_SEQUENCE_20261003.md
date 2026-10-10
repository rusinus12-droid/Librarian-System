# Explicit reset choice and overlapping forced bootstrap

Base: `542d823d85e73fee6cf2d4a7c360df39d86bdf4b`. This independent SDK unit follows the narrow reset-refusal availability classification fix. It changes only the two canonical SDK templates and adds one scoped runtime test. Product embedding remains a separate integration unit owned by root.

## Actual failure and attribution

The unchanged `reset_owner_reconnect_test.cjs` starts the full Flashback host fixture, saves old raw/vector memory through the owner, resets the real local HTTP/SQLite namespace, and calls `acceptServerReset('empty')`. It failed with `MEMORY_SUITE_CONNECTION_STALE` inside bootstrap's response publication check.

Read-only source observation records the caller and sequence at every dispatch, cache reset, probe adoption and completion. The unmodified embedded SDK first dispatched reset acceptance at sequence 5. An outstanding shard read then received HTTP 409 `MEMORY_SUITE_RESET_RECONNECT_REQUIRED`; the old availability classifier reset the bootstrap cache. A background `retireExternalRecordsForScope` task subsequently entered `withFlashbackWriter`'s final release and forced another bootstrap. The acceptance response carried `flashback:1`, the current URL, and `disposed:false`, but its sequence had been superseded.

Replacing only the embedded SDK **in memory** with exact canonical base 542 removed the HTTP 409 cache poisoning. The same failure still occurred: reset acceptance sequence 5 competed with writer release sequence 6. Both URLs were identical. Neither auto scope scan nor observational probe adoption appeared as the competing caller in this trace. This is separate from the Flashback owner's worldline timer unit; no owner source file was changed.

Evidence: `evidence-server-authority/reset-reconnect-causal-probe.cjs`, `reset-reconnect-causal.{json,log}`, and `reset-reconnect-causal-542.{json,log}`. The observation modifies a temporary VM source string, retains production control flow, and is not a product artifact.

## Minimal behavior change

When a force bootstrap encounters a pending bootstrap at the same URL, it waits for that pending attempt to settle, then calls bootstrap again with `force:true`. It does not use the old response as its own force result. Each force caller still dispatches a new HTTP request and reads a fresh reset epoch. Multiple waiters re-read the pending state, so a second or third force caller waits for the new request created by the first resumed waiter.

The original pending caller retains its success or rejection. A failure does not permanently poison queued force calls: their independently dispatched requests retain the existing metadata validation and transport classification. URL, physical DATA identity, sequence, disposal, reset choice persistence/readback, and reload checks are unchanged. Writer acquire/release behavior, namespace epoch headers, authentication retry, request timeouts, and HTTP 409 classification remain unchanged. Queue latency includes the existing request wait for preceding refreshes; this unit makes no performance claim or FIFO fairness guarantee.

## Verification and limits

The frozen final test file on canonical base 542: **36 cases, 25 PASS / 11 FAIL**. This consists of the new 18 cases and the existing 18 physical binding cases. The final candidate's scoped integration control: **93 cases, 93 PASS / 0 FAIL**, across the exact ten named files below.

New actual local HTTP controls cover both SDK variants: reset choice versus competing force; a held pre-reset response followed by a separately dispatched epoch-1 response; three force waiters, each with a fresh request and sequential delivery; rejected old metadata followed by a healthy fresh/peer request; fresh transport failure and the shared outage circuit; queued URL switch; physical DATA replacement at the same URL; disposal before preference publication. The original held binding, auth rotation, DATA replacement, URL switch, and disposal controls also pass. No timeout or existing assertion was changed.

The standard template additionally runs the existing full Flashback reset workflow and a registered Flashback GUI control. The GUI control observes the actual host setting callback, opens the real server tab in jsdom, invokes the bound reset-empty button while another force request is queued, then proves exact `{epoch:1,url,choice:'empty'}` persistence, a success message, and the reload refusal. The full workflow seeds a raw/vector record through the owner and proves that a new runtime reads an empty reset server while retaining the old local raw memory. GUI transport uses only the fixture server and records zero attempted model/embedding/external routes.

`sdk-canonical-flashback-overlay.cjs` is an evidence-only preload that inserts exact canonical SDK bytes into the existing fixture's VM source string. It writes neither plugin files nor test assertions. The **unchanged** `reset_owner_reconnect_test.cjs` with this preload is **0 PASS / 1 FAIL** on canonical 542 (`MEMORY_SUITE_CONNECTION_STALE`), and **1 PASS / 0 FAIL** on the candidate. The ten-file integration run uses that same preload. Thus its 93 PASS is a canonical-SDK integration control, not a claim that the installation's embedded SDKs have already been synchronized. The earlier 542 record of 75 cases / 74 PASS / 1 FAIL remains preserved.

Guard preload is active for every Node invocation. The final guard violation log is absent (zero violation events); final GUI denied-transport evidence is an empty array. No actual model or embedding service, external network, native RisuAI GUI, release build, or full repository suite was run. Global installation inventory, closed-scope owner adapters/UI, full global authority publication/currentness, and five-product embedding/promotion remain outside this unit.

### Exact final scoped command

Run from `Librarian-System/PROGRAM` in the isolated clone:

```powershell
$env:NODE_OPTIONS='--require=C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs'
$env:NODE_PATH='C:/Users/rusin/AppData/Local/Temp/LIB-WM-Recovery-20261002/test-deps/node_modules'
$env:RECOVERY_NETWORK_LOG='evidence-server-authority/sdk-sequence-network-guard.jsonl'
$env:RECOVERY_TEST_LABEL='SDK sequence final scoped GREEN'
$env:SDK_SEQUENCE_EVIDENCE_DIR='evidence-server-authority/sdk-sequence-final-scoped-GREEN-http'
& 'C:/Program Files/nodejs/node.exe' --require ./evidence-server-authority/sdk-canonical-flashback-overlay.cjs --test --test-concurrency=1 --test-reporter=tap --test-timeout=60000 tests/sdk_reset_bootstrap_sequence_runtime_test.cjs tests/sdk_reset_refusal_availability_runtime_test.cjs tests/sdk_data_instance_binding_runtime_test.cjs tests/sdk_lifecycle_hardening_test.cjs tests/sdk_integration_test.cjs tests/server_data_instance_identity_runtime_test.cjs tests/memory_suite_durable_job_data_pin_runtime_test.cjs tests/namespace_reset_runtime_test.cjs tests/namespace_reset_recovery_test.cjs tests/reset_owner_reconnect_test.cjs
```

The frozen-base replay command is `node evidence-server-authority/run-sequence-baseline-red.cjs` with the same guard/dependencies. It restores source bytes in `finally`, runs the two named files, and writes the final RED log and per-scenario HTTP records. The unchanged test control is the same final command with only `tests/reset_owner_reconnect_test.cjs`; for BASE, additionally set `SDK_OVERLAY_FILE` to `evidence-server-authority/MemorySuiteStorageClient.source.js.SEQUENCE-BASE-542`. Clear that variable for candidate runs.

Final logs: `sdk-sequence-frozen-BASE-RED.log`, `sdk-sequence-final-scoped-GREEN.log`, `sdk-sequence-unchanged-reset-owner-overlay-BASE-RED.log`, and `sdk-sequence-unchanged-reset-owner-overlay-GREEN.log`. JSON HTTP/choice/outcome records are under `sdk-sequence-frozen-BASE-RED-http` and `sdk-sequence-final-scoped-GREEN-http`. The unit evidence index pins files, hashes, commands, and this unit's source commit separately from prior migration and 542 evidence.

### Retained fixture corrections

Initial test/probe logs are retained as diagnostic history. A first prototype incorrectly installed the LIBRA-only template in the full Flashback owner, whose required `withFlashbackWriter` API it does not provide. Full Flashback tests now use the standard template; both canonical variants keep the direct HTTP queue and binding tests. A prototype cleanup used nonexistent `app.config.dataDir`; it now uses the returned `app.dataDir`, and the orphaned scoped test process was interrupted. A disposal fixture initially left native response bodies unconsumed, allowing real `AbortError` code 20. The held-response fixture now freezes the actual HTTP body before delivery; disposal still accepts a real native fetch abort for requests not held by the fixture, while requiring rejection, no preference publication, and a noncurrent binding. The first GUI prototype used the native fixture's default `enable_gui:false`; the GUI control now explicitly enables registration. These fixture corrections did not change any existing test, production timeout, reset choice, physical binding, or epoch fence.
