'use strict';
const assert = require('node:assert/strict');
const { fixture, artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');

const V4 = 'libra.canonical_artifact.v4';
const V5 = 'libra.canonical_artifact.v5';
const clone = value => JSON.parse(JSON.stringify(value));
const batch = Array.from({ length: 5 }, (_, index) => {
  const turn = index + 1;
  return {
    turn,
    user: { text: input.sourceRows.find(row => row.ref === `t${turn}-u`).text },
    assistant: { text: input.sourceRows.find(row => row.ref === `t${turn}-a`).text }
  };
});

(async () => {
  const f = await fixture();
  try {
    const api = f.r.api;
    const old = artifact();
    const oldBytes = JSON.stringify(old);
    assert.equal(api.debugValidateUnifiedArtifact(old, batch).ok, true);

    const extended = clone(old);
    extended.facts.find(row => row.tempFactId === 'f12').values.thread = {
      summary: '오늘 열쇠 반환 약속', status: 'resolved', kind: 'promise',
      link: 'resolve', resolution: 'fulfilled'
    };
    const rejectedV4 = api.debugValidateUnifiedArtifact(extended, batch);
    assert.equal(rejectedV4.ok, false, 'v4 cannot reinterpret new thread lifecycle fields');
    extended.schema = V5;
    assert.equal(api.debugValidateUnifiedArtifact(extended, batch).ok, true,
      'v5 accepts the same new thread lifecycle fields');

    const preference = clone(old);
    preference.facts.push({
      tempFactId: 'newPreference', domain: 'character', subjectTempRef: 'mina',
      claimKind: 'character_preference', values: { preferences: ['민트차를 좋아한다 [주제: 민트차]'] },
      text: '민아는 민트차를 좋아한다', temporalRole: 'current_sequence', certainty: 'confirmed',
      evidenceSpans: [{ ref: 't4-a', quote: input.sourceRows.find(row => row.ref === 't4-a').text }]
    });
    assert.equal(api.debugValidateUnifiedArtifact(preference, batch).ok, false,
      'v4 cannot reinterpret a v5-only preference claim');
    preference.schema = V5;
    assert.equal(api.debugValidateUnifiedArtifact(preference, batch).ok, true);

    assert.equal(JSON.stringify(old), oldBytes, 'v4 input bytes are not rewritten on read');
    f.control.artifact = clone(old);
    assert.equal((await f.run()).completed, 1, 'old unlabeled/old-schema content still commits');
    assert.equal(f.getMemory(1)?.artifactSchema, V4, 'old content retains v4 label');

    const unlabeledRun = await fixture();
    try {
      const next = clone(extended);
      delete next.schema;
      unlabeledRun.control.artifact = next;
      assert.equal((await unlabeledRun.run()).completed, 1, 'unlabeled extension commits');
      assert.equal(unlabeledRun.getMemory(1)?.artifactSchema, V5,
        'the writer promotes an unlabeled v5 extension, never stores it under v4');
    } finally { await unlabeledRun.r.cleanup(); }

    const explicitRun = await fixture();
    try {
      explicitRun.control.artifact = { ...clone(extended), schema: V4 };
      const outcome = await explicitRun.run();
      assert.equal(outcome.completed, 0, 'an explicit v4 extension is refused');
      assert.match(outcome.failures?.[0]?.message || '', /UNIFIED_V5_REQUIRES_V5_SCHEMA/,
        'the refusal discloses the schema conflict');
      assert.equal(explicitRun.getMemory(1), null,
        'an explicit incompatible schema cannot write a partly admitted memory');
    } finally { await explicitRun.r.cleanup(); }

    // The admitted provider wrapper is unwrapped by prepareUnifiedMemoryArtifact.
    // Schema selection must see its meaning before quarantine can drop the fact.
    const wrapped = clone(old);
    const wrappedFact = wrapped.facts.find(row => row.tempFactId === 'f12');
    wrappedFact.values = {thread:{thread:{...wrappedFact.values.thread,
      link:'resolve', resolution:'fulfilled', status:'resolved'}}};
    delete wrapped.schema;
    const wrappedRun = await fixture();
    try {
      wrappedRun.control.artifact = clone(wrapped);
      const outcome = await wrappedRun.run();
      assert.equal(outcome.completed, 1, 'unlabeled wrapped v5 fact commits');
      const saved = wrappedRun.getMemory(1);
      assert.equal(saved?.artifactSchema, V5, 'wrapped extension is written under v5');
      assert.equal(saved?.canonicalArtifact?.facts?.find(row => row.tempFactId === 'f12')?.values?.thread?.link,
        'resolve', 'schema selection cannot lose the wrapped thread fact');
    } finally { await wrappedRun.r.cleanup(); }
    const wrappedV4Run = await fixture();
    try {
      wrappedV4Run.control.artifact = {...clone(wrapped), schema:V4};
      const outcome = await wrappedV4Run.run();
      assert.equal(outcome.completed, 0, 'explicit v4 wrapped extension is refused');
      assert.match(outcome.failures?.[0]?.message || '', /UNIFIED_V5_REQUIRES_V5_SCHEMA/);
      assert.equal(wrappedV4Run.getMemory(1), null);
    } finally { await wrappedV4Run.r.cleanup(); }

    console.log(JSON.stringify({ test: 'libra_main_memory_v5_schema_boundary', passed: 1,
      v4RejectedThread: rejectedV4.issues, oldBytesPreserved: JSON.stringify(old) === oldBytes }));
  } finally { await f.r.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
