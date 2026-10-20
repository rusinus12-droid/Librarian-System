'use strict';
// Name boundaries for people on lens notes (docs/LIBRA_LENS_PEOPLE_DESIGN_20261020.md): grammar
// glued to a name, honorifics, lists in one string, kinship and job titles, pets, places, ships,
// demonstrative descriptions and registry non-people. Model replies are controlled fixtures that
// reproduce the shapes measured from a live model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const batch = [
  { turn: 1, user: { text: '서윤 선생님이 진료실 문을 열었다. "민아 씨, 들어오세요."' }, assistant: { text: '한서윤 선생님은 민아의 열을 쟀다. 민아가 기침을 하자 선생님이 고개를 끄덕였다. 수진이는 옆에서 웃었다.' } },
  { turn: 2, user: { text: '"지호야, 너도 아파?" 나는 지호를 돌아봤다.' }, assistant: { text: '지호랑 민아는 같이 약국에 들렀다. 할머니는 혈압이 140까지 올랐다. 카페 사장님은 감기에 걸렸다. 그 아이는 열이 나 보였다. 한빛병원 응급실은 붐볐다. 검은 장미 호는 항구에서 고장 났다. 준형 군은 기침을 했다. 준형은 물을 마셨다. 고양이 나비가 앞발을 절었다. 모두 피곤했다. 은하는 조용했다.' } }
];
const LENS = { evidenceMode: 'interpretive', trackSubject: true };
const note = (who, extra = {}) => ({ label: '상태', text: `${JSON.stringify(who)}의 상태`, refs: ['t2-a'], basis: '본문', who, ...extra });

test('the gate draws name boundaries', async () => {
  const f = await lensFixture();
  try {
    const evaluate = (who, subjects = {}) => plain(f.api.evaluateLensCandidateItems({ items: [note(who)] }, LENS, batch, subjects)).acceptedItems[0];
    const names = (who, subjects) => evaluate(who, subjects).who.map(person => person.name);
    assert.deepEqual(names(['민아가']), ['민아'], 'a subject particle is removed when the bare name is also written');
    assert.deepEqual(names(['지호랑']), ['지호']);
    assert.deepEqual(names(['지호야']), ['지호'], 'a vocative ending is removed');
    assert.deepEqual(names(['수진이']), ['수진이'], 'a name only ever written with the ending stays whole');
    assert.deepEqual(names(['지호와 민아']), ['지호', '민아'], 'a list in one string becomes two people');
    assert.deepEqual(names(['Emma and Leo']), [], 'parts are checked separately (neither is in this span)');
    assert.deepEqual(names(['할머니', '카페 사장님']), ['할머니', '카페 사장님'], 'kinship and job titles used for one person are people');
    assert.deepEqual(names(['나비']), ['나비'], 'a named animal is a subject');
    for (const notPerson of ['그 아이', '모두', '한빛병원', '한빛병원 응급실', '검은 장미 호', '사람들']) {
      const item = evaluate([notPerson]);
      assert.deepEqual(item.who, [], `${notPerson} is not a person`);
      assert.equal(item.whoIssue, 'not_in_source');
    }
    assert.deepEqual(names(['은하']), ['은하'], 'a plain name is a person by default');
    assert.deepEqual(names(['은하'], { nonPersonNames: ['은하'] }), [], 'a name the registry knows only as a place is not');
    assert.deepEqual(names(['준형']), ['준형'], 'a name ending in a title syllable is kept');
  } finally { await f.close(); }
});

test('grouping uses the core name without honorifics; the record keeps the source wording', async () => {
  const f = await lensFixture();
  try {
    const chat = f.target('경계');
    batch.forEach((pair, index) => chat.message.push({ role: 'user', chatId: `t${index + 1}-u`, data: pair.user.text }, { role: 'char', chatId: `t${index + 1}-a`, data: pair.assistant.text }));
    chat.messages = chat.message;
    f.setReply({ items: [
      { label: '진료', text: '열을 쟀다.', refs: ['t1-a'], basis: '본문', who: ['서윤 선생님'] },
      { label: '진료', text: '고개를 끄덕였다.', refs: ['t1-a'], basis: '본문', who: ['서윤'] },
      { label: '증상', text: '기침을 했다.', refs: ['t2-a'], basis: '본문', who: ['준형 군'] },
      { label: '상태', text: '물을 마셨다.', refs: ['t2-a'], basis: '본문', who: ['준형'] },
      { label: '증상', text: '감기에 걸렸다.', refs: ['t2-a'], basis: '본문', who: ['카페 사장님'] }
    ] });
    const lens = await f.api.createLens({ name: '경계', evidenceMode: 'interpretive', trackSubject: true, instruction: { goal: '상태' }, cadence: { mode: 'manual' } });
    const run = plain(await f.api.runLensForRange(lens.lensId, { startTurn: 1, endTurn: 2 }));
    assert.equal(run.status, 'succeeded', JSON.stringify(run.rejectedItems));
    const view = plain(await f.api.inspectScopeLenses()).memories;
    const key = text => view.find(row => row.text === text).people[0];
    assert.equal(key('열을 쟀다.').key, key('고개를 끄덕였다.').key, '"서윤 선생님" and "서윤" are one person');
    assert.equal(key('열을 쟀다.').written, '서윤 선생님', 'the written form is kept beside the core name');
    assert.equal(key('기침을 했다.').key, key('물을 마셨다.').key, '"준형 군" and "준형" are one person');
    assert.equal(key('감기에 걸렸다.').name, '카페 사장님', 'a title whose head is a place stays whole');
  } finally { await f.close(); }
});

test('the prompt states the person boundary', async () => {
  const f = await lensFixture();
  try {
    const calls = [];
    f.setReply(args => { calls.push(JSON.stringify(args)); return '{"items":[]}'; });
    const lens = await f.api.createLens({ name: '인물', trackSubject: true, instruction: { goal: '상태' }, cadence: { mode: 'manual' } });
    await f.api.runLensForRange(lens.lensId, { startTurn: 1, endTurn: 5 });
    assert.match(calls[0], /named animal/);
    assert.match(calls[0], /hypothetical, a wish, a comparison or unconfirmed hearsay/);
    assert.match(calls[0], /without grammar endings or honorifics/);
  } finally { await f.close(); }
});
