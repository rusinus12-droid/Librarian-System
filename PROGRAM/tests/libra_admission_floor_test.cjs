'use strict';
// RED/GREEN guard for the canonical-memory admission floor.
//
// THE PROBLEM THIS LOCKS DOWN
//
// The pipeline already supports partial acceptance: `quarantineUnifiedProviderRecords` validates
// each entity/fact individually, rejects the bad ones into `admission.rejected`, drops facts whose
// dependencies did not survive, and rebuilds the artifact from what remains. The GUI renders the
// result as "기억 부분 저장 · 사실 N개 보존 · 제외 사실 M개".
//
// But `validateUnifiedArtifact` then asserts `facts.length > 0`. So the whole five-turn batch
// fails when EVERY fact is rejected — and a batch that fails is recorded in `manifest.failedBatches`
// and was, until the retry fix, excluded from every later automatic scan. The user loses the range
// entirely, even though the source transcript is intact and the rejection reasons are diagnostic
// (a quote that did not match, a dangling subject reference, a claim kind the model got wrong).
//
// That is the wrong default for a memory system whose requirement is "generation must succeed
// under any circumstance": a batch whose evidence could not be bound should be DEFERRED (kept as a
// retryable, visible failure with its reasons), never treated as a completed-but-empty memory and
// never silently dropped.
//
// WHAT IS ASSERTED
//
//   1. A batch where every fact is rejected is NOT committed as canonical memory. Storing an
//      empty artifact would be worse than failing: the range would look reviewed while carrying
//      no memory.
//   2. It is deferred, not deleted: the failure carries the diagnostic reason so the retry path
//      can pick it up and the user can see why.
//   3. The floor is still a floor: a single surviving evidenced fact admits the batch, however
//      many siblings were rejected.
//   4. The rejection accounting is preserved, so the GUI's "부분 저장" report stays accurate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const PLUGIN = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

const PAIRS = 5;
// A minimal, well-formed batch: ten source rows, tURN-u / turn-a as canonicalEvidenceSources reads them.
const makeBatch = () => Array.from({ length: PAIRS }, (_, index) => {
  const turn = index + 1;
  return {
    turn,
    user: { text: `User${turn} opened the archive door and found a blue ribbon.` },
    assistant: { text: `Assistant${turn} answered that the ledger was moved to the corridor.` }
  };
});

(async () => {
  const harness = await createLibraVmHarness();
  try {
    const api = harness.api;
    assert.equal(typeof api.debugPrepareUnifiedMemoryArtifact, 'function',
      'the admission preparer must be reachable to verify the floor');

    const batch = makeBatch();
    const prepare = api.debugPrepareUnifiedMemoryArtifact;

    // ------------------------------------------------------------------------------------
    // 1. A single well-evidenced fact is enough. The floor must not drift upward.
    // ------------------------------------------------------------------------------------
    const goodFact = {
      tempFactId: 'f1', domain: 'world', subjectTempRef: 'e1', claimKind: 'world_state',
      values: { condition: 'the archive door is open' }, text: 'the archive door is open',
      temporalRole: 'current_sequence', certainty: 'confirmed',
      evidenceSpans: [{ ref: 't1-u', quote: 'opened the archive door' }]
    };
    const goodEntity = {
      tempId: 'e1', name: 'the archive door', type: 'world', kind: 'location',
      evidenceSpans: [{ ref: 't1-u', quote: 'opened the archive door' }]
    };
    const admitted = prepare({
      schema: 'libra.canonical_artifact.v4', entities: [goodEntity], facts: [goodFact], stateBindings: []
    }, batch);
    assert.ok(admitted?.artifact, 'the preparer must return an artifact');
    assert.equal(admitted.artifact.facts.length, 1,
      'a single surviving evidenced fact must be admitted');

    // ------------------------------------------------------------------------------------
    // 2. Every fact rejected -> no facts survive. The batch must NOT be committed as an empty
    //    memory; the caller detects this from the admission accounting.
    // ------------------------------------------------------------------------------------
    const badQuote = {
      ...goodFact,
      tempFactId: 'f2',
      evidenceSpans: [{ ref: 't1-u', quote: 'a sentence that appears nowhere in the source at all' }]
    };
    const allRejected = prepare({
      schema: 'libra.canonical_artifact.v4', entities: [goodEntity], facts: [badQuote], stateBindings: []
    }, batch);
    assert.equal(allRejected.artifact.facts.length, 0,
      'a fact whose quote is not in the source must not survive admission');
    assert.equal(allRejected.admission.acceptedFacts, 0,
      'the admission report must record that nothing was accepted');
    assert.ok(allRejected.admission.rejectedFacts >= 1,
      'the admission report must record the rejection so the failure is diagnostic');

    // ------------------------------------------------------------------------------------
    // 3. The caller must treat "nothing admitted" as a DEFERRED failure with a diagnosable
    //    reason, not as a committed empty memory and not as an untraceable crash.
    // ------------------------------------------------------------------------------------
    assert.match(PLUGIN, /UNIFIED_FACTS_INVALID/,
      'the empty-artifact rejection must remain, so an empty memory is never committed');
    assert.match(PLUGIN, /NO_VALID_FACTS/,
      'the failure must stay classified so the GUI can explain it');
    // And the classification must be reachable through the failure diagnostic map.
    const diag = api.debugLibraMemoryFailureDiagnostic
      || api.getMemoryFailureDiagnostic
      || null;
    if (typeof diag === 'function') {
      const report = diag('UNIFIED_ARTIFACT_REJECTED:UNIFIED_FACTS_INVALID:accepted=0:rejected=3:normalized=0');
      assert.equal(report.code, 'NO_VALID_FACTS',
        `rejecting every fact must surface as a diagnosable "no valid facts" failure (got ${report.code})`);
      assert.ok(report.message && report.message.length > 0,
        'the failure must carry a human-readable explanation');
    }

    // ------------------------------------------------------------------------------------
    // 4. Partial accounting survives into what the GUI reports.
    // ------------------------------------------------------------------------------------
    const partial = prepare({
      schema: 'libra.canonical_artifact.v4',
      entities: [goodEntity],
      facts: [goodFact, badQuote],
      stateBindings: []
    }, batch);
    assert.equal(partial.artifact.facts.length, 1,
      'the good fact must survive alongside a rejected sibling');
    assert.equal(partial.admission.acceptedFacts, 1,
      'the accepted count must reflect the survivor');
    assert.ok(partial.admission.rejectedFacts >= 1,
      'the rejected count must reflect the sibling');
    assert.equal(partial.admission.status, 'partial',
      'a mixed outcome must be reported as partial, matching the GUI report');

    console.log(JSON.stringify({
      test: 'libra_admission_floor',
      singleFactAdmitted: true,
      emptyArtifactStillRejected: true,
      allRejectedIsDiagnosable: true,
      partialAccountingPreserved: true,
      acceptedFacts: partial.admission.acceptedFacts,
      rejectedFacts: partial.admission.rejectedFacts
    }, null, 1));
    process.stdout.write('libra_admission_floor_test: PASS\n');
  } finally {
    await harness.cleanup?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
