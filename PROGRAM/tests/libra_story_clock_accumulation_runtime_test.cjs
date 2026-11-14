'use strict';
// Story clock (docs/gradia/STATE-AIDE-DESIGN-20261114.md §10-11, steps 1-2): the per-pair Micro
// call reports time_advance, LIBRA accumulates it into a per-pair day in both storage modes, the
// user can set an anchor date and correct a pair, and lens notes carry the day of their source turn.
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const CLOCK_KEY = 'libra:v1:scope:seventh-server-scope:story-clock:v1';
const plain = value => JSON.parse(JSON.stringify(value));

const envelope = (receipt, turn, timeAdvance) => {
  const quote = receipt.assistant.text;
  return {schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
    micro: {schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey, worldlineId: receipt.worldlineId,
      sessionEpoch: receipt.sessionEpoch, turn, sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
      claims: [{changeKind: 'event', text: quote, actor: '', target: '', temporalRole: 'current', certainty: 'confirmed',
        epistemicStatus: 'observed', stateChangeType: 'none', evidence: {role: 'assistant', messageId: receipt.assistant.chatId,
          startOffset: 0, endOffset: quote.length, exactQuote: quote}}]},
    ...(timeAdvance === undefined ? {} : {timeAdvance})};
};

const pureTimeline = core => {
  const t = (clock, pairs) => plain(core.computeStoryClockTimeline(clock, pairs));
  const pairs = n => Array.from({length: n}, (_, i) => ({turn: i + 1, revisionId: `r${i + 1}`}));
  const clock = (rows, extra = {}) => ({schema: 'libra.story_clock.v1', scopeKey: 's', pairs: Object.fromEntries(rows.map(([turn, advance, rev]) =>
    [String(turn), {advance, sourceRevisionId: rev || `r${turn}`}])), corrections: {}, ...extra});
  // Counted from the first pair: same-day, +N days, a same-day time earlier than now rolls over.
  let view = t(clock([[1, {kind: 'none'}], [2, {kind: 'same_day', timeOfDay: 'evening'}], [3, {kind: 'days', days: 2, timeOfDay: 'morning'}],
    [4, {kind: 'same_day', timeOfDay: 'night'}], [5, {kind: 'same_day', timeOfDay: 'dawn'}]]), pairs(5));
  assert.deepEqual(view.entries.map(e => [e.day, e.timeOfDay, e.basis]), [[1, '', 'story'], [1, 'evening', 'story'], [3, 'morning', 'story'], [3, 'night', 'story'], [4, 'dawn', 'story']]);
  assert.equal(view.current.day, 4);
  // Pairs the clock never saw stay unknown; counting then starts on the clock basis.
  view = t(clock([[3, {kind: 'days', days: 5}], [4, {kind: 'days', days: 1}]]), pairs(4));
  assert.deepEqual(view.entries.map(e => [e.known, e.day, e.status]), [[false, null, 'before_clock'], [false, null, 'before_clock'], [true, 1, 'recorded'], [true, 2, 'recorded']]);
  assert.equal(view.basis, 'clock');
  // An edited pair (revision changed) no longer counts, later days become estimates.
  view = t(clock([[1, {kind: 'none'}], [2, {kind: 'days', days: 3}, 'old'], [3, {kind: 'days', days: 1}]]), pairs(3));
  assert.deepEqual(view.entries.map(e => [e.day, e.status, e.estimated]), [[1, 'recorded', false], [1, 'missing', true], [2, 'recorded', true]]);
  // Absolute dates: the first one dates every earlier day; a later one moves the count forward;
  // one before the current day is ignored for counting.
  view = t(clock([[1, {kind: 'none'}], [2, {kind: 'days', days: 1}], [3, {kind: 'date', date: '2026-04-10'}], [4, {kind: 'date', date: '2026-04-13'}], [5, {kind: 'date', date: '2026-04-01'}]]), pairs(5));
  assert.deepEqual(view.entries.map(e => [e.day, e.date]), [[1, '2026-04-09'], [2, '2026-04-10'], [2, '2026-04-10'], [5, '2026-04-13'], [5, '2026-04-13']]);
  assert.equal(view.entries[4].dateConflict, true);
  // The anchor dates day 1; a correction resets the count and every later pair follows.
  view = t(clock([[1, {kind: 'none'}], [2, {kind: 'days', days: 1}], [3, {kind: 'days', days: 2}]], {anchorDate: '2026-01-30', corrections: {2: {day: 10}}}), pairs(3));
  assert.deepEqual(view.entries.map(e => [e.day, e.date, e.status]), [[1, '2026-01-30', 'recorded'], [10, '2026-02-08', 'corrected'], [12, '2026-02-10', 'recorded']]);
  // A correction on a pair before the clock starts the count there on the story basis.
  view = t(clock([[3, {kind: 'days', days: 1}]], {corrections: {2: {day: 4, date: '2026-05-05'}}}), pairs(3));
  assert.deepEqual(view.entries.map(e => [e.known, e.day, e.date]), [[false, null, ''], [true, 4, '2026-05-05'], [true, 5, '2026-05-06']]);
  assert.equal(view.basis, 'story');
  // Malformed reports are no report.
  view = t(clock([[1, {kind: 'days', days: 0}], [2, {kind: 'date', date: '2026-02-30'}], [3, {kind: 'later'}]]), pairs(3));
  assert.ok(view.entries.every(e => !e.known) && view.current === null);
};

(async () => {
  for (const mode of ['plugin_only', 'server_only']) {
    let listener;
    const fixture = await serverFixture({mode, host: {addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }}});
    try {
      let {f} = fixture, api = f.r.api;
      if (mode === 'plugin_only') pureTimeline(f.r.core);
      assert.equal((await f.run()).completed, 1);
      const stored = () => mode === 'plugin_only' ? (fixture.local.has(CLOCK_KEY) ? JSON.parse(fixture.local.get(CLOCK_KEY)) : null)
        : fixture.storedRows().find(row => row.key === CLOCK_KEY)?.value || null;
      // Pairs 1-5 were captured before the clock: unknown, and no lens line claims a day.
      let clock = await api.getStoryClock();
      assert.equal(clock.current, null);
      assert.ok(clock.entries.length >= 5 && clock.entries.every(e => e.known === false && e.label === '일차 모름'));

      const reports = {6: {kind: 'days', days: 2, timeOfDay: 'evening'}, 7: {kind: 'same_day', timeOfDay: 'night'}, 8: {kind: 'days', days: 1, timeOfDay: 'morning'}};
      const texts = {6: '다음 날 저녁, 민아가 공연실로 이동했다.', 7: '그날 밤 민아는 열쇠를 숨겼다.', 8: '이튿날 아침, 민아는 열이 났다.'};
      for (const turn of [6, 7, 8]) {
        f.control.onCall = async () => {
          const {receipt} = await api.debugReadActiveCompletedTurnReceipt(turn);
          return {type: 'success', result: JSON.stringify(envelope(receipt, turn, reports[turn]))};
        };
        f.chat.message.push({role: 'user', chatId: `t${turn}-u`, data: '계속'}, {role: 'assistant', chatId: `t${turn}-a`, data: texts[turn]});
        listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: f.chat.message.length - 1});
        await waitFor(() => api.getCaptureBackendState().lastMicroPublication?.turn === turn, 15000);
        await waitFor(async () => Boolean((await api.getStoryClock()).entries.find(e => e.turn === turn)?.known), 5000);
      }
      const prompt = f.control.calls[f.control.calls.length - 1];
      assert.ok(JSON.stringify(prompt).includes('TIME ADVANCE'), 'the existing Micro call carries the time_advance request');
      const microCalls = f.control.calls.length;

      clock = await api.getStoryClock();
      const day = turn => clock.entries.find(e => e.turn === turn);
      assert.deepEqual([6, 7, 8].map(turn => [day(turn).day, day(turn).timeOfDay, day(turn).basis]), [[1, 'evening', 'clock'], [1, 'night', 'clock'], [2, 'morning', 'clock']]);
      assert.equal(day(5).known, false, 'a pair from before the clock stays unknown');
      assert.equal(clock.currentLabel, '기록 2일째 · 아침');
      const record = stored();
      assert.equal(record?.schema, 'libra.story_clock.v1', `${mode}: the clock is stored through the active storage mode`);
      assert.deepEqual(Object.keys(record.pairs).sort(), ['6', '7', '8'], 'raw reports are stored, days are derived');
      if (mode === 'server_only') assert.equal(fixture.local.has(CLOCK_KEY), false, 'server mode keeps no plugin copy');

      // Anchor date and a correction; later pairs count on from the corrected pair.
      await assert.rejects(api.setStoryClockAnchor('2026-02-30'), /YYYY-MM-DD/);
      clock = await api.setStoryClockAnchor('2026-04-01');
      assert.deepEqual([6, 7, 8].map(turn => day(turn).date), ['2026-04-01', '2026-04-01', '2026-04-02']);
      clock = await api.correctStoryClockTurn(7, {day: 5});
      assert.deepEqual([6, 7, 8].map(turn => [day(turn).day, day(turn).date]), [[1, '2026-04-01'], [5, '2026-04-05'], [6, '2026-04-06']]);
      await assert.rejects(api.correctStoryClockTurn(99, {day: 1}), /이 채팅에 없는 턴/);
      await assert.rejects(api.correctStoryClockTurn(7, {day: 0}), /일차/);

      // The clock survives a reload of the plugin in the same storage mode.
      const added = f.chat.message.slice(10);
      f = await fixture.restart(); api = f.r.api;
      if (f.chat.message.length === 10) f.chat.message.push(...added);
      clock = await api.getStoryClock();
      assert.equal(clock.anchorDate, '2026-04-01');
      assert.deepEqual([6, 7, 8].map(turn => day(turn).day), [1, 5, 6]);
      clock = await api.correctStoryClockTurn(7, null);
      assert.deepEqual([6, 7, 8].map(turn => day(turn).day), [1, 1, 2], 'removing the correction re-accumulates');

      // Lens notes carry the day of their source turn; GRADIA-facing structured days too.
      const lens = await api.createLens({name: '시계 렌즈', instruction: {goal: '몸 상태 기록'}, evidenceMode: 'strict', trackTime: true, trackSubject: false,
        recall: {enabled: true, mode: 'recent', maxItems: 4, share: 100}});
      f.control.onCall = async () => ({type: 'success', result: JSON.stringify({items: [
        {label: '증상', text: 'CLOCK_NOTE_A 민아가 열이 났다.', quote: '민아는 열이 났다', refs: ['t8-a'], when: {text: '이튿날 아침', ref: 't8-a'}},
        {label: '사건', text: 'CLOCK_NOTE_B 민아가 열쇠를 숨겼다.', quote: '민아는 열쇠를 숨겼다', refs: ['t7-a']}]})});
      const run = await f.r.core.runLensForRange(lens.lensId, {startTurn: 6, endTurn: 8});
      assert.equal(run.acceptedCount, 2, JSON.stringify(run));
      const callsBefore = f.control.calls.length;
      const recall = await api.recallLensMemories({queryText: '민아 열 열쇠', maxChars: 12000, semantic: false, refreshVectors: false, readOnly: true});
      assert.equal(f.control.calls.length, callsBefore, 'reading days calls no model');
      const note = tag => recall.injectedItems.find(item => item.text.includes(tag));
      assert.deepEqual([note('CLOCK_NOTE_A').storyDay.day, note('CLOCK_NOTE_A').storyDay.date], [2, '2026-04-02']);
      assert.deepEqual([note('CLOCK_NOTE_B').storyDay.day, note('CLOCK_NOTE_B').storyDay.turn], [1, 7]);
      assert.ok(note('CLOCK_NOTE_A').renderedLine.includes('기록 2일째 · 아침 · 2026-04-02'), note('CLOCK_NOTE_A').renderedLine);
      assert.equal(recall.storyClock.current.day, 2);
      assert.ok(recall.renderedBlock.includes('[STORY CLOCK] 현재: 기록 2일째 · 아침 · 2026-04-02 (T8 기준)'), recall.renderedBlock);
      assert.ok(microCalls > 0);
      console.log(`PASS story clock accumulation, anchor, correction, persistence and lens days in ${mode}`);
    } finally { await fixture.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
