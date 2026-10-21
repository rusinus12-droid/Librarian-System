'use strict';
// Public owner APIs, real persisted records/archives and controlled model replies.
// Runs unchanged against Full and Min via LIBRA_TEST_PLUGIN.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const datedLens = { trackTime: true, trackSubject: true, evidenceMode: 'interpretive' };
const symptom = { label: '증상', text: '지호는 열이 났다.', refs: ['t1-u'], basis: '원문에 증상을 말했다.', who: ['지호'] };

test('dated events retain separate ids while equivalent verified times still deduplicate', async () => {
  const f = await lensFixture();
  try {
    const batch = [{ turn: 1, user: { text: '3월 4일 지호는 열이 났고, 3월 5일에도 지호는 열이 났다.' }, assistant: { text: '지호가 쉬었다.' } }];
    const result = plain(f.api.evaluateLensCandidateItems({ items: [
      { ...symptom, when: '3월 4일' }, { ...symptom, when: '3월 5일' },
      { ...symptom, when: '3월4일', whenRef: 't9-a' },
      { ...symptom, when: '없는 시점' }, { ...symptom, when: '또 다른 없는 시점' }
    ] }, datedLens, batch));
    assert.equal(result.acceptedItems.length, 3);
    assert.equal(new Set(result.acceptedItems.map(item => item.itemId)).size, 3, 'time is part of the stored item identity');
    assert.deepEqual(result.acceptedItems.map(item => item.when?.text || null), ['3월 4일', '3월 5일', null]);
    assert.deepEqual(result.rejectedItems.map(item => item.reasonCode), ['duplicate_item', 'duplicate_item']);
    assert.deepEqual([result.counts.timeStated, result.counts.timeUnknown, result.counts.timeDropped], [2, 1, 1], 'rejected duplicates do not inflate accepted-time counts');
  } finally { await f.close(); }
});

test('recall retains an earlier dated event with identical wording before and after handoff', async () => {
  const f = await lensFixture({ beforeRun: f => {
    f.chat.message[0].data += ' 3월 4일, 지호는 열이 났다.';
    f.chat.message[6].data += ' 3월 5일, 지호는 열이 났다.';
  } });
  try {
    const lens = await f.api.createLens({ ...datedLens, name: '날짜별 건강', instruction: { goal: '인물별 날짜별 증상' }, cadence: { mode: 'manual' }, recall: { mode: 'recent', maxItems: 8 } });
    f.setReply({ items: [{ ...symptom, when: '3월 4일', whenRef: 't1-u' }] });
    await f.api.runLensForRange(lens.lensId, { startTurn: 1, endTurn: 2 });
    f.setReply({ items: [{ ...symptom, refs: ['t4-u'], when: '3월 5일', whenRef: 't4-u' }] });
    await f.api.runLensForRange(lens.lensId, { startTurn: 3, endTurn: 5 });
    assert.equal((await f.api.inspectScopeLenses()).memories.length, 2);
    const recall = await f.api.recallLensMemories({ query: '3월 4일 지호의 증상', canonicalBudgetChars: 12000 });
    assert.match(recall.renderedBlock, /시점: 3월 4일/);
    assert.match(recall.renderedBlock, /시점: 3월 5일/);
    assert.ok(recall.usedChars <= recall.budgetChars, 'time identity does not expand the lens budget');
    await f.api.prepareSessionHandoff({ transferId: 'dated-identity' });
    const chat = f.target();
    assert.equal((await f.api.adoptSessionHandoff({ transferId: 'dated-identity', targetChatId: chat.id })).verified, true);
    const inherited = await f.api.recallLensMemories({ query: '3월 4일 지호의 증상', canonicalBudgetChars: 12000 });
    assert.match(inherited.renderedBlock, /이전 대화/);
    assert.match(inherited.renderedBlock, /시점: 3월 4일/);
    assert.ok(inherited.usedChars <= inherited.budgetChars);
  } finally { await f.close(); }
});

test('compatibility normalization preserves source wording through composition and expansion', async () => {
  const f = await lensFixture();
  try {
    const examples = [
      ['😀 Ｍｉｎａは３月４日に到着した。', '3月4日', '３月４日', 'Mina', 'Ｍｉｎａ'],
      ['😀 ｶﾞﾂ３日、ﾐﾅが到着した。', 'ガツ3日', 'ｶﾞﾂ３日', 'ミナ', 'ﾐﾅ'],
      ['😀 가나년, 지호가 도착했다.', '가나년', '가나년', '지호', '지호'],
      ['😀 ﬃ년, ﬃore가 도착했다.', 'ffi년', 'ﬃ년', 'ffiore', 'ﬃore']
    ];
    for (const [source, givenTime, storedTime, givenName, storedName] of examples) {
      const result = plain(f.api.evaluateLensCandidateItems({ items: [{ ...symptom, when: givenTime, who: [givenName] }] }, datedLens,
        [{ turn: 1, user: { text: source }, assistant: { text: '도착을 확인했다.' } }]));
      const item = result.acceptedItems[0];
      assert.equal(item.when.text, storedTime);
      assert.equal(item.who[0].name, storedName);
      assert.ok(source.includes(item.when.text) && source.includes(item.who[0].name), 'stored values are spans of the original source');
    }
    const partial = plain(f.api.evaluateLensCandidateItems({ items: [{ ...symptom, when: 'fi', who: [] }] }, datedLens,
      [{ turn: 1, user: { text: 'ﬃ' }, assistant: { text: '도착했다.' } }]));
    assert.equal(partial.acceptedItems[0].when, null, 'part of a normalized expansion is not a standalone source span');
    assert.equal(partial.acceptedItems[0].whenIssue, 'not_in_source');
  } finally { await f.close(); }
});

test('current timed notes still deduplicate inherited notes of an identical copied history', async () => {
  const f = await lensFixture();
  try {
    f.setReply({ items: [{ ...symptom, refs: ['t2-a'], when: '오늘', whenRef: 't2-a' }] });
    const lens = await f.add('복사된 기록', 'active', datedLens);
    await f.api.prepareSessionHandoff({ transferId: 'copied-timed-history' });
    const chat = f.target();
    assert.equal((await f.api.adoptSessionHandoff({ transferId: 'copied-timed-history', targetChatId: chat.id })).verified, true);
    chat.message = f.clone(f.chat.message); chat.messages = chat.message;
    await f.api.runLensForRange(lens.lensId, { startTurn: 1, endTurn: 5 });
    const recall = await f.api.recallLensMemories({ query: '지호 오늘 증상', canonicalBudgetChars: 12000 });
    assert.equal(recall.injectedItems.length, 1);
    assert.equal(recall.injectedItems[0].inherited, false, 'current notes retain priority without repeating the inherited event');
  } finally { await f.close(); }
});

test('normalized time and name matches beyond the source prefix survive immutable archive readback', async () => {
  const f = await lensFixture({ beforeRun: f => { f.chat.message[0].data += ' ' + '배경 설명. '.repeat(700) + ' Ｍｉｎａは３月４日に到着した。'; } });
  try {
    f.setReply({ items: [{ label: '도착', text: 'Mina가 도착했다.', refs: ['t1-u'], quote: '３月４日に到着した', when: '3月4日', who: ['Mina'] }] });
    await f.add('원문 문자 보존', 'active', datedLens);
    const live = await f.api.inspectScopeLenses();
    assert.equal(live.memories[0].when.text, '３月４日');
    assert.equal(live.memories[0].who[0].name, 'Ｍｉｎａ');
    assert.ok(live.sourceTurns['t1-u'].includes('Ｍｉｎａは３月４日'));
    await f.api.prepareSessionHandoff({ transferId: 'unicode-identity' });
    const chat = f.target();
    const receipt = await f.api.adoptSessionHandoff({ transferId: 'unicode-identity', targetChatId: chat.id });
    assert.equal(receipt.verified, true);
    const item = (await f.api.inspectScopeLenses()).memories[0];
    assert.equal(item.inherited, true);
    assert.ok(item.sourceTurns['t1-u'].includes(item.when.text));
    assert.ok(item.sourceTurns['t1-u'].includes(item.who[0].name));
    assert.ok(item.sourceTurns['t1-u'].length < 4000);
  } finally { await f.close(); }
});

test('object/reflexive and Japanese pronouns remain unknown without rejecting the note', async () => {
  const f = await lensFixture();
  try {
    for (const pronoun of ['her', 'him', 'them', 'their', 'herself', 'ourselves', '彼女', '彼ら', 'あなた', '私たち', '그분', '자신의', 'Ｈｅｒ']) {
      const result = plain(f.api.evaluateLensCandidateItems({ items: [{ ...symptom, who: [pronoun] }] }, datedLens,
        [{ turn: 1, user: { text: `${pronoun}가 창밖을 보았다.` }, assistant: { text: '쉬었다.' } }]));
      assert.equal(result.acceptedItems.length, 1);
      assert.deepEqual(result.acceptedItems[0].who, [], `${pronoun} is not a proper name`);
      assert.equal(result.acceptedItems[0].whoIssue, 'not_in_source');
      assert.equal(result.counts.subjectDropped, 1);
    }
    for (const name of ['Hera', 'ミナ', '지호']) {
      const result = plain(f.api.evaluateLensCandidateItems({ items: [{ ...symptom, who: [name] }] }, datedLens,
        [{ turn: 1, user: { text: `${name}가 창밖을 보았다.` }, assistant: { text: '쉬었다.' } }]));
      assert.equal(result.acceptedItems[0].who[0].name, name, 'proper names are not rejected by a pronoun prefix');
    }
  } finally { await f.close(); }
});
