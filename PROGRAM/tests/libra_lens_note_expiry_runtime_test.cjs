'use strict';
// A lens ends its own earlier notes: a later run of the same lens says which note is over, with a quote
// from its own span. Nothing is deleted, nothing reads State, and a re-analysis undoes it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');

const text = ref => input.sourceRows.find(row => row.ref === ref).text;
const QUOTE = text('t4-a').slice(0, 12).trim();
const plain = value => JSON.parse(JSON.stringify(value));
const NOTE = { label: '증상', text: '지호의 왼손 손목이 붓고 아프다.', refs: ['t1-u'], basis: '근거', who: ['지호'], whoRef: 't2-a' };
const setup = async () => {
  const f = await lensFixture();
  const prompts = [];
  let reply = { items: [NOTE] };
  f.setReply(args => { prompts.push(JSON.stringify(args)); return JSON.stringify(reply); });
  const lens = await f.add('몸 상태', 'active', { trackSubject: true, cadence: { mode: 'manual' } });
  const run = async (startTurn, endTurn, next) => { reply = next; const before = prompts.length; await f.r.core.runLensForRange(lens.lensId, { startTurn, endTurn }); return prompts[prompts.length - 1 === before ? before : prompts.length - 1]; };
  return { f, lens, run, prompts };
};
const reset = async ({ lens, run, f }) => { await f.api.deleteLensMemories({ lensId: lens.lensId }); await run(1, 2, { items: [NOTE] }); };
const recalled = async f => plain(await f.api.recallLensMemories({ query: '지호 손목 부상 상태', canonicalBudgetChars: 12000 })).renderedBlock;
const sceneOnly = async f => plain(await f.api.recallLensMemories({ query: '오늘은 창밖으로 눈이 내리는 걸 구경하자', canonicalBudgetChars: 12000 })).renderedBlock;
const memory = async (f, lens) => plain(await f.api.inspectScopeLenses()).memories.filter(row => row.lensId === lens.lensId);
const lastRun = async (f, lens) => plain(await f.api.inspectScopeLenses()).lenses[lens.lensId].runs[0];

test('a later run ends a note: recall drops it, the reader keeps and marks it', async () => {
  const x = await setup();
  try {
    await reset(x);
    assert.match(await recalled(x.f), /손목이 붓고/, 'open before anything ended it');
    const prompt = await x.run(3, 5, { items: [{ label: '회복', text: '지호가 회복했다.', refs: ['t4-a'], basis: '근거', who: ['지호'], whoRef: 't2-a' }], closes: [{ id: 'n1', ref: 't4-a', quote: QUOTE, reason: '회복함' }] });
    assert.match(prompt, /OPEN NOTES/);
    assert.match(prompt, /\[n1\] \(T1–T2 · 지호 · 증상\)/, 'the lens is shown its own open notes');
    assert.equal((await lastRun(x.f, x.lens)).counts.closed, 1);
    assert.match(await recalled(x.f), /이후 종료됨\(T4\)[^\n]*손목이 붓고/, 'a search can still find it, labelled');
    assert.doesNotMatch(await sceneOnly(x.f), /손목이 붓고/, 'it no longer comes forward for being in the scene');
    const row = (await memory(x.f, x.lens)).find(item => item.label === '증상');
    assert.ok(row, 'the note is kept');
    assert.equal(row.closedBy.turn, 4);assert.equal(row.closedBy.quote, QUOTE);
  } finally { await x.f.close?.(); }
});

test('the turn comes from the quote, and closes nested in an item still count', async () => {
  const x = await setup();
  try {
    await reset(x);
    await x.run(3, 5, { items: [{ label: '회복', text: '지호가 회복했다.', refs: ['t4-a'], basis: '근거', who: ['지호'], whoRef: 't2-a', closes: [{ id: 'n1', ref: 't1-u', quote: QUOTE }] }] });
    const row = (await memory(x.f, x.lens)).find(item => item.label === '증상');
    assert.equal(row.closedBy.ref, 't4-a', 'a wrong turn from the model does not matter');
    assert.match(await recalled(x.f), /이후 종료됨\(T4\)[^\n]*손목이 붓고/);
  } finally { await x.f.close?.(); }
});

test('an ending needs a real quote from the span and a known note', async () => {
  const x = await setup();
  try {
    await reset(x);
    await x.run(3, 5, { items: [], closes: [
      { id: 'n1', ref: 't4-a', quote: '원문에 없는 지어낸 문장입니다' },
      { id: 'n1', ref: 't1-a', quote: text('t1-a').slice(0, 12) },
      { id: 'n9', ref: 't4-a', quote: QUOTE },
      { id: 'n1', ref: 't4-a', quote: '짧음' }
    ] });
    const run = await lastRun(x.f, x.lens);
    assert.equal(run.counts.closed, 0);assert.equal(run.counts.closesRejected, 4);
    assert.match(await recalled(x.f), /손목이 붓고/, 'the note stays open');
  } finally { await x.f.close?.(); }
});

test('a span that only ends a note is stored, and analysing that span again reopens it', async () => {
  const x = await setup();
  try {
    await reset(x);
    await x.run(3, 5, { items: [], closes: [{ id: 'n1', ref: 't4-a', quote: QUOTE }] });
    assert.match(await recalled(x.f), /이후 종료됨\(T4\)[^\n]*손목이 붓고/, 'a record with no notes of its own still ends one');
    await x.run(3, 5, { items: [{ label: '컨디션', text: '지호가 평소처럼 움직인다.', refs: ['t4-a'], basis: '근거', who: ['지호'], whoRef: 't2-a' }] });
    assert.doesNotMatch(await recalled(x.f), /이후 종료됨[^\n]*손목이 붓고/, 'the new analysis no longer says it ended');
  } finally { await x.f.close?.(); }
});

test('an ended note stays ended after a handoff to a new chat', async () => {
  const x = await setup();
  try {
    await reset(x);
    await x.run(3, 5, { items: [{ label: '회복', text: '지호가 회복했다.', refs: ['t4-a'], basis: '근거', who: ['지호'], whoRef: 't2-a' }], closes: [{ id: 'n1', ref: 't4-a', quote: QUOTE }] });
    await x.f.api.prepareSessionHandoff({ transferId: 'expiry' });
    const target = x.f.target();
    assert.equal((await x.f.api.adoptSessionHandoff({ transferId: 'expiry', targetChatId: target.id })).verified, true);
    const block = await recalled(x.f);
    assert.match(block, /지호가 회복했다/, 'the later note came along');
    assert.match(block, /이후 종료됨\(T4\)[^\n]*손목이 붓고/, 'the ended one stays labelled');
    const carried = (await memory(x.f, x.lens)).find(item => item.label === '증상');
    assert.equal(carried.closedBy.turn, 4, 'the reader still says why');
  } finally { await x.f.close?.(); }
});

test('one sentence cannot end three notes', async () => {
  const f = await lensFixture();
  try {
    const notes = ['첫째 증상 기록입니다.', '둘째 증상 기록입니다.', '셋째 증상 기록입니다.'].map(value => ({ label: '증상', text: value, refs: ['t1-u'], basis: '근거', who: ['지호'], whoRef: 't2-a' }));
    let reply = { items: notes };
    f.setReply(() => JSON.stringify(reply));
    const lens = await f.add('몸 상태', 'active', { trackSubject: true, cadence: { mode: 'manual' } });
    await f.api.deleteLensMemories({ lensId: lens.lensId });
    await f.r.core.runLensForRange(lens.lensId, { startTurn: 1, endTurn: 2 });
    reply = { items: [], closes: ['n1', 'n2', 'n3'].map(id => ({ id, quote: QUOTE })) };
    await f.r.core.runLensForRange(lens.lensId, { startTurn: 3, endTurn: 5 });
    const run = await lastRun(f, lens);
    assert.equal(run.counts.closed, 0);assert.equal(run.counts.closesRejected, 3);
  } finally { await f.close?.(); }
});

test('the prompt is unchanged when there is nothing to end, and silence never ends a note', async () => {
  const x = await setup();
  try {
    await x.f.api.deleteLensMemories({ lensId: x.lens.lensId });
    const first = await x.run(1, 2, { items: [NOTE] });
    assert.doesNotMatch(first, /OPEN NOTES|closes/, 'no open notes, no instructions about them');
    await x.run(3, 5, { items: [] });
    assert.match(await recalled(x.f), /손목이 붓고/);
  } finally { await x.f.close?.(); }
});
