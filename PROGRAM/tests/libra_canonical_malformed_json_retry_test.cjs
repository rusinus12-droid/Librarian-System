'use strict';
// A canonical answer that ends normally but with mismatched brackets is asked once more.
// A cut-off answer (unterminated string) is not retried. Controlled provider.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { countCalls } = require('./fixtures/libra_provider_call_kinds.cjs');

// The measured failure: a fact's values object left open, so a later ']' closes an object.
const malformed = artifact => {
  const json = JSON.stringify(artifact);
  const at = json.indexOf('},"text"');
  assert.ok(at > 0, 'fixture has a values object to break');
  return json.slice(0, at) + json.slice(at + 1);
};

async function run() {
  const f = await fixture();
  try {
    let canonical = 0;
    f.control.onCall = args => {
      if (!JSON.stringify(args).includes('LIBRA LONG-TERM MEMORY EXTRACTION')) return { type: 'success', result: JSON.stringify(f.control.artifact) };
      canonical += 1;
      return { type: 'success', result: canonical === 1 ? malformed(f.control.artifact) : JSON.stringify(f.control.artifact) };
    };
    const result = await f.run();
    assert.equal(result.completed, 1, JSON.stringify(result));
    assert.equal(countCalls(f.control).canonical, 2, 'one retry after the malformed answer');
    assert.ok(f.getMemory()?.canonicalArtifact?.facts?.length, 'the retried answer is committed');
  } finally { await f.r.cleanup(); }

  const g = await fixture();
  try {
    g.control.onCall = args => {
      if (!JSON.stringify(args).includes('LIBRA LONG-TERM MEMORY EXTRACTION')) return { type: 'success', result: JSON.stringify(g.control.artifact) };
      return { type: 'success', result: malformed(g.control.artifact) };
    };
    const result = await g.run();
    assert.equal(result.completed, 0, 'two malformed answers still fail the batch');
    assert.equal(countCalls(g.control).canonical, 2, 'never more than one retry');
  } finally { await g.r.cleanup(); }

  const h = await fixture();
  try {
    h.control.onCall = args => {
      if (!JSON.stringify(args).includes('LIBRA LONG-TERM MEMORY EXTRACTION')) return { type: 'success', result: JSON.stringify(h.control.artifact) };
      const json = JSON.stringify(h.control.artifact);
      return { type: 'success', result: json.slice(0, Math.floor(json.length / 2)).replace(/"[^"]*$/, '"cut off') };
    };
    const result = await h.run();
    assert.equal(result.completed, 0);
    assert.equal(countCalls(h.control).canonical, 1, 'a cut-off answer is not retried');
  } finally { await h.r.cleanup(); }
  console.log('PASS malformed canonical JSON is retried once; repeated malformation fails; truncation is not retried');
}
run().catch(e => { console.error(e); process.exitCode = 1; });
