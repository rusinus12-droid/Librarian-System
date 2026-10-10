'use strict';
// A21 of `03_ACCEPTANCE_TESTS.md` -- "확인 불가능한 경우 last-known/unknown".
//
// The acceptance report previously marked A21 PASS while nothing performed its action.
// What A21 actually requires is that a chain which could NOT be walked is never
// reported as `current`: an unreadable ref, a read that returns nothing, and an
// artifact whose schema this build cannot read must all lower the verdict and say why.
//
// It drives the SHIPPED closure through the public debug surface, with each failure
// injected separately, so the disclosure is measured rather than assumed.
const assert = require('node:assert/strict');
const path = require('node:path');
const PROGRAM = path.join(__dirname, '..');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const run = async () => {
  const observations = {};
  const snapshot = await serverFixture({ mode: 'plugin_only' });
  try {
    const api = snapshot.f.r.api;
    const base = artifact();
    // One selected fact to address, and a manifest with one later committed ref.
    const selectedFact = base.facts.find(f => f.tempFactId === 'f7');
    const selected = [{ fact: selectedFact, artifact: base }];
    const manifest = { memories: { 1: { key: 'k1', memoryId: 'mem_000001', revision: 1, status: 'committed', turnRange: { start: 1, end: 5 }, sessionEpoch: 0 } } };

    // ── baseline: a healthy read reports what it can HONESTLY report.
    //
    // The reference that identifies a fact across artifacts is the PAIR (complete cursor,
    // tempFactId) -- `01` section 7.3 via the shipped `statePipelineCursorForRef` and
    // `evidenceLinkIndexFactKey`. A stored canonical record carries `tempId` + `name` for its
    // entities (the validator's pick list is exactly
    // `['tempId','name','type','kind','evidenceSpans']`), so the cursor -- not a name and not
    // a bare temp ref -- is what keeps two batches apart. This block only pins the CONTRACT
    // of the verdict; the failure injections below are what prove the disclosure.
    {
      const closure = await api.debugResolveRecallContinuityClosure({
        selectedFacts: [{ fact: selectedFact, artifact: base, ref: manifest.memories[1] }], manifest,
        readFact: async () => ({ canonicalArtifact: JSON.parse(JSON.stringify(base)) })
      });
      observations.baseline_currentness = closure.currentness;
      observations.baseline_complete = closure.closureComplete;
      observations.baselineReasons = closure.diagnostics?.reasons || [];
      observations.baselineClosureCount = closure.diagnostics?.closureCount ?? null;
      assert.ok(['current', 'last-known', 'unknown'].includes(observations.baseline_currentness),
        `the baseline reports one of the three honest verdicts (got ${observations.baseline_currentness})`);
      // A reading that was never walked, or was walked with a gap, must not claim `current`.
      if (!observations.baseline_complete) {
        assert.notEqual(observations.baseline_currentness, 'current',
          'an incomplete chain is never reported as current');
        assert.ok(observations.baselineReasons.length > 0,
          `an incomplete chain says why (got ${JSON.stringify(observations.baselineReasons)})`);
      }
    }

    // ── (1) the read THROWS: must not be `current`, and must say why
    {
      const closure = await api.debugResolveRecallContinuityClosure({
        selectedFacts: selected, manifest,
        readFact: async () => { const error = new Error('injected read failure'); error.code = 'INJECTED_READ_FAILURE'; throw error; }
      });
      observations.throw_currentness = closure.currentness;
      observations.throw_complete = closure.closureComplete;
      observations.throw_reasons = closure.diagnostics?.reasons || [];
    }

    // ── (2) the read returns NOTHING (missing row): the reviewer's case
    {
      const closure = await api.debugResolveRecallContinuityClosure({
        selectedFacts: selected, manifest,
        readFact: async () => null
      });
      observations.empty_currentness = closure.currentness;
      observations.empty_complete = closure.closureComplete;
      observations.empty_reasons = closure.diagnostics?.reasons || [];
      observations.empty_count = closure.diagnostics?.closureCount ?? null;
    }

    // ── (3) the row exists but carries NO readable artifact
    {
      const closure = await api.debugResolveRecallContinuityClosure({
        selectedFacts: selected, manifest,
        readFact: async () => ({ canonicalArtifact: null })
      });
      observations.noArtifact_currentness = closure.currentness;
      observations.noArtifact_complete = closure.closureComplete;
      observations.noArtifact_reasons = closure.diagnostics?.reasons || [];
    }

    // ── (4) an artifact whose schema this build cannot read
    {
      const future = JSON.parse(JSON.stringify(base));
      future.schema = 'libra.canonical_artifact.v99';
      const closure = await api.debugResolveRecallContinuityClosure({
        selectedFacts: selected, manifest,
        readFact: async () => ({ canonicalArtifact: future })
      });
      observations.futureSchema_currentness = closure.currentness;
      observations.futureSchema_complete = closure.closureComplete;
      observations.futureSchema_reasons = closure.diagnostics?.reasons || [];
    }

    // ── every failure case must be disclosed, and none may claim `current`
    assert.ok(['current', 'last-known', 'unknown'].includes(observations.baseline_currentness),
      `the baseline reports one of the honest verdicts (got ${observations.baseline_currentness})`);
    for (const key of ['throw', 'empty', 'noArtifact', 'futureSchema']) {
      assert.notEqual(observations[`${key}_currentness`], 'current',
        `${key}: an unwalkable chain must not be reported as current`);
      assert.equal(observations[`${key}_complete`], false,
        `${key}: an unwalkable chain must not be reported as complete`);
      assert.ok((observations[`${key}_reasons`] || []).length > 0,
        `${key}: the reason the chain stopped must be disclosed`);
    }
    assert.equal(observations.empty_currentness, 'last-known',
      'a read that returned nothing verified nothing new, so the verdict degrades to last-known');

    console.log(JSON.stringify({
      test: 'libra_main_memory_closure_failure_disclosure',
      passed: 1,
      boundary: 'the shipped closure driven with each failure injected separately',
      observations
    }));
  } finally { await snapshot.cleanup(); }
};
run().catch(error => { console.error(error?.message || error); console.error(error?.stack); process.exit(1); });
