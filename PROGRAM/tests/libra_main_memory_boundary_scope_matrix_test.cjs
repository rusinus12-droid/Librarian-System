'use strict';
// Phase C compatibility regression for boundary scope identity and fail-closed empty clear.
// Structured v5 facts exercise exact scope identity; a null clear selector remains malformed.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { sourceRows } = require('./fixtures/unified_vertical_source.json');

const MODES = process.env.LIBRA_BOUNDARY_SCOPE_MODE
  ? [process.env.LIBRA_BOUNDARY_SCOPE_MODE] : ['plugin_only', 'mirror', 'server_only'];
const clone = value => JSON.parse(JSON.stringify(value));
const appendFive = (f, start) => {
  for (let i = 0; i < 10; i++) f.chat.message.push({ ...f.chat.message[i], chatId: `t${start + Math.floor(i / 2)}-${i % 2 ? 'a' : 'u'}` });
  f.chat.messages = f.chat.message;
};
const batch = (f, start, facts) => {
  const value = clone(artifact()); value.schema = 'libra.canonical_artifact.v5';
  for (const row of [...value.entities, ...value.facts]) for (const span of row.evidenceSpans || []) {
    span.ref = span.ref.replace(/^t(\d+)/, (_, n) => `t${Number(n) + start - 1}`);
    span.quote = (f.chat.message.find(item => item.chatId === span.ref)?.data
      || sourceRows.find(item => item.ref === span.ref)?.text || span.quote);
  }
  const mina = value.entities.find(row => row.name === '민아');
  const entityByName = new Map(value.entities.map(row => [row.name, row]));
  for (const spec of facts) {
    const ref = `t${start + 3}-a`;
    const source = f.chat.message.find(row => row.chatId === ref);
    if(source&&spec.quote&&!String(source.data||'').includes(spec.quote))source.data=`${source.data||''} ${spec.quote}`.trim();
    const typed=spec.value===null?null:{content:spec.quote.replace(/[.!?。！？]$/u,''),topic:'편지 열기',kind:'boundary',
      scope:{subjectRef:mina.tempId,targetRef:entityByName.get(spec.target)?.tempId||'',act:'편지 열기',when:spec.when}};
    value.facts.push({ tempFactId: spec.id, domain: 'character', subjectTempRef: mina.tempId,
      claimKind: 'character_boundary', values: { boundaries: typed === null ? null : [typed] },
      text: spec.text, temporalRole: 'current_sequence', certainty: 'confirmed',
      ...(spec.effect ? { effect: spec.effect } : {}),
      evidenceSpans: [{ ref, quote: spec.quote || source?.data || sourceRows.find(row => row.ref === ref)?.text }] });
  }
  return value;
};
const getHead = snapshot => snapshot.getHead() || JSON.parse([...snapshot.local.entries()].find(([key]) => /:continuity-state$/.test(key))?.[1] || 'null');

const runMode = async mode => {
  const snapshot = await serverFixture({ mode }); const f = snapshot.f;
  try {
    f.control.artifact = batch(f, 1, [
      { id: 'c_b1', target: '지호', when: '오늘', quote:'민아는 지호에게 오늘 편지를 열지 말라고 했다.', text: '민아는 지호에게 오늘 편지를 열지 말라고 했다.' },
      { id: 'c_b2', target: '준호', when: '내일', quote:'민아는 준호에게 내일 편지를 열지 말라고 했다.', text: '민아는 준호에게 내일 편지를 열지 말라고 했다.' }
    ]);
    const firstRun=await f.run();
    assert.equal(firstRun.completed,1,`${mode}: two stored-v5 boundary facts commit`);
    const first = getHead(snapshot)?.characters?.find(row => row.name === '민아')?.state?.boundaries || [];
    const sameTopicDifferentScopeCoexist = first.length === 2;
    appendFive(f, 6);
    f.control.artifact = batch(f, 6, [{ id: 'c_b3', target:'준호', when:'다음 주', quote:'민아는 준호에게 다음 주 편지를 열지 말라고 했다.', text: '민아는 준호에게 다음 주 편지를 열지 말라고 했다.' }]);
    const secondRun=await f.run();
    assert.equal(secondRun.completed,1,`${mode}: distinct boundary fact commits`);
    appendFive(f, 11);
    f.control.artifact = batch(f, 11, [{ id: 'c_b4', value: null, quote:'민아는 편지 열람 경계를 모두 해제한다고 말했다.', text: '민아는 편지 열람 경계를 모두 해제한다고 말했다.', effect: 'clear' }]);
    const thirdRun=await f.run();
    assert.equal(thirdRun.completed,1,`${mode}: empty-selector clear fact commits`);
    const after = getHead(snapshot)?.characters?.find(row => row.name === '민아')?.state?.boundaries || [];
    const emptyClearPreservesAll = after.length === 3;
    const malformedClearRejected=thirdRun.memoryWarnings?.some(row=>row.admission?.rejected?.some(issue=>issue.id==='c_b4'))===true;
    assert.ok(malformedClearRejected,`${mode}: null selector is rejected/quarantined rather than admitted as a broad delete`);
    return { mode, sameTopicDifferentScopeCoexist, emptyClearPreservesAll, malformedClearRejected,
      beforeCount:first.length,afterEmptyClearCount:after.length };
  } finally { await snapshot.cleanup(); }
};

(async () => {
  const results = [];
  for (const mode of MODES) results.push(await runMode(mode));
  console.log(JSON.stringify({ test: 'libra_main_memory_boundary_scope_matrix', results,
    boundary: 'real deployed provider pipeline and storage; malformed null selector is quarantined' }));
  assert.ok(results.every(row => row.sameTopicDifferentScopeCoexist && row.emptyClearPreservesAll),
    `boundary identity and empty clear must fail closed: ${JSON.stringify(results)}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
