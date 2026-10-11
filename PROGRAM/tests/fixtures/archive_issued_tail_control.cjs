'use strict';
// Actual source fixture, actual native callback and host acknowledgement.
// This preparation intentionally tests the old 200ms readiness boundary.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fixture = require('./archive_issued_tail_fixture.cjs');
const hash = values => crypto.createHash('sha256').update(JSON.stringify([...values].sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
async function run(kind = 'native') {
  fixture.configureControl(kind);
  let f, before, failure;
  try {
    f = await fixture.createArchiveReportingFixture();
    const state = fixture.stateFor(f.context);
    assert.equal(state.control.entered, true, 'genuine scheduled callback reached the controlled actual host read');
    before = { plugin: hash(f.pluginStorage.values), local: hash(f.safeLocalStorage.values) };
    const issued = fixture.issuedPromises(state);
    console.log('ROOT085_READINESS_BASELINE', JSON.stringify({ kind, released: !!state.control.released, ...fixture.pendingSnapshot(state), issuedPromiseCandidates: issued.counts, physical: before }));
    if (kind === 'native') {
      assert.equal(state.runtime.Runtime.nativeCopyObserver.inFlight, false, 'held identity read precedes adoption inFlight');
      assert.equal(state.runtime.sharedScopeWriteLocks.size, 0, 'held identity read precedes scope writer ownership');
    }
    // The observer deletes only after the original complete chain settles.
    // Persistent SDK/runtime promise fields may already be fulfilled and are
    // therefore not treated as proof of a pending callback here.
    assert.equal([...state.pending.values()].some(row => row.label === state.control.label), false,
      'fixture baseline must await already-issued full startup callback tails');
  } catch (error) { failure = error; }
  finally {
    await fixture.waitControlRelease();
    fixture.releaseControl();
    if (f) {
      const state = fixture.stateFor(f.context);
      const drained = new Set();
      let deadline;
      try {
        await Promise.race([(async () => {
          for (;;) {
            const next = [...fixture.issuedPromises(state).promises].filter(promise => !drained.has(promise));
            if (!next.length) return;
            next.forEach(promise => drained.add(promise));
            await Promise.all(next);
          }
        })(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('bounded actual issued-tail cleanup')), 15000); })]);
      } finally { clearTimeout(deadline); }
      console.log('ROOT085_READINESS_SETTLED', JSON.stringify({ physical: { plugin: hash(f.pluginStorage.values), local: hash(f.safeLocalStorage.values) }, prior: before }));
      await f.dispose();
    }
    console.log('ROOT085_READINESS_TRACE', JSON.stringify(fixture.report()));
  }
  if (failure) throw failure;
}
if (require.main === module) run(process.argv[2] || 'native').catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
