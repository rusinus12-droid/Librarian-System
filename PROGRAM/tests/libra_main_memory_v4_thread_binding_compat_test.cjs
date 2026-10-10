'use strict';
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

(async () => {
  const f = await fixture();
  try {
    const artifact = f.control.artifact;
    const resolved = artifact.facts.find(fact => fact.tempFactId === 'f12');
    const unboundOpen = f.clone(resolved);
    unboundOpen.tempFactId = 'f14';
    unboundOpen.values.thread.status = 'open';
    unboundOpen.values.thread.summary = '같은 근거의 미선택 열린 약속';
    artifact.facts.push(unboundOpen);
    // Deliberately keep the baseline artifact's binding set: f12 is selected and
    // f14 is unbound. v4 groups by subject and suppresses the unbound duplicate.

    const result = await f.run();
    assert.equal(result.completed, 1, JSON.stringify(result));
    const threads = f.getHead()?.narrative?.threads || [];
    assert.deepEqual(threads.map(thread => thread.title), ['공연 허가'],
      'unbound v4 duplicate does not create a current State thread');

    const stored = f.getMemory(1);
    assert.equal(stored?.canonicalArtifact?.schema, 'libra.canonical_artifact.v4');
    assert.equal(stored.canonicalArtifact.facts.find(fact => fact.tempFactId === 'f12')?.values?.thread?.status, 'resolved');
    assert.equal(stored.canonicalArtifact.facts.find(fact => fact.tempFactId === 'f14')?.values?.thread?.status, 'open',
      'both source assertions remain in the original v4 canonical history');

    console.log(JSON.stringify({
      test: 'libra_main_memory_v4_thread_binding_compat',
      stateThreads: threads.map(thread => thread.title),
      canonicalSchema: stored.canonicalArtifact.schema,
      retainedFacts: ['f12:resolved', 'f14:open']
    }));
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
