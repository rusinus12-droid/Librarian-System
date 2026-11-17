'use strict';
// The 생체 주기 · 생식 starter lens records a confirmed pregnancy, a birth and a pregnancy end, so
// GRADIA's 상태 AIDE can follow a pregnancy from the record without a card (user decision
// 2026-11-17). A lens added from the earlier template moves to the new instruction when the user
// never edited it, and the scene delivery hands each person their standing notes first.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const PREVIOUS = {
  description: '누구의 생리 주기가 언제 시작·종료됐는지, 관계·피임·임신 검사와 증상을 인물별로 기록합니다.',
  labels: ['주기 시작', '주기 종료', '관계', '피임', '임신 검사', '임신 증상'],
  instruction: {
    goal: '인물의 생리 주기 시작과 종료, 성적 접촉이 있었던 사건, 피임 수단과 실제 사용 여부, 임신 검사와 결과, 임신을 의심하게 하는 증상을 기록하라. 사실이 속한 사람은 말한 사람이 아니라 몸에 그 일이 있는 사람이다. 성적 접촉은 관련된 인물 각각에게 같은 사건으로 기록한다.',
    includeRules: ['생리가 시작되거나 끝났다는 서술이나 대사', '성적 접촉이 실제로 있었다는 서술(암시가 아니라 일어난 일)', '피임 수단의 종류와 그때 사용했는지, 쓰지 않았는지, 실패했는지', '임신 검사 실시와 결과', '생리 지연, 입덧 등 원문이 임신과 연결한 증상'],
    excludeRules: ['농담·가정·소문·계획으로만 나온 관계나 임신', '원문에 없는 날짜·주기 일차·임신 확률 계산', '원문이 임신과 연결하지 않은 일반 증상(몸 상태 렌즈가 기록)'],
    outputHint: '누구에게 무슨 일이 있었는지 한 문장으로 쓰고, 원문 인용을 붙이세요. 원문이 시점을 말하면 그 표현을 그대로 남기세요.',
    extraFieldsNote: 'extra에 event(cycle_start/cycle_end/contact/contraception/test/symptom), partner, method, used(예/아니오/모름), result를 선택적으로 기록할 수 있습니다.'
  }
};

test('the starter template records a confirmed pregnancy, a birth and a pregnancy end', async () => {
  const f = await lensFixture();
  try {
    const template = plain(f.api.getLensStarterTemplates()).find(row => row.templateId === 'starter_cycle_reproduction');
    for (const label of ['임신 확인', '출산', '임신 종료']) assert.ok(template.labels.includes(label), label);
    assert.match(template.instruction.goal, /임신이 확인된 사실, 출산, 유산 등 임신이 끝난 사건/);
    assert.match(template.instruction.extraFieldsNote, /pregnancy\/birth\/pregnancy_end/);
  } finally { await f.close?.(); }
});

test('a lens with the earlier template instruction moves to the current one and keeps its history', async () => {
  const f = await lensFixture();
  try {
    const upgraded = plain(await f.api.createLens({ templateId: 'starter_cycle_reproduction', lensId: 'cycle', name: '생체 주기 · 생식', ...PREVIOUS,
      revisionHistory: [{ instruction: PREVIOUS.instruction }], trackTime: true, trackSubject: true, evidenceMode: 'strict', cadence: { mode: 'manual' } }));
    assert.match(upgraded.instruction.goal, /임신이 확인된 사실/);
    assert.ok(upgraded.labels.includes('임신 확인') && upgraded.labels.includes('출산') && upgraded.labels.includes('임신 종료'));
    assert.match(upgraded.description, /임신 확인·출산·임신 종료/);
    assert.equal(upgraded.revisionHistory.length, 2, 'the earlier revision stays for the notes it wrote');
    assert.notEqual(upgraded.revisionHistory[0].revision, upgraded.instructionRevision);

    const edited = plain(await f.api.createLens({ templateId: 'starter_cycle_reproduction', lensId: 'cycle_edited', name: '내 주기 렌즈', ...PREVIOUS,
      instruction: { ...PREVIOUS.instruction, goal: `${PREVIOUS.instruction.goal} 내가 고친 문장.` }, cadence: { mode: 'manual' } }));
    assert.match(edited.instruction.goal, /내가 고친 문장\.$/, 'an instruction the user edited is left alone');
    assert.ok(!edited.labels.includes('출산'));
  } finally { await f.close?.(); }
});

test('scene delivery hands each person their standing cycle notes before other notes', async () => {
  const f = await lensFixture();
  try {
    const item = (id, label, text) => ({ itemId: id, label, text, evidenceLevel: 'interpreted', refs: ['t1-u'], basis: '근거', who: [{ name: '지호', ref: 't1-u', role: 'named' }], whoIssue: '' });
    const seed = async (templateId, lensId) => {
      f.setReply({ items: [{ label: '시작', text: '시작 기록입니다.', refs: ['t1-u'], basis: '근거' }] });
      const lens = await f.add(`렌즈-${lensId}`, 'active', { templateId, lensId, trackSubject: true, recall: { role: 'persistent', maxItems: 4 } });
      const key = [...f.r.values.keys()].find(k => k.endsWith(`:lens:${lens.lensId}:records`));
      const stored = JSON.parse(f.r.values.get(key));
      // Symptom notes come first, so a score-only pick would take them.
      for (const record of Object.values(stored.records)) {
        record.trackedSubject = true;
        record.items = [item('s1', '임신 증상', '지호는 아침마다 메스꺼워했다.'), item('s2', '임신 증상', '지호는 냄새에 예민해졌다.'),
          item('s3', '임신 증상', '지호는 쉽게 피곤해했다.'), item('p1', '임신 확인', '지호는 임신 8주라는 진단을 받았다.'), item('c1', '주기 시작', '지호는 생리를 시작했다.')];
      }
      f.r.values.set(key, JSON.stringify(stored));
      return lens;
    };
    const cycle = await seed('starter_cycle_reproduction', 'cycle_scene');
    const recall = plain(await f.api.recallLensMemories({ query: '오늘은 창밖으로 눈이 내리는 걸 구경하자', canonicalBudgetChars: 12000 }));
    const picks = recall.injectedItems.filter(row => row.lensId === cycle.lensId && row.groupName === '지호').map(row => row.label);
    assert.deepEqual(picks.slice(0, 2).sort(), ['임신 확인', '주기 시작'].sort(), JSON.stringify(picks));
  } finally { await f.close?.(); }
});
