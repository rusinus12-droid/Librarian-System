# Flashback completed scan with pending repair

An automatic maintenance operation can finish executing while a failed embedding
job still needs the existing explicit retry action. A synthetic zero-vector
response reproduces this distinction in the actual API and registered GUI:
`healthy=false`, one missing vector, `failed_requires_retry`, and zero provider
submissions by subsequent automatic maintenance. The old GUI nevertheless used
a success-colored completed badge and a recovery-completed dialog title. Its
last detail line correctly said that further checking was needed.

This change displays `점검 완료 · 복구 대기` with warning tone for an explicitly
unhealthy completed result, explains how to use `실패 작업 재시도`, and retains
verified healthy completion as success. Missing or non-boolean journal health
is displayed as `점검 완료 · 결과 확인 필요`. The existing journal lifecycle
still records `completed`. Its already-admitted diagnostic `result.reason`
carries `failed_requires_retry`; the generic operation-log sanitizer is unchanged.

No retry, source consent, raw/vector publication, lineage, receipt authority,
SDK, or provider policy changes. Automatic maintenance still makes no new attempt
for known failed work. Only the supported explicit retry creates an attempt.

## Scope and baseline

- Private clone: `Temp/LIB-Flashback-Maintenance-Outcome-20261003`.
- Branch: `recovery/flashback-maintenance-outcome-20261003`.
- Base: `be2237234c9e9b1e33418567562b14d016d20ac2`.
- Base Flashback SHA256: `debec5c4955bc5db830768a4204fdf35df322e8107145e10fe530f5386b498d2`.
- Final product SHA256: `322afdc10e7a9cb492ce33a94ae4d406d32ca461bbd77ebf749b77522a51da47`.
- Owned paths: `plugins/Flashback_Memory.js`,
  `tests/flashback_maintenance_outcome_gui_runtime_test.cjs`, and this document.
- Original and frozen atomic candidate were not edited. Embedded Storage,
  Compute, lineage, source-review and consent SDK bytes remain the base bytes.

## Evidence

The pre-edit diagnosis is sealed at
`Temp/Flashback-Automatic-Maintenance-Recurrence-Diagnosis-20261003/diagnosis-frozen.json`,
SHA256 `2db27ba400490f5149e8adbfb11bf2ccbd6b0c3bf98bc63ad7f36bb8b91cc390`.
It pins the original `4ae11a2` / Flashback `4dafb3c8…` and actual atomic
`be223723` / Flashback `debec5c4…` controls, with all exploratory failures retained
and labeled as obsolete fixture assumptions, unsupported retry/consent
assumptions, or harness errors rather than product loss.

Both exact sources passed the classified API probe: explicit failed-work retry
resolved the zero-vector job; later inspect and automatic maintenance were
healthy `no_action`, retained the same manifest commit, and submitted no more
synthetic vectors. Shard-index and episode-index repair likewise remained
healthy on repeated inspection and automatic maintenance. A real live edit was
correctly detected and required specific source-edit consent.

The named GUI test first produced **1 PASS / 2 FAIL** on the untouched atomic
base: unhealthy and unknown completed states used success tone, while actual
healthy recovery already passed. The first display change produced **2 PASS /
1 FAIL** because the generic journal sanitizer omitted a new diagnostic field.
The final change uses its existing `reason` field. A further narrow strict-health
control produced **0 PASS / 1 FAIL** when a non-boolean legacy verdict was
coerced to success. Journal-only normalization now omits such a verdict.
The final named GUI test is **3 PASS / 0 FAIL**. It invokes actual
`bindUiEvents`, dialogs and execution rendering, preserves all failed/prior
record bytes and literal host text, proves zero extra automatic submissions,
executes the supported explicit retry, and verifies stable subsequent `no_action`.

Logs and the final handoff are in
`Temp/Flashback-Maintenance-Outcome-Proof-20261003`. The prior 127 Flashback
controls and 19 existing durable-maintenance route controls passed **146/146**
under the same final product pin. Together with the new three GUI tests, scoped
verification is **149 PASS / 0 FAIL**. SDK synchronization, syntax and diff checks
passed; configured network guard attempts were zero. Exact receipts are in the
handoff. Earlier exploratory and intermediate failures remain preserved.

## Reproduction and checks

From the private clone's `Librarian-System/PROGRAM`, use PowerShell:

```powershell
$env:NODE_OPTIONS='--require=C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs'
$env:NODE_PATH='C:/Users/rusin/AppData/Local/Temp/LIB-WM-Recovery-20261002/test-deps/node_modules'
$env:RECOVERY_NETWORK_LOG='<own Temp receipt directory>/network-attempts.jsonl'
Remove-Item Env:SDK_PREFERENCE_SOURCE_BASE,Env:SDK_INTENT_SOURCE_BASE,Env:SDK_OVERLAY_FILE -ErrorAction SilentlyContinue
node --test --test-concurrency=1 --test-reporter=tap --test-timeout=60000 tests/flashback_maintenance_outcome_gui_runtime_test.cjs
node --test --test-concurrency=1 --test-reporter=tap --test-timeout=60000 tests/flashback_raw_first_maintenance_runtime_test.cjs tests/flashback_raw_cow_append_runtime_test.cjs tests/flashback_startup_currentness_runtime_test.cjs tests/flashback_startup_authority_runtime_test.cjs tests/flashback_maintenance_durable_route_runtime_test.cjs
node tools/check_sdk_sync.cjs
```

All embedding responses in these fixtures are synthetic in-memory values.
Actual models, embedding endpoints, external network, original DATA and installed
host behavior were not exercised. No performance, cross-runtime CAS or global
readiness claim follows from these checks.

The past user's recurrent-repair cause remains **evidence insufficient** without
the historical plans, results and provider receipts. Current repeated pending
failed-work behavior and the misleading completion presentation are reproduced;
recurrent damage after a verified successful repair is not reproduced in the
bounded controls. Existing archive work can separately remain intentionally
deferred as `archive_durable_work_pending`; this unit does not implement it.

Independent review, root composition checks, durable backup and an actual restore
are required before root-owned original integration. Apply only these three owned
paths/hunks; do not overwrite a newer embedded SDK when integrating the Flashback
display change.
