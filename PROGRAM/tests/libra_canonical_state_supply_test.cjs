'use strict';
// Canonical keeps facts it can prove and still refuses what the source does not state.
// Full plugin with a synthetic provider; the real provider's extraction volume is not measured here.
const assert = require('node:assert/strict');
const {fixture} = require('./fixtures/libra_unified_runtime_fixture.cjs');
const {microReply} = require('./fixtures/libra_reanalysis_kinds_fixture.cjs');

const results = [];
async function test(name, fn) {
  const f = await fixture();
  try { await fn(f); results.push(name); } finally { await f.r.cleanup(); }
}
const spansOf = (f, id) => f.clone(f.control.artifact.facts.find(row => row.tempFactId === id).evidenceSpans);
const REPAIR_MARKER = '[LIBRA EVIDENCE QUOTE REPAIR]';
const respond = (f, repairs) => {
  f.control.requoteCalls = 0;
  f.control.onCall = async args => {
    const text = JSON.stringify(args);
    if (text.includes(REPAIR_MARKER)) {
      f.control.requoteCalls += 1;
      return {type: 'success', result: JSON.stringify({repairs})};
    }
    if (text.includes('[LIBRA MICRO SOURCE CONTRACT]')) return microReply(args);
    return {type: 'success', result: JSON.stringify(f.control.artifact)};
  };
};
const minaFact = (f, fields) => ({domain: 'character', subjectTempRef: 'mina', temporalRole: 'current_sequence',
  certainty: 'confirmed', evidenceSpans: spansOf(f, 'f9'), ...fields});

(async () => {
  await test('a claim kind under an invented domain is repaired, a valid but different domain still is not', async f => {
    const a = f.control.artifact;
    a.facts.push(minaFact(f, {tempFactId: 'fk', domain: 'identity', claimKind: 'knowledge', values: {knowledge: ['식별 도메인으로 적힌 지식']}, text: '식별 도메인으로 적힌 지식'}));
    a.facts.push(minaFact(f, {tempFactId: 'fl', domain: 'world', claimKind: 'location', values: {locationRef: 'hall'}, text: '민아는 공연실에 있다.'}));
    a.facts.push(minaFact(f, {tempFactId: 'fr', domain: 'relationship', claimKind: 'character_state', values: {condition: '잘못 분류됨'}, text: '잘못 분류됨'}));
    await f.run();
    const memory = f.getMemory(), stored = Object.fromEntries(memory.canonicalArtifact.facts.map(row => [row.tempFactId, row]));
    assert.equal(stored.fk?.domain, 'character');
    assert.equal(stored.fl?.domain, 'character');
    assert.equal(stored.fr, undefined, 'a real domain conflict is not guessed away');
    assert.ok(f.getHead().characters.find(row => row.name === '민아').state.knowledge.includes('식별 도메인으로 적힌 지식'));
  });

  await test('an entity named in the source survives a bad quote; a name the source never uses does not', async f => {
    const a = f.control.artifact;
    a.entities.find(row => row.tempId === 'junho').evidenceSpans = [{ref: 't1-a', quote: '원문에 없는 인용'}];
    a.entities.push({tempId: 'ghost', name: '원문에없는인물', type: 'person', kind: 'person', evidenceSpans: [{ref: 't1-a', quote: '원문에 없는 인용'}]});
    a.facts.push(minaFact(f, {tempFactId: 'fg', subjectTempRef: 'ghost', claimKind: 'character_state', values: {condition: '존재하지 않음'}, text: '존재하지 않음'}));
    respond(f, []);
    await f.run();
    const memory = f.getMemory(), names = memory.canonicalArtifact.entities.map(row => row.name);
    assert.ok(names.includes('준호'), 'the real name is rebound to a row that states it');
    assert.equal(names.includes('원문에없는인물'), false, 'an invented person stays out');
    assert.equal(memory.canonicalArtifact.facts.some(row => row.tempFactId === 'fg'), false, 'and takes its fact with it');
    assert.ok(memory.canonicalArtifact.facts.some(row => row.tempFactId === 'f8'), 'facts about the real person are kept');
  });

  await test('one re-quote restores a fact only through exact evidence', async f => {
    const a = f.control.artifact, good = spansOf(f, 'f9')[0];
    a.facts.push(minaFact(f, {tempFactId: 'fq', claimKind: 'knowledge', values: {knowledge: ['다시 인용된 지식']}, text: '다시 인용된 지식', evidenceSpans: [{ref: good.ref, quote: '원문과 다른 인용문입니다'}]}));
    a.facts.push(minaFact(f, {tempFactId: 'fz', claimKind: 'knowledge', values: {knowledge: ['지어낸 지식']}, text: '지어낸 지식', evidenceSpans: [{ref: good.ref, quote: '이것도 원문과 다른 인용문'}]}));
    respond(f, [{id: 'fq', ref: good.ref, quote: good.quote}, {id: 'fz', ref: good.ref, quote: '또 지어낸 인용문입니다'}]);
    await f.run();
    assert.equal(f.control.requoteCalls, 1, 'one bounded extra call');
    const memory = f.getMemory(), ids = memory.canonicalArtifact.facts.map(row => row.tempFactId);
    assert.ok(ids.includes('fq'), 'an exact quote restores the fact');
    assert.equal(ids.includes('fz'), false, 'a quote the source lacks stays rejected');
    assert.ok(memory.artifactValidation.admission.normalizedFields.some(row => row.reason === 'evidence_quote_requoted'));
  });

  await test('a clean response costs no extra call and a failed re-quote keeps the first result', async f => {
    respond(f, []);
    await f.run();
    assert.equal(f.control.requoteCalls, 0);
    assert.equal(f.getMemory().status, 'committed');
  });
  await test('a failing re-quote call never fails the batch', async f => {
    const a = f.control.artifact, good = spansOf(f, 'f9')[0];
    a.facts.push(minaFact(f, {tempFactId: 'fq', claimKind: 'knowledge', values: {knowledge: ['복구 실패']}, text: '복구 실패', evidenceSpans: [{ref: good.ref, quote: '원문과 다른 인용문입니다'}]}));
    const artifact = a;
    f.control.onCall = async args => {
      const text = JSON.stringify(args);
      if (text.includes(REPAIR_MARKER)) return {type: 'error', result: 'synthetic_provider_failure'};
      if (text.includes('[LIBRA MICRO SOURCE CONTRACT]')) return microReply(args);
      return {type: 'success', result: JSON.stringify(artifact)};
    };
    await f.run();
    const memory = f.getMemory();
    assert.equal(memory.status, 'committed');
    assert.equal(memory.canonicalArtifact.facts.some(row => row.tempFactId === 'fq'), false);
    assert.ok(memory.canonicalArtifact.facts.some(row => row.tempFactId === 'f5'), 'everything else still commits');
  });

  await test('every typed State field reaches the Head without a declared binding', async f => {
    const a = f.control.artifact;
    a.schema = 'libra.canonical_artifact.v5';
    a.stateBindings = [];
    const span = spansOf(f, 'f9');
    a.facts.push(minaFact(f, {tempFactId: 'fe', claimKind: 'character_info', values: {category: 'emotion', content: '불안'}, text: '민아는 불안하다'}));
    a.facts.push(minaFact(f, {tempFactId: 'fa', claimKind: 'affiliation', values: {affiliation: {organizationTempRef: 'org', role: '회원', status: 'member'}}, text: '민아는 기록회 회원이다'}));
    a.facts.push({tempFactId: 'fc', domain: 'world', subjectTempRef: 'library', claimKind: 'access', values: {access: {personTempRef: 'mina', permission: '출입', status: 'granted'}},
      text: '민아는 도서관에 출입할 수 있다', temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: span});
    await f.run();
    const memory = f.getMemory(), head = f.getHead();
    assert.equal(memory.canonicalArtifact.facts.find(row => row.tempFactId === 'fe')?.claimKind, 'character_emotion');
    const mina = head.characters.find(row => row.name === '민아').state;
    assert.equal(mina.emotion, '불안', 'emotion is its own field, not condition');
    assert.equal(mina.affiliations.at(-1).status, 'member', 'an unbound affiliation still applies');
    assert.equal(head.world.find(row => row.name === '도서관').state.access.at(-1).permission, '출입', 'an unbound access still applies');
    assert.equal(head.unifiedApplied.pending.some(row => row.reason === 'missing_current_binding'), false);
  });

  console.log(JSON.stringify({test: 'libra_canonical_state_supply', passed: results.length, results, boundary: 'full plugin, synthetic provider; live provider extraction not measured'}));
})().catch(error => { console.error(error); process.exitCode = 1; });
