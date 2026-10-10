'use strict';
// A09 of `03_ACCEPTANCE_TESTS.md` -- "항목 교체·삭제 후 재조회".
//
// The acceptance report previously marked A09 PASS while nothing performed its
// action: the T04 suite's own comment claimed "one item can be replaced or removed"
// and never did either. This suite performs both, against the real Head, and re-reads
// the result.
//
// It also pins the D03 identity the replacement depends on: the same character and
// the same TOPIC stated again must leave ONE item, not two contradictory ones. That
// identity is `subject + topic` (the topic the analyzer carries in `[주제: ...]`), not
// whole-string equality -- "민트차를 좋아한다" and "민트차를 싫어한다" are the same
// item with a changed value.
//
// Each mode is driven through the real storage its mode uses.
const assert = require('node:assert/strict');
const path = require('node:path');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const source = require('./fixtures/unified_vertical_source.json');

// An evidence span must QUOTE text that actually appears in the row it cites --
// the validator rejects a mismatch as `source_quote_mismatch` and quarantines the
// WHOLE fact (`UNIFIED_EVIDENCE_REQUIRED`). Measured on the second batch: quoting the
// sentence we WANTED to store instead of the row's real text silently blocked the
// update. So the quote is always read from the row being cited.
//
// Batches after the first run on rows the fixture generates by copying the first ten
// messages with new turn ids, so the second batch's rows carry the first batch's text.
const quoteOf = (chat, ref) => {
  const row = (chat.message || []).find(m => m.chatId === ref);
  if (row) return String(row.data || '');
  const seeded = source.sourceRows.find(r => r.ref === ref);
  return seeded ? seeded.text : '';
};

const MODES = ['plugin_only', 'mirror', 'server_only'];

const infoFact = (chat, minaRef, id, category, content, text, ref) => ({
  tempFactId: id, domain: 'character', subjectTempRef: minaRef, claimKind: 'character_info',
  values: { category, content }, text,
  temporalRole: 'current_sequence', certainty: 'confirmed',
  evidenceSpans: [{ ref, quote: quoteOf(chat, ref) }]
});
// The mode's own authority: in plugin_only the Head is in plugin storage, in mirror and
// server_only it is on the server. Reading only one of them makes a passing pipeline
// look broken, which is exactly what happened the first time this suite ran.
const headJson = snapshot => {
  const key = [...snapshot.local.keys()].find(k => /:continuity-state$/.test(k));
  if (key) { try { const value = JSON.parse(snapshot.local.get(key)); if (value) return value; } catch {} }
  return snapshot.getHead() ?? null;
};
const charOf = (head, name) => head?.characters?.find(row => row.name === name) ?? null;

const runMode = async mode => {
  const snapshot = await serverFixture({ mode });
  const observation = { mode };
  try {
    const f = snapshot.f;
    // batch 1 (t1..t5): two independent preferences for the same character
    const first = JSON.parse(JSON.stringify(artifact()));
    first.schema = 'libra.canonical_artifact.v5';
    const mina = first.entities.find(e => e.name === '민아');
    first.facts.push(infoFact(f.chat, mina.tempId, 'x1', 'preference', '민트차를 좋아한다', '민아는 평소 민트차를 좋아한다', 't4-a'));
    first.facts.push(infoFact(f.chat, mina.tempId, 'x2', 'preference', '홍차를 좋아한다', '민아는 평소 홍차를 좋아한다', 't4-a'));
    f.control.artifact = first;
    assert.equal((await f.run()).completed, 1, `${mode}: the first batch commits`);
    const before = charOf(headJson(snapshot), '민아')?.state?.preferences || [];
    observation.before = before;
    assert.equal(before.length, 2, `${mode}: both independent preferences are stored`);

    // batch 2 (t6..t10): the SAME topic, changed value -> must REPLACE, not accumulate
    fiveMore(f);
    const second = JSON.parse(JSON.stringify(artifact()));
    second.schema = 'libra.canonical_artifact.v5';
    for (const x of [...second.entities, ...second.facts]) {
      for (const s of x.evidenceSpans || []) s.ref = s.ref.replace(/^t(\d+)/, (_, n) => `t${Number(n) + 5}`);
    }
    const mina2 = second.entities.find(e => e.name === '민아');
    second.facts.push(infoFact(f.chat, mina2.tempId, 'x3', 'preference', '민트차를 싫어한다', '민아는 민트차를 싫어한다', 't9-a'));
    f.control.artifact = second;
    assert.equal((await f.run()).completed, 1, `${mode}: the replacement batch commits`);
    const afterReplace = charOf(headJson(snapshot), '민아')?.state?.preferences || [];
    observation.afterReplace = afterReplace;
    observation.replacedCount = afterReplace.length;
    observation.oldWordingKept = /민트차를 좋아한다/.test(JSON.stringify(afterReplace));
    observation.newWordingPresent = /민트차를 싫어한다/.test(JSON.stringify(afterReplace));
    // the unrelated item must be untouched by the replacement
    observation.siblingUntouched = /홍차를 좋아한다/.test(JSON.stringify(afterReplace));

    assert.equal(observation.oldWordingKept, false, `${mode}: the earlier wording of the same topic is replaced, not kept`);
    assert.equal(observation.newWordingPresent, true, `${mode}: the later value is the one stored`);
    assert.equal(observation.siblingUntouched, true, `${mode}: an unrelated topic is not touched by the replacement`);
    assert.equal(observation.replacedCount, 2, `${mode}: one topic replaced, one sibling kept`);

    // batch 3 (t11..t15): REMOVE one item by NAMING it.
    // `03` A09 forbids a whole-array clear ("배열 전체 clear"), so the removal names the
    // item it takes out; the sibling must survive.
    //
    // `fiveMore` extends the chat by five turns (t6..t10) and does not generate t11+,
    // so this batch builds its own five-turn window instead of citing rows that do not
    // exist: the citation must be a row the validator can actually read.
    const nextTurns = f.chat.message.slice(10, 20);
    const extra = nextTurns.map((m, i) => ({ ...m, chatId: `t${11 + Math.floor(i / 2)}-${i % 2 ? 'a' : 'u'}` }));
    f.chat.message.push(...extra);
    f.chat.messages = f.chat.message;
    const third = JSON.parse(JSON.stringify(artifact()));
    third.schema = 'libra.canonical_artifact.v5';
    for (const x of [...third.entities, ...third.facts]) {
      for (const s of x.evidenceSpans || []) s.ref = s.ref.replace(/^t(\d+)/, (_, n) => `t${Number(n) + 10}`);
    }
    const mina3 = third.entities.find(e => e.name === '민아');
    // Phase C removes the exact typed subject+topic selector. It does not use a
    // whole-collection clear or a bracket-string topic hidden in free text.
    const removalQuote = '민아는 민트차 취향을 목록에서 지웠고 홍차 취향은 남겼다.';
    const removalRow = f.chat.message.find(row => row.chatId === 't14-a');
    removalRow.data = `${removalRow.data || ''} ${removalQuote}`.trim();
    third.facts.push({
      tempFactId: 'x4', domain: 'character', subjectTempRef: mina3.tempId, claimKind: 'character_preference',
      values: { preferences: [{ content: '민트차를 싫어한다', topic: '민트차', kind: 'dislike' }] },
      text: removalQuote,
      temporalRole: 'current_sequence', certainty: 'confirmed', effect: 'remove',
      evidenceSpans: [{ ref: 't14-a', quote: removalQuote }]
    });
    third.stateBindings.push({factTempId:'x4',typedValueField:'preferences',stateDomain:'character',stateField:'preferences'});
    f.control.artifact = third;
    const thirdRun = await f.run();
    observation.removeBatch = thirdRun.completed;
    const afterRemove = charOf(headJson(snapshot), '민아')?.state?.preferences || [];
    observation.afterRemove = afterRemove;
    observation.removeReceipt = snapshot.getRecords('libra.state_pipeline_receipt.v1').map(r => r.value?.pending || []).flat().slice(-4);
    observation.removed = !/민트차/.test(JSON.stringify(afterRemove));
    observation.remainingSibling = /홍차를 좋아한다/.test(JSON.stringify(afterRemove));
    assert.equal(observation.removed, true, `${mode}: the named item is gone from the Head`);
    assert.equal(observation.remainingSibling, true, `${mode}: the sibling survives the removal (no whole-array clear)`);
    assert.equal(afterRemove.length, 1, `${mode}: exactly the named item was removed, one sibling remains`);
  } finally { await snapshot.cleanup(); }
  return observation;
};

const run = async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  // The three modes must agree on the outcome.
  const project = r => ({ before: r.before, afterReplace: r.afterReplace, afterRemove: r.afterRemove });
  assert.deepEqual(project(results.mirror), project(results.plugin_only), 'mirror matches plugin_only');
  assert.deepEqual(project(results.server_only), project(results.plugin_only), 'server_only matches plugin_only');
  console.log(JSON.stringify({
    test: 'libra_main_memory_replacement_and_removal',
    passed: 1,
    boundary: 'real storage in three modes: same subject+topic replaced, then removed, each re-read from the Head',
    results
  }));
};
run().catch(error => { console.error(error?.message || error); console.error(error?.stack); process.exit(1); });
