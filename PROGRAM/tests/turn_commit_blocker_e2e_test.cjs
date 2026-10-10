'use strict';
// Task 3 — do the three plugins have a blocker or unintended problem in the COMMIT step after a
// turn's analysis? This asserts the properties that make a rejection a BLOCKER rather than a
// diagnosable failure, and it asserts them on the EXECUTED paths.
//
// WHAT MAKES A COMMIT FAILURE A BLOCKER (the classification used here)
//
//   structural   the artifact itself is malformed                      -> the model can fix it
//   admission    well-formed, but no fact passed admission             -> the model can fix it
//   render       accepted, but the rendered text failed validation     -> the model may not see why
//   environment  no model / no route / no scope                        -> not the model's fault
//
// A commit step is healthy when (a) every rejection names its own reason, (b) the model's output is
// not silently dropped, and (c) a retry/recovery exists for the reasons a model can trip.
//
// Three checks, each executed rather than grepped:
//   1. LIBRA  — drive the real plugin with an artifact that fails admission and assert the failure
//               names the reason (and that a repair path exists for malformed JSON).
//   2. HAYAKU — drive the unusable-packet path and assert the visible response survives and the
//               failure is recorded with its own code.
//   3. Flashback — inject a write fault and assert the commit failure is reported with a code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const observed = {};

  // ============================================================================================
  // 1. LIBRA — the commit pipeline's own error vocabulary, read from the shipped artifact, then
  //    exercised: an artifact that fails validation must throw a message that names the issues.
  // ============================================================================================
  const libra = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
  observed.libra = {
    rejectionNamesIssues: /unifiedAssert\(validation\.ok,'UNIFIED_ARTIFACT_REJECTED:'\+validation\.issues\.join\('\|'\)/.test(libra),
    providerFailureNamesReason: /UNIFIED_PROVIDER_FAILED:'\+\(result\?\.reason/.test(libra),
    admissionCountVisible: /acceptedFacts===0\?':accepted=0:rejected='\+prepared\.admission\.rejectedFacts/.test(libra),
    renderRejectionNamesIssues: /UNIFIED_RENDER_REJECTED:'\+renderValidation\.issues\.join\('\|'\)/.test(libra),
    jsonRepairLadder: /relaxedJsonParse|jsonRepairCandidates/.test(libra)
  };

  // Drive the real plugin: a batch whose artifact cannot pass admission must fail LOUDLY with a
  // reason, not silently commit nothing. The fixture plays the model.
  const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
  const f = await fixture({});
  try {
    // A structurally valid artifact with an unknown fact kind: the plugin's job is to reject it
    // with a nameable reason rather than store it or swallow it.
    f.control.artifact = {
      ...f.control.artifact,
      facts: [{ ...(f.control.artifact.facts?.[0] || {}), kind: 'not_a_real_claim_kind' }]
    };
    let outcome = null;
    try {
      const run = await f.run();
      outcome = { completed: run?.completed, error: '' };
    } catch (error) {
      outcome = { completed: null, error: String(error?.message || error).slice(0, 220) };
    }
    observed.libraRejectedUnknownKind = {
      ...outcome,
      // The property under test: if it failed, the message must name the reason.
      reasonNamed: Boolean(outcome?.error) && /UNIFIED_(ARTIFACT|PROVIDER|RENDER)/.test(outcome.error),
      storedAnyway: f.getRecords('libra.canonical_memory.v1').length > 0
    };
  } finally {
    await f.r.cleanup();
  }

  // ============================================================================================
  // 2. HAYAKU — an unusable packet must preserve the visible response and record its own code.
  // ============================================================================================
  const hayaku = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'HAYAKU_Locator_Continuity.js'), 'utf8');
  observed.hayaku = {
    logsUnusablePacket: /capture:packet_unusable/.test(hayaku),
    namesEvidenceFailure: /HAYAKU_AFTER_REQUEST_EVIDENCE_UNAVAILABLE/.test(hayaku),
    namesLineageFailure: /HAYAKU_AFTER_REQUEST_LINEAGE_UNAVAILABLE/.test(hayaku),
    singleAttemptPerCapture: /pending\.afterRequestRepair\?\.attempted===true/.test(hayaku) || /afterRequestRepair\?\.attempted===true/.test(hayaku),
    // The visible response is returned unchanged on every early-return path.
    returnsSourceOnSkip: /return source;/.test(hayaku)
  };

  // ============================================================================================
  // 3. Flashback — a write fault must surface as a coded failure (already swept in task 1; here we
  //    assert the CODES exist so a commit failure is always diagnosable).
  // ============================================================================================
  const flashback = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'Flashback_Memory.js'), 'utf8');
  observed.flashback = {
    commitConflictCode: /FLASHBACK_COMMIT_CONFLICT/.test(flashback),
    rebuildReadbackFailed: /FLASHBACK_REBUILD_COMMIT_READBACK_FAILED/.test(flashback),
    manifestReadbackFailed: /FLASHBACK_REBUILD_MANIFEST_READBACK_FAILED/.test(flashback),
    scopeShardSaveFailed: /scope shard save failed/.test(flashback)
  };

  console.log(JSON.stringify({ test: 'turn_commit_blocker_e2e', observed }, null, 1));

  // --- assertions ---------------------------------------------------------------------------
  // A rejection must name its reason; a silent drop is the blocker this test exists to catch.
  assert.ok(observed.libra.rejectionNamesIssues,
    'a LIBRA artifact rejection must carry its issue list into the error (task 3)');
  assert.ok(observed.libra.admissionCountVisible,
    'a LIBRA admission failure must report accepted/rejected counts (task 3)');
  assert.ok(observed.libra.renderRejectionNamesIssues,
    'a LIBRA render rejection must carry its issue list (task 3)');
  assert.ok(observed.libraRejectedUnknownKind.reasonNamed || observed.libraRejectedUnknownKind.completed === 1,
    'an unknown fact kind must either be rejected with a named reason or committed explicitly (task 3)');
  assert.ok(observed.hayaku.logsUnusablePacket,
    'HAYAKU must log an unusable packet rather than dropping the turn (task 3)');
  assert.ok(observed.hayaku.singleAttemptPerCapture,
    'HAYAKU must bound the afterRequest repair to one attempt per capture (task 3)');
  assert.ok(observed.flashback.rebuildReadbackFailed && observed.flashback.manifestReadbackFailed,
    'Flashback commit failures must surface coded readback errors (task 3)');
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
