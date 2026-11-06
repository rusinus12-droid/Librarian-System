'use strict';
// A memory that is not a confirmed current fact never replaces or erases a value that stands, unless the user approves it.
const assert = require('node:assert/strict');
const {create, pause} = require('./fixtures/libra_gui_memory_dom_host.cjs');
const {artifact} = require('./fixtures/libra_unified_runtime_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');

const STAMP = '⏱️[2026-05-14 (목) 09:12 PM]', CLOCK = '2026-05-14 (목) 09:12 PM';
const evidence = n => [{ref: `t${n}-a`, quote: input.sourceRows.find(r => r.ref === `t${n}-a`).text}];
const scenario = async (label, extend, check) => {
  let f;
  try {
    f = await create('LIBRA', 'Full', {initialChat: input.sourceRows.map(r => ({role: r.role, chatId: r.ref, data: r.ref === 't4-a' ? `${STAMP} ${r.text}` : r.text})), host: {runLLMModel: async () => {
      const a = artifact();
      const add = (id, domain, subject, kind, values, text, extra, typed) => { a.facts.push({tempFactId: id, domain, subjectTempRef: subject, claimKind: kind, values, text, temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: evidence(4), ...extra}); a.stateBindings.push({factTempId: id, typedValueField: typed, stateDomain: domain, stateField: typed}); };
      extend(a, add);
      return {type: 'success', result: JSON.stringify(a)};
    }}});
    await f.open();
    assert.equal((await f.api.runManualColdStart()).completed, 1, `${label}: the memory is saved`);
    await pause(300);
    await check(f, (await f.api.debugLoadContinuityStateForResponse()).head);
    assert.deepEqual(f.errors, [], label);
  } finally { await f?.close(); }
};
const guess = a => a.facts.push({tempFactId: 'guess', domain: 'character', subjectTempRef: 'jiho', claimKind: 'note', values: {detail: '짐작'}, text: '지호의 짐작', temporalRole: 'uncertain', certainty: 'uncertain', evidenceSpans: evidence(4)});
const located = head => { const mina = head.characters.find(r => r.name === '민아'); return {mina, study: head.world.find(r => r.name === '서재'), hall: head.world.find(r => r.name === '공연실')}; };

(async () => {
  await scenario('conditional clear', (a, add) => { guess(a); add('gone', 'character', 'mina', 'location', {locationRef: null}, '짐작이 맞다면 민아는 서재를 떠났다.', {effect: 'clear', dependsOn: ['guess']}, 'locationRef'); }, async (f, head) => {
    const {mina, study} = located(head);
    assert.equal(mina.state.locationRef, study.id, 'a conditional clear does not erase the location');
    assert.equal(mina.clearedFieldEvidence?.locationRef, undefined, 'and it is not reported as cleared');
    const candidate = mina.fieldCandidates.locationRef[0];
    assert.equal(candidate.recordedTurn, 4);assert.equal(candidate.recordedClock, CLOCK, 'it says when it was recorded');
    assert.equal(candidate.clear, true);assert.equal(candidate.conditional, true);assert.equal(candidate.restsOn[0], '지호의 짐작');
    const row = (await f.api.listMemoryReviews()).rows.find(r => r.factId === 'gone');
    assert.equal(row.stateOutcome, 'candidate');
    // Only the user's approval lets it take effect.
    const catalog = await f.api.listMemoryReviews();
    assert.equal((await f.api.setMemoryReviewDecision({scopeKey: catalog.scopeKey, previewDigest: catalog.previewDigest, ids: [row.id], status: 'confirmed'})).ok, true);
    const approved = located((await f.api.debugLoadContinuityStateForResponse()).head).mina;
    assert.equal(approved.state.locationRef, undefined, 'approved, it clears the value');
    assert.equal(approved.clearedFieldEvidence.locationRef.meaning.conditional, true, 'and still says what it rested on');
  });

  await scenario('confirmed, then uncertain, then confirmed', (a, add) => {
    add('maybe', 'character', 'mina', 'location', {locationRef: 'hall'}, '민아가 공연실에 있을지도 모른다.', {certainty: 'uncertain'}, 'locationRef');
    add('later', 'character', 'mina', 'location', {locationRef: 'library'}, '민아가 도서관으로 돌아왔다.', {evidenceSpans: evidence(5)}, 'locationRef');
  }, async (f, head) => {
    const {mina} = located(head);
    assert.equal(mina.state.locationRef, head.world.find(r => r.name === '도서관').id, 'the newest confirmed value is current');
    assert.equal(mina.fieldEvidence.locationRef.meaning, undefined);
    assert.equal(mina.fieldCandidates.locationRef.map(c => c.claim).join(), '민아가 공연실에 있을지도 모른다.');
  });

  await scenario('empty field', (a, add) => {
    add('maybe', 'character', 'jiho', 'location', {locationRef: 'hall'}, '지호가 공연실에 있을지도 모른다.', {certainty: 'uncertain', evidenceSpans: evidence(5)}, 'locationRef');
  }, async (f, head) => {
    const jiho = head.characters.find(r => r.name === '지호');
    assert.equal(jiho.state.locationRef, head.world.find(r => r.name === '공연실').id, 'an empty field still fills, as automatic use promises');
    assert.equal(jiho.fieldEvidence.locationRef.meaning.certainty, 'uncertain', 'with its mark');
    assert.equal(jiho.fieldEvidence.locationRef.meaning.recordedTurn, 5, 'its own evidence turn');
    assert.equal(jiho.fieldEvidence.locationRef.meaning.recordedClock, undefined, 'no printed time, no clock');
    assert.equal(jiho.fieldCandidates, undefined);
  });

  await scenario('another time, empty field', (a, add) => {
    add('then', 'character', 'jiho', 'location', {locationRef: 'hall'}, '지호는 예전에 공연실에 있었다.', {temporalRole: 'historical'}, 'locationRef');
  }, async (f, head) => {
    const jiho = head.characters.find(r => r.name === '지호');
    assert.equal(jiho.state.locationRef, undefined, 'a past location is not where someone is now');
    assert.equal(jiho.fieldCandidates.locationRef[0].temporalRole, 'historical');
    assert.equal((await f.api.listMemoryReviews()).rows.find(r => r.factId === 'then').stateOutcome, 'candidate');
    f.doc.querySelector('.sidebar [data-go="people"]').click();await pause(400);
    [...f.doc.querySelectorAll('[data-select-row]')].find(n => n.textContent.includes('지호')).click();await pause(300);
    const shown = f.doc.querySelector('[data-detail] [data-state-candidate="set"]');
    assert.ok(shown, 'the person page shows it without a value line');
    assert.ok(shown.textContent.includes(`기록 T4 | ${CLOCK}`), 'with when it was recorded');
  });
  console.log('PASS limited memories never replace or erase a standing value without approval');
})().catch(error => { console.error(error); process.exitCode = 1; });
