'use strict';
// Story time on lens notes (docs/LIBRA_LENS_TIME_DESIGN_20261020.md): a tracking lens copies the
// date/time the analyzed source states, or marks it unknown; it never computes or guesses one.
// Covers the gate, the prompt, records and counts, recall, and preservation through handoff,
// a second handoff, native copy and portable export/restore.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const batch = [
  { turn: 1, user: { text: '3월 4일 아침, 민아는 병원에 갔다.' }, assistant: { text: '의사는 다음 날 아침에 다시 오라고 했다. 진료 예약은 3월 9일이다.' } },
  { turn: 2, user: { text: '그로부터 사흘 뒤 민아는 열이 내렸다.' }, assistant: { text: '민아의 상처가 아물기 시작했다.' } }
];
const TIME_LENS = { evidenceMode: 'interpretive', trackTime: true };
const item = extra => ({ label: '건강', text: '민아가 병원에 갔다.', refs: ['t1-u'], quote: '민아는 병원에 갔다', ...extra });

test('gate and prompt through the real plugin', async () => {
  const f = await lensFixture();
  try {
    const api = f.api;
    const evaluate = (items, lens = TIME_LENS) => plain(api.evaluateLensCandidateItems({ items }, lens, batch));

    const stated = evaluate([item({ when: '3월 4일 아침', whenRef: 't1-u' })]);
    assert.deepEqual(stated.acceptedItems[0].when, { text: '3월 4일 아침', ref: 't1-u' });
    assert.equal(stated.acceptedItems[0].whenIssue, '');

    const otherTurn = evaluate([item({ refs: ['t2-a'], quote: '상처가 아물기 시작했다', text: '상처가 아물기 시작했다.', when: '그로부터 사흘 뒤', whenRef: 't2-u' })]);
    assert.deepEqual(otherTurn.acceptedItems[0].when, { text: '그로부터 사흘 뒤', ref: 't2-u' }, 'the time may be stated in a turn the note does not cite');

    const wrongRef = evaluate([item({ when: '3월 4일 아침', whenRef: 't2-a' })]);
    assert.equal(wrongRef.acceptedItems[0].when.ref, 't1-u', 'the stored ref is the turn where the text was actually found');

    const spacing = evaluate([item({ when: '3월4일아침' })]);
    assert.equal(spacing.acceptedItems[0].when.text, '3월 4일 아침', 'a whitespace variant stores the source wording');

    const relative = evaluate([item({ refs: ['t1-a'], quote: '다시 오라고 했다', text: '재진료 지시', when: '다음 날 아침', whenRef: 't1-a' })]);
    assert.equal(relative.acceptedItems[0].when.text, '다음 날 아침', 'a relative expression is kept as written, not converted');

    // The earlier absolute date is outside this span: the relative expression is still kept as written.
    const laterSpan = plain(api.evaluateLensCandidateItems({ items: [item({ refs: ['t2-u'], quote: '열이 내렸다', text: '열이 내렸다.', when: '그로부터 사흘 뒤' })] }, TIME_LENS, [batch[1]]));
    assert.deepEqual(laterSpan.acceptedItems[0].when, { text: '그로부터 사흘 뒤', ref: 't2-u' });

    const missing = evaluate([item({})]);
    assert.equal(missing.acceptedItems.length, 1, 'a note without a time is kept');
    assert.equal(missing.acceptedItems[0].when, null);
    assert.equal(missing.acceptedItems[0].whenIssue, '');

    const invented = evaluate([item({ when: '2026년 3월 4일 오후 3시' })]);
    assert.equal(invented.acceptedItems[0].when, null, 'a time not in the source is discarded');
    assert.equal(invented.acceptedItems[0].whenIssue, 'not_in_source');
    assert.ok(!JSON.stringify(invented.acceptedItems[0]).includes('오후 3시'), 'the discarded text is not kept');

    const outside = evaluate([item({ when: '3월 20일', whenRef: 't9-u' })]);
    assert.equal(outside.acceptedItems[0].when, null, 'an out-of-range whenRef cannot reach outside the span');

    // A literal check, not a semantic one: an in-span date for another event still passes.
    const wrongEvent = evaluate([item({ when: '3월 9일', whenRef: 't1-a' })]);
    assert.deepEqual(wrongEvent.acceptedItems[0].when, { text: '3월 9일', ref: 't1-a' }, 'the literal gate cannot detect a date assigned to the wrong event');

    const counts = evaluate([item({ when: '3월 4일 아침' }), item({ text: '두 번째', when: '없는 날', refs: ['t1-a'], quote: '진료 예약은 3월 9일이다' }), item({ text: '세 번째', refs: ['t2-a'], quote: '상처가 아물기 시작했다' })]).counts;
    assert.deepEqual({ stated: counts.timeStated, unknown: counts.timeUnknown, dropped: counts.timeDropped }, { stated: 1, unknown: 2, dropped: 1 });
    assert.equal(counts.timeStated + counts.timeUnknown, counts.quoted + counts.interpreted, 'stated + unknown = accepted');

    const off = evaluate([item({ when: '3월 4일 아침', whenRef: 't1-u' })], { evidenceMode: 'interpretive' });
    assert.equal('when' in off.acceptedItems[0], false, 'a non-tracking lens stores no time');
    assert.equal(off.counts.timeUnknown, undefined, 'a non-tracking lens has no time counts');
    assert.equal('when' in off.acceptedItems[0].extra, false, 'a model-given time never leaks into extra values');

    f.setReply({ items: [item({ refs: ['t2-a'], quote: '오늘 돌려주겠다고 약속했다', text: '반환 약속', when: '오늘' }), item({ refs: ['t2-a'], quote: '오늘 돌려주겠다고 약속했다', text: '반환 약속 2', when: '어제 저녁' })] });
    const trial = plain(await api.trialRunLens({ draftLens: { name: '초안', trackTime: true, evidenceMode: 'interpretive', instruction: { goal: '약속' } } }));
    assert.deepEqual({ s: trial.run.counts.timeStated, u: trial.run.counts.timeUnknown, d: trial.run.counts.timeDropped }, { s: 1, u: 1, d: 1 }, 'trial results carry the time counts');
    assert.equal((await api.inspectScopeLenses()).memories.length, 0, 'a trial stores nothing');

    const calls = [];
    f.setReply(args => { calls.push(JSON.stringify(args)); return '{"items":[]}'; });
    const tracking = await api.createLens({ name: '시점 렌즈', trackTime: true, instruction: { goal: '건강' }, cadence: { mode: 'manual' } });
    const quiet = await api.createLens({ name: '분위기 렌즈', instruction: { goal: '분위기' }, cadence: { mode: 'manual' } });
    await f.r.core.runLensForRange(tracking.lensId, { startTurn: 1, endTurn: 5 });
    await f.r.core.runLensForRange(quiet.lensId, { startTurn: 1, endTurn: 5 });
    assert.match(calls[0], /Never calculate, convert, complete or guess a date or time/);
    assert.match(calls[0], /whenRef/);
    assert.doesNotMatch(calls[1], /whenRef|Story time/, 'the time rules appear only for a tracking lens');
  } finally { await f.close(); }
});

test('records keep their own setting; counts persist; recall states the time', async () => {
  const f = await lensFixture();
  try {
    const api = f.api;
    const lens = await f.add('건강 렌즈', 'active', { trackTime: true });
    const revision = lens.instructionRevision;
    f.setReply({ items: [
      { label: '약속', text: '지호가 열쇠를 오늘 돌려주기로 했다.', refs: ['t2-a'], quote: '오늘 돌려주겠다고 약속했다', when: '오늘', whenRef: 't2-a' },
      { label: '보관', text: '준호가 열쇠를 들었다.', refs: ['t3-a'], quote: '준호가 지호에게서 열쇠를 받아 들었다' }
    ] });
    const run = await f.r.core.runLensForRange(lens.lensId, { startTurn: 1, endTurn: 5 });
    assert.deepEqual({ s: run.run.counts.timeStated, u: run.run.counts.timeUnknown, d: run.run.counts.timeDropped }, { s: 1, u: 1, d: 0 });
    const logged = (await api.inspectScopeLenses()).lenses[lens.lensId].runs[0].counts;
    assert.equal(logged.timeStated + logged.timeUnknown, logged.quoted + logged.interpreted, 'persisted run log keeps the invariant');

    let view = (await api.inspectScopeLenses()).memories.filter(row => row.lensId === lens.lensId);
    const stated = view.find(row => row.when), unknown = view.find(row => !row.when);
    assert.equal(stated.whenTracked, true);
    assert.equal(unknown.whenTracked, true, 'unknown time is distinct from not recorded');

    let recall = await api.recallLensMemories({ query: '지호 열쇠 약속 오늘', canonicalBudgetChars: 12000 });
    assert.match(recall.renderedBlock, /\(T1–T5 · 시점: 오늘 · 약속\)/);
    recall = await api.recallLensMemories({ query: '준호 열쇠 보관', canonicalBudgetChars: 12000 });
    assert.match(recall.renderedBlock, /\(T1–T5 · 시점 불명 · 보관\)/);

    recall = await api.recallLensMemories({ query: '오늘', canonicalBudgetChars: 12000 });
    assert.match(recall.renderedBlock, /시점: 오늘/, 'the time text counts toward relevance');

    const updated = await api.updateLens(lens.lensId, { trackTime: false });
    assert.equal(updated.instructionRevision, revision, 'the switch does not change the instruction revision');
    view = (await api.inspectScopeLenses()).memories.filter(row => row.lensId === lens.lensId);
    assert.ok(view.every(row => row.whenTracked === true), 'turning the switch off does not change older records');
    recall = await api.recallLensMemories({ query: '준호 열쇠 보관', canonicalBudgetChars: 12000 });
    assert.match(recall.renderedBlock, /시점 불명/, 'recall follows the record setting, not the current switch');

    f.setReply({ items: [{ label: '약속', text: '민아의 은빛 열쇠가 지호에게 넘어갔다.', refs: ['t2-a'], quote: '은빛 열쇠를 빌려 받았고', when: '오늘', whenRef: 't2-a' }] });
    await f.add('기록 안 하는 렌즈');
    const plainRecall = await api.recallLensMemories({ query: '지호 은빛 열쇠 반환 약속', canonicalBudgetChars: 12000 });
    const untrackedLine = plainRecall.renderedBlock.split('\n').find(line => line.includes('[lens:기록 안 하는 렌즈'));
    assert.ok(untrackedLine && !/시점/.test(untrackedLine), 'a record made without tracking has no time part');
  } finally { await f.close(); }
});

const LONG_FILLER = '비가 그치지 않았다. '.repeat(450);
const longChat = f => { f.chat.message[4].data = `지호는 준호에게 잠시 열쇠를 들어 달라고 부탁했다. ${LONG_FILLER}그날 밤 열 시, 민아는 일기를 썼다.`; };
const timeReply = { items: [
  { label: '약속', text: '지호의 열쇠 반환 약속', refs: ['t2-a'], quote: '오늘 돌려주겠다고 약속했다', when: '그날 밤 열 시', whenRef: 't3-u' },
  { label: '부탁', text: '지호가 준호에게 열쇠를 맡겼다.', refs: ['t3-u'], quote: '지호는 준호에게 잠시 열쇠를 들어 달라고 부탁했다', when: '그날 밤 열 시', whenRef: 't3-u' },
  { label: '보관', text: '준호가 열쇠를 들었다.', refs: ['t3-a'], quote: '준호가 지호에게서 열쇠를 받아 들었다' }
] };
const inheritedTimes = async f => plain((await f.api.inspectScopeLenses()).memories.filter(row => row.inherited));
const checkInherited = (rows, label) => {
  const far = rows.find(row => row.label === '약속');
  assert.deepEqual(far.when, { text: '그날 밤 열 시', ref: 't3-u' }, `${label}: stated time survives`);
  assert.ok(!far.refs.includes('t3-u'), `${label}: the time turn is not among the cited refs`);
  assert.ok(far.sourceTurns['t3-u'].includes('그날 밤 열 시'), `${label}: the archived excerpt holds the time beyond the 4,000-character prefix`);
  const distant = rows.find(row => row.label === '부탁');
  assert.ok(distant.sourceTurns['t3-u'].includes('지호는 준호에게 잠시 열쇠를') && distant.sourceTurns['t3-u'].includes('그날 밤 열 시'), `${label}: distant quote and time in one turn are both kept`);
  assert.ok(distant.sourceTurns['t3-u'].length < 4000, `${label}: the excerpt stays bounded`);
  const unknown = rows.find(row => row.label === '보관');
  assert.equal(unknown.when, null);
  assert.equal(unknown.whenTracked, true, `${label}: unknown stays unknown`);
};

test('handoff, a second handoff, native copy and portable round trip keep time provenance', async () => {
  const f = await lensFixture({ beforeRun: longChat });
  try {
    const api = f.api;
    const lens = await api.createLens({ name: '시점 렌즈', trackTime: true, evidenceMode: 'interpretive', instruction: { goal: '약속과 시점' }, cadence: { mode: 'manual' } });
    f.setReply(timeReply);
    assert.equal((await f.r.core.runLensForRange(lens.lensId, { startTurn: 1, endTurn: 5 })).acceptedCount, 3);
    const live = (await api.inspectScopeLenses()).memories.filter(row => !row.inherited);
    assert.ok((await api.inspectScopeLenses()).sourceTurns['t3-u'].includes('그날 밤 열 시'), 'the live reader excerpt holds a time past 4,000 characters');
    assert.equal(live.length, 3);

    await api.prepareSessionHandoff({ transferId: 'time-first' });
    const first = f.target('다음 대화');
    assert.equal((await api.adoptSessionHandoff({ transferId: 'time-first', targetChatId: first.id })).verified, true);
    checkInherited(await inheritedTimes(f), 'handoff');
    const archiveKey = f.manifest(first.id).value.inheritedLensArchives[0].archiveKey;
    const archive = JSON.parse(f.r.values.get(archiveKey));
    assert.equal(archive.lensDefinition.trackTime, true, 'the lens snapshot carries trackTime');
    assert.equal(archive.records[0].trackedTime, true);

    await api.prepareSessionHandoff({ transferId: 'time-second' });
    const second = f.target('그다음 대화');
    assert.equal((await api.adoptSessionHandoff({ transferId: 'time-second', targetChatId: second.id })).verified, true);
    checkInherited(await inheritedTimes(f), 'second handoff');

    const recall = await api.recallLensMemories({ query: '지호 열쇠 반환 약속', canonicalBudgetChars: 12000 });
    assert.match(recall.renderedBlock, /\[lens:시점 렌즈 · 이전 대화\] \(T1–T5 · 시점: 그날 밤 열 시 · 약속\)/);

    let envelope;
    for (let i = 0; i < 100 && !envelope; i += 1) {
      try { envelope = await f.r.context.__LIBRAPortableMemoryBackup.exportCurrentScope(); }
      catch (error) { if (!/busy|진행|처리/.test(String(error?.message))) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    const exported = envelope.records.filter(row => String(row.key).includes(':lens-handoff-archive:'));
    assert.ok(exported.length > 0);
    assert.ok(exported.every(row => JSON.parse(row.value).records.every(record => record.items.every(entry => entry.when === null || entry.when.text === '그날 밤 열 시'))), 'portable export carries the time fields unchanged');
    // The scope export (LIBRA GUI and RETRACE) carries the inherited archives as sidecars.
    const scopeExport = plain(await f.api.exportLibraScope());
    const sidecarArchives = Object.entries(scopeExport.canonicalSidecars).filter(([key]) => key.includes(':lens-handoff-archive:'));
    assert.ok(sidecarArchives.length >= 1 && sidecarArchives.some(([, archive]) => JSON.stringify(archive).includes('그날 밤 열 시')), 'scope export carries inherited lens archives with their times');
    // Restore: the archives come back from the envelope and read with their time provenance.
    for (const row of exported) f.r.values.delete(row.key);
    assert.equal((await inheritedTimes(f)).length, 0, 'removed archives are not readable');
    for (let i = 0; i < 100; i += 1) {
      try { await f.r.context.__LIBRAPortableMemoryBackup.restoreCurrentScope(envelope); break; }
      catch (error) { if (!/busy|진행|처리/.test(String(error?.message))) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    checkInherited(await inheritedTimes(f), 'portable restore');
  } finally { await f.close(); }
});

test('a native branch copy keeps stated times and their source excerpts', async () => {
  const f = await lensFixture({ beforeRun: longChat });
  try {
    const lens = await f.api.createLens({ name: '시점 렌즈', trackTime: true, evidenceMode: 'interpretive', instruction: { goal: '약속과 시점' }, cadence: { mode: 'manual' } });
    f.setReply(timeReply);
    await f.r.core.runLensForRange(lens.lensId, { startTurn: 1, endTurn: 5 });
    f.target('분기', true);
    const result = await f.api.debugNativeChatCopy({ force: true });
    assert.equal(result.result?.ok, true, JSON.stringify(result));
    checkInherited(await inheritedTimes(f), 'native copy');
  } finally { await f.close(); }
});

test('archives with no time data stay valid', async () => {
  const f = await lensFixture();
  try {
    await f.add();
    await f.api.prepareSessionHandoff({ transferId: 'old-shape' });
    const target = f.target();
    assert.equal((await f.api.adoptSessionHandoff({ transferId: 'old-shape', targetChatId: target.id })).verified, true);
    const rows = await inheritedTimes(f);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].whenTracked, false, 'an untracked record shows no time row');
    assert.equal(rows[0].when, null);
  } finally { await f.close(); }
});
