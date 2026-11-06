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
  await test('an unnamed continuing scene preserves the prior place without accepting an inferred location', async f => {
    assert.equal((await f.run()).completed, 1);
    const original = f.getHead().characters.find(row => row.name === '민아').state.locationRef;
    for (let turn = 6; turn <= 10; turn++) f.chat.message.push(
      {role:'user',chatId:`t${turn}-u`,data:'현재 상태를 확인한다.'},
      {role:'assistant',chatId:`t${turn}-a`,data:'민아의 밧줄은 그대로였다. 문이 닫혔다.'});
    f.chat.messages = f.chat.message;
    const span = [{ref:'t10-a',quote:'민아의 밧줄은 그대로였다. 문이 닫혔다.'}];
    f.control.artifact = {schema:'libra.canonical_artifact.v5',entities:[
      {tempId:'mina',name:'민아',type:'person',kind:'person',evidenceSpans:span},
      {tempId:'inferred',name:'서재',type:'world',kind:'location',evidenceSpans:span}],facts:[
      {tempFactId:'bad_location',domain:'character',subjectTempRef:'mina',claimKind:'location',values:{locationRef:'inferred'},text:'민아는 서재에 있다.',temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:span},
      {tempFactId:'condition',domain:'character',subjectTempRef:'mina',claimKind:'character_state',values:{condition:'밧줄은 그대로였다'},text:'민아의 밧줄은 그대로였다.',temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:span}],stateBindings:[]};
    respond(f, []);
    assert.equal((await f.run()).completed, 1);
    const current = f.getHead().characters.find(row => row.name === '민아');
    assert.equal(current.state.locationRef, original, 'absence of a new place fact does not erase prior location');
    assert.equal(current.state.condition, '밧줄은 그대로였다');
    const memory = f.getMemory(6);
    assert.ok(memory.artifactValidation.admission.rejected.some(row => row.id === 'inferred' && row.reason === 'UNIFIED_ENTITY_NAME_UNBOUND'));
    assert.ok(!memory.canonicalArtifact.facts.some(row => row.tempFactId === 'bad_location'));
  });
  await test('missing fact fields are repaired from exact source without altering the proposed value', async f => {
    const quote = '민아는 지호에게 오늘 열쇠를 돌려주겠다고 약속했다.';
    f.chat.message[9].data += ' ' + quote;
    f.control.artifact.schema = 'libra.canonical_artifact.v5';
    f.control.artifact.entities.push({tempId:'first_task',name:'첫 반환 약속',type:'world',kind:'thread',evidenceSpans:[{ref:'t5-a',quote}]});
    f.control.artifact.facts.push({tempFactId:'missing',domain:'narrative',subjectTempRef:'first_task',claimKind:'thread',
      values:{thread:{summary:'민아가 지호에게 열쇠 반환을 약속했다',status:'open',kind:'promise',link:'reaffirm',
        participants:[{role:'owner',personTempRef:'mina'},{role:'target',personTempRef:'jiho'}]}}});
    respond(f,[{id:'missing',ref:'t5-a',quote,text:quote,temporalRole:'current_sequence',certainty:'confirmed',values:{thread:{summary:'바꿔서는 안 되는 값'}}}]);
    assert.equal((await f.run()).completed,1);
    const fact=f.getMemory().canonicalArtifact.facts.find(row=>row.tempFactId==='missing');
    assert.ok(fact,'a supported thread must not vanish because required fields were omitted');
    assert.equal(fact.values.thread.summary,'민아가 지호에게 열쇠 반환을 약속했다');
    assert.equal(fact.values.thread.linkStatus,'new','a first-batch no-target reaffirmation cannot depend on a nonexistent lifecycle');
    assert.equal(fact.values.thread.link,undefined);
    assert.equal(f.control.requoteCalls,1);
  });
  await test('fact field repair preserves an existing uncertain qualifier', async f => {
    const good=spansOf(f,'f9')[0];
    f.control.artifact.facts.push({tempFactId:'uncertain_fields',domain:'character',subjectTempRef:'mina',claimKind:'character_state',values:{condition:'확인되지 않은 상태'},certainty:'uncertain'});
    respond(f,[{id:'uncertain_fields',ref:good.ref,quote:good.quote,text:'확인되지 않은 상태',temporalRole:'current_sequence',certainty:'confirmed'}]);
    assert.equal((await f.run()).completed,1);
    const fact=f.getMemory().canonicalArtifact.facts.find(row=>row.tempFactId==='uncertain_fields');
    assert.equal(fact.certainty,'uncertain','repair must not promote an already uncertain fact');
    assert.notEqual(f.getHead().characters.find(row=>row.name==='민아').state.condition,'확인되지 않은 상태');
  });
  await test('fact field repair cannot rescue a fabricated source quote', async f => {
    f.control.artifact.facts.push({tempFactId:'fabricated_fields',domain:'character',subjectTempRef:'mina',claimKind:'knowledge',values:{knowledge:['없는 비밀']}});
    respond(f,[{id:'fabricated_fields',ref:'t5-a',quote:'원문에 존재하지 않는 내용',text:'없는 비밀',temporalRole:'current_sequence',certainty:'confirmed'}]);
    assert.equal((await f.run()).completed,1);
    assert.ok(!f.getMemory().canonicalArtifact.facts.some(row=>row.tempFactId==='fabricated_fields'));
  });
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
