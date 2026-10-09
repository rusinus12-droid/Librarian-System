# First settings read retains original pending certification proof

Base: `d90421e21bf83e10382109b88c48691a650b1416`. This bounded follow-up changes both canonical SDKs, extends the existing reset-intent test by six cases, and leaves product embedding to root.

Independent review held the first-ever local server A bootstrap response, started an explicit reset choice, and held that choice's first native mode read. The original bootstrap then completed and certified the same DATA before the mode read resumed. d904 rejected the choice with `MEMORY_SUITE_CONNECTION_STALE`: its captured unknown binding had generation 1, while ordinary initial certification had moved the unchanged original target to generation 2. c4 fulfilled both callers with two fresh HTTP requests. No URL, mode, settings, physical DATA or disposal change occurred.

The owned reproduction loads exact d904 Git blobs without source mutation: **26 cases, 24 PASS / 2 FAIL**, with only the positive first-read certification cases failing. The exact c4 positive controls are **2 PASS / 0 FAIL**. All 20 original intent assertions are preserved.

## Narrow publication proof

At synchronous reset-intent capture, an initially unbound invocation captures the exact original-target pending promise and bootstrap sequence. A fulfillment handler installed before the first native settings await accepts a result only when that promise publishes its own cache value at the captured sequence. Failure yields no proof. A later current cache or unrelated probe cannot supply this result.

After the first actual settings read, the original intent can adopt this captured result only while its current binding has the same original URL, returned DATA ID, certification and identity contract, is not rejected or disposed, and has exactly the expected one-generation certification increment. The next intent assertion still checks current namespace, URL, mode and binding. Established generation guards are unchanged. A later ordinary same-target forced refresh may proceed with its own fresh response; this unit neither reuses the certification response as the choice response nor promises force FIFO fairness.

Each SDK adds six logic lines and two comments, and strengthens the existing initial-pin predicate with current rejection/disposal and identity-contract checks. Preference fields, preference writes, reset epoch headers, choice policy, timeout and reload behavior remain unchanged.

## Verification

The six added cases cover both variants: normal original certification during the first native settings read still completes with two fresh HTTP requests; switching to a distinct already-reset B during that read refuses without another B dispatch or preference; explicitly resetting same-URL settings generation during that read refuses. The host read gate delays a real fixture argument API return while the server uses actual local HTTP/SQLite; it fabricates neither DATA identity nor bootstrap success.

Focused intent plus sequence controls: **44 PASS / 0 FAIL**. Final exact 11 named files: **119 PASS / 0 FAIL**, retaining the prior 113 assertions including unknown-first-certification four-call fresh/no-drop, both already-reset destinations, mode changes during pending and HTTP, DATA replacement, disposal, metadata/transport classification, registered GUI, and the unchanged full reset-owner workflow. No existing assertion or timeout was lowered.

Final GUI denied transport is `[]`; the preload guard records zero violation events. Both SDKs and the extended test pass syntax checks, and `git diff --check` passes. The evidence-only canonical Flashback overlay replaces SDK bytes in a VM source string and changes no embedded product or existing test. This is an isolated canonical control, not installation acceptance.

## Exact final command

Run from `Librarian-System/PROGRAM` in the isolated clone:

```powershell
$env:NODE_OPTIONS='--require=C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs'
$env:NODE_PATH='C:/Users/rusin/AppData/Local/Temp/LIB-WM-Recovery-20261002/test-deps/node_modules'
$env:RECOVERY_NETWORK_LOG='evidence-server-authority/sdk-first-read-network-guard.jsonl'
$env:RECOVERY_TEST_LABEL='SDK first read exact pending proof final scoped GREEN'
Remove-Item Env:SDK_INTENT_SOURCE_BASE -ErrorAction SilentlyContinue
Remove-Item Env:SDK_OVERLAY_FILE -ErrorAction SilentlyContinue
$env:SDK_INTENT_EVIDENCE_DIR='evidence-server-authority/sdk-first-read-final-GREEN-http'
$env:SDK_SEQUENCE_EVIDENCE_DIR='evidence-server-authority/sdk-first-read-final-sequence-http'
$env:SDK_RESET_EVIDENCE_DIR='evidence-server-authority/sdk-first-read-final-reset-http'
& 'C:/Program Files/nodejs/node.exe' --require ./evidence-server-authority/sdk-canonical-flashback-overlay.cjs --test --test-concurrency=1 --test-reporter=tap --test-timeout=60000 tests/sdk_reset_intent_readset_runtime_test.cjs tests/sdk_reset_bootstrap_sequence_runtime_test.cjs tests/sdk_reset_refusal_availability_runtime_test.cjs tests/sdk_data_instance_binding_runtime_test.cjs tests/sdk_lifecycle_hardening_test.cjs tests/sdk_integration_test.cjs tests/server_data_instance_identity_runtime_test.cjs tests/memory_suite_durable_job_data_pin_runtime_test.cjs tests/namespace_reset_runtime_test.cjs tests/namespace_reset_recovery_test.cjs tests/reset_owner_reconnect_test.cjs
```

For d904 RED set `SDK_INTENT_SOURCE_BASE` to the exact base, use a new `SDK_INTENT_EVIDENCE_DIR`, omit the overlay, and run only `tests/sdk_reset_intent_readset_runtime_test.cjs` with the same flags. For the c4 positive set it to `c4e05e3534a0ccc6e30ead6250d9455591ce93e3` and add `--test-name-pattern='first original pending certification'` before the filename.

Frozen logs: `sdk-first-read-d904-RED.log`, `sdk-first-read-c4-positive.log`, `sdk-first-read-focused-GREEN.log`, and `sdk-first-read-final-scoped-GREEN.log`. Their HTTP/host-mode-read/outcome JSON is under the correspondingly named `sdk-first-read-*` directories. `sdk-first-read-proof-index.json` pins this unit's source, commands and evidence separately from preserved 542/c4/d904 records.

## Remaining reset preference findings

Independent review also found inherited preference publication problems. A delayed A preference write can leave a `{epoch,url,choice}` row that authorizes distinct DATA B at the same URL/epoch after the A action itself rejects. A delayed older A write can overwrite a newer successful B choice at a different URL on both c4 and d904; c4 rejects readback while d904 rejects currentness, but both have the stale physical row. These findings are not repaired in this unit. Root requested a separate proposal for DATA-scoped preference authority and same-runtime namespace write serialization, with legacy bytes preserved or quarantined and no blind upgrade or erase.

Independent candidate review remains required. Product embedding, whole-installation inventory/global authority, release/build and native RisuAI acceptance remain UNRUN. Models, real embeddings, external services and original workspace writes were not used. No global reset-readiness claim follows from this unit's 119 PASS.
