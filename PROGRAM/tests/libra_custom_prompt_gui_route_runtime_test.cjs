'use strict';
// Custom analysis instructions must not cut the route from model output to the GUI.
//
// A Prompt Studio profile, the Librarian addendum or OOC guidance can make the model answer in
// the user's words: Korean certainty/time/domain labels, Korean entity types, a relationship
// axis such as "호감도", a numeric score, a kind the contract does not have, a wrapped object,
// notes on State bindings. Before admission normalised that vocabulary, each such answer lost
// facts (or the whole five-turn batch), so the memory shelf, people cards and current State
// showed nothing new. This runs the real Librarian analysis and commit with such answers and
// checks that the stored memory and State match the plain-contract answer.
const assert = require('node:assert/strict');
const { fixture, artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const V5 = 'libra.canonical_artifact.v5';
const plain = () => { const a = artifact(); a.schema = V5; return a; };
const ko = { confirmed: '확정', current_sequence: '현재', world: '세계', character: '인물', relationship: '관계', narrative: '서사' };
const variants = {
  plain: a => JSON.stringify(a),
  korean_vocabulary: a => {
    for (const f of a.facts) { f.certainty = ko[f.certainty] || f.certainty; f.temporalRole = ko[f.temporalRole] || f.temporalRole; f.domain = ko[f.domain] || f.domain; }
    for (const e of a.entities) { if (e.type === 'person') { e.type = '인물'; e.kind = '인물'; } else if (e.kind === 'location') { e.kind = '장소'; } }
    for (const f of a.facts) if (f.claimKind === 'relationship') f.dimension = '신뢰';
    return JSON.stringify(a);
  },
  wrapped_with_notes: a => {
    for (const f of a.facts) { f.importance = 3; f.tags = ['메모']; }
    a.stateBindings = a.stateBindings.map(binding => ({ ...binding, note: '현재 상태' }));
    return '분석 결과입니다.\n```json\n' + JSON.stringify({ artifact: { ...a, summary: '요약' } }) + '\n```';
  },
  relationship_score_and_new_kind: a => {
    const rel = a.facts.find(f => f.claimKind === 'relationship');
    rel.values = { value: 80 }; rel.dimension = '호감도';
    const extra = JSON.parse(JSON.stringify(a.facts.find(f => f.claimKind === 'location')));
    a.facts.push({ ...extra, tempFactId: 'fx', claimKind: 'emotion', values: { emotion: '안도' }, text: '민아가 서재에 도착했다.', dependsOn: [] });
    return JSON.stringify(a);
  }
};

const run = async name => {
  const f = await fixture();
  try {
    await f.r.api.debugWritePromptOverrides({ activeMemoryProfile: 'Custom', memoryProfiles: { Custom: { name: 'Custom', version: 1,
      stages: { librarian: { sections: { relation: { mode: 'append', text: '관계는 한국어로, 호감도 점수와 감정도 함께 기록해 줘.' } } } } } } });
    f.control.onCall = () => ({ type: 'success', result: variants[name](plain()) });
    const job = await f.run();
    const memory = f.getMemory();
    const head = f.getHead();
    const system = JSON.stringify(f.control.calls[0] || []);
    const facts = memory?.canonicalArtifact?.facts || [];
    const relation = facts.find(fact => fact.claimKind === 'relationship');
    return {
      completed: job.completed,
      facts: facts.length,
      claimKinds: [...new Set(facts.map(fact => fact.claimKind))].sort(),
      relationDimension: relation?.dimension,
      relationValueIsText: typeof relation?.values?.value === 'string',
      minaLocation: JSON.stringify(head?.characters?.find(row => row.name === '민아')?.state || {}).includes('서재') || JSON.stringify(head || {}).includes('서재'),
      characters: (head?.characters || []).map(row => row.name).sort(),
      reasserted: system.includes('OUTPUT CONTRACT REASSERTION')
    };
  } finally { await f.r.cleanup?.(); }
};

(async () => {
  const base = await run('plain');
  assert.equal(base.completed, 1, 'the plain-contract answer commits');
  assert.equal(base.reasserted, true, 'the customized profile is followed by the output-contract reassertion in the request');
  for (const name of ['korean_vocabulary', 'wrapped_with_notes']) {
    const got = await run(name);
    assert.equal(got.completed, 1, `${name}: the batch commits`);
    assert.equal(got.facts, base.facts, `${name}: every fact reaches the stored memory`);
    assert.deepEqual(got.claimKinds, base.claimKinds, `${name}: same typed facts as the plain answer`);
    assert.deepEqual(got.characters, base.characters, `${name}: same people reach the State`);
    assert.equal(got.minaLocation, base.minaLocation, `${name}: the current location reaches the State`);
  }
  const extra = await run('relationship_score_and_new_kind');
  assert.equal(extra.completed, 1);
  assert.equal(extra.facts, base.facts + 1, 'the requested extra kind is kept as a memory instead of being dropped');
  assert.equal(extra.relationDimension, 'affection', '"호감도" maps to the affection axis');
  assert.equal(extra.relationValueIsText, true, 'a numeric score becomes the qualitative statement');
  console.log(JSON.stringify({ test: 'libra_custom_prompt_gui_route_runtime', base, ok: true }));
})().catch(error => { console.error(error); process.exitCode = 1; });
