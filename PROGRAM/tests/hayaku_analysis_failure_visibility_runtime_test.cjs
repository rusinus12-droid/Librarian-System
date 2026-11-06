'use strict';
// A model that closes its envelope one brace early keeps the turn; a single-turn Cold Start retries a
// failed turn once in the same run; and a failure leaves its reason on screen with no source text.
const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, waitFor } = require('./fixtures/hayaku_runtime_harness.cjs');
const { createColdStartGuiDocument } = require('./fixtures/hayaku_cold_start_gui_dom_fixture.cjs');

const SECRET = 'PRIVATE_SOURCE_SENTINEL';
const sentence = n => `Alice opened box number ${n} and found a ribbon.`;
const chat = turns => Array.from({ length: turns }, (_, i) => [
  { role: 'user', id: `u${i + 1}`, chatId: `u${i + 1}`, data: `Continue ${i + 1}` },
  { role: 'assistant', id: `a${i + 1}`, chatId: `a${i + 1}`, data: sentence(i + 1) }
]).flat();
const envelope = quote => {
  const packet = createValidPacket({ turn: 1, subject: 'Alice', summary: quote });
  for (const axis of ['entity', 'world', 'narrative', 'planner']) for (const [key, value] of Object.entries(packet[axis])) if (Array.isArray(value)) packet[axis][key] = [];
  packet.world.active_events = [{ summary: quote }];
  return { schema: 'hayaku.native_repair_output.v1', packet, grounding: ['world.active_events[0]', 'meta.summary_memory.summary'].map(path => ({ path, source: 'target', evidence: [quote] })) };
};
const turnOf = call => Number((call.messages.map(m => m.content).join('\n').match(/box number (\d+) and found/) || [])[1] || 1);
const earlyClosed = quote => {
  const good = JSON.stringify(envelope(quote)), at = good.indexOf(',"grounding"');
  return good.slice(0, at) + '}' + good.slice(at);
};
const open = (options = {}) => createHayakuRuntime({ messages: chat(options.turns || 2), autoRepair: false, afterRequestAutoRepair: false, ...options });
const coldTurns = async r => (await r.hayaku.recovery.status({ includeDebts: true, refreshDebts: true })).debt.coverage;

(async () => {
  let r = await open();
  try {
    const parse = r.hayaku._test.parseNativeResponseForAdmission;
    if (typeof parse === 'function') {
      assert.equal(typeof parse(earlyClosed(sentence(1))).grounding, 'object', 'the brace is repaired');
      assert.equal(parse('{"a":1},"b":').b, undefined, 'a tail that cannot form one object is not joined');
      assert.equal(parse('{"a":1}{"b":2}').__hayaku_response_candidates.length, 2, 'two answers are not joined into one');
    }
    // Measured: packet closed right after meta, the root closed twice, and a meta field left outside meta.
    const norm = r.hayaku._test.normalizeNativeRepairEnvelope, shape = r.hayaku._test.validateNativeRepairGrounding;
    const full = envelope(sentence(1)), { meta, ...axes } = full.packet;
    const rootless = JSON.stringify({ schema: full.schema, packet: { meta }, entity: axes.entity, world: axes.world, narrative: axes.narrative, planner: axes.planner });
    const twice = rootless + ',"importance":' + JSON.stringify(axes.importance) + '},"grounding":' + JSON.stringify(full.grounding) + '}';
    const restored = norm(parse(twice));
    assert.deepEqual(Object.keys(restored).sort(), ['grounding', 'packet', 'schema'], 'one envelope comes back');
    assert.equal(restored.packet.world.active_events[0].summary, sentence(1), 'and nothing was left behind or emptied');
    assert.equal(JSON.stringify(restored.packet.importance), JSON.stringify(axes.importance));
    assert.equal(shape(restored, { targetText: sentence(1) }).ok, true, 'it still passes the evidence check');
    const stray = envelope(sentence(1)); stray.packet.speaker_boundaries = ['경계']; delete stray.packet.meta.speaker_boundaries;
    const moved = norm(JSON.parse(JSON.stringify(stray)));
    assert.equal(moved.packet.speaker_boundaries, undefined);
    assert.deepEqual([...moved.packet.meta.speaker_boundaries], ['경계']);
    const wrongEvidence = norm(parse(twice));
    assert.equal(shape(wrongEvidence, { targetText: 'something else entirely' }).ok, false, 'a repair never excuses the evidence');
    r.setLlmResponder(async call => ({ type: 'success', result: earlyClosed(sentence(turnOf(call))) }));
    const out = await r.hayaku.recovery.coldStart({ resume: true });
    assert.equal(out.completed, true, JSON.stringify(out));
    assert.equal(r.llmCalls.length, 2, 'the repaired answers need no retry');
    assert.deepEqual([...(await coldTurns(r)).coveredTurns], [1, 2]);
  } finally { await r.dispose(); }

  // One failed turn in a single-turn batch comes back in the same run.
  r = await open({ turns: 3 });
  const restoreColdLogWrites = [];
  try {
    require('node:vm').runInContext('Date.now = () => ' + Date.now(), r.context);
    for (const store of new Set([r.pluginStorage, r.safeLocalStorage])) {
      const set = store.setItem.bind(store);
      restoreColdLogWrites.push(() => { store.setItem = set; });
      store.setItem = async (key, value) => {
        if (String(key).startsWith('hayaku.v2.analysis_failure_log.') && JSON.parse(value).entries.some(row => row.resolution)) throw Error('injected_cold_diagnostic_write_failure');
        return await set(key, value);
      };
    }
    let failedOnce = false;
    r.setLlmResponder(async call => {
      const turn = turnOf(call);
      if (turn === 2 && !failedOnce) { failedOnce = true; return { type: 'success', result: 'not json' }; }
      return { type: 'success', result: JSON.stringify(envelope(sentence(turn))) };
    });
    const out = await r.hayaku.recovery.coldStart({ resume: true, batchTurns: 1 });
    assert.equal(out.completed, true, JSON.stringify(out));
    assert.equal(JSON.stringify(out.automaticRetry), JSON.stringify({ budget: 3, attempted: 1, recovered: 1 }));
    assert.equal(r.llmCalls.length, 4);
    const report = await r.hayaku.recovery.failedAnalysis.report();
    const row = report.rows.find(item => item.turn === 2);
    assert.ok(row, 'the failed try stays on the record');
    assert.equal(row.resolved, true, 'and shows that the turn came back');
    assert.equal(row.resolutionPending, true);
    assert.equal(row.title, 'AI 응답 형식 오류');
    const coldStores = { pluginStorage: r.pluginStorage, safeLocalStorage: r.safeLocalStorage }, coldMessages = r.chat.message;
    await r.dispose();
    restoreColdLogWrites.forEach(fn => fn());
    r = await createHayakuRuntime({ messages: coldMessages, autoRepair: false, afterRequestAutoRepair: false, ...coldStores });
    const recovered = (await r.hayaku.recovery.failedAnalysis.report()).rows.find(item => item.failureKey === row.failureKey);
    assert.equal(recovered.resolved, true, 'Cold Start recovery is reconstructed after an immediate restart');
    assert.equal(recovered.resolutionDurable, true);
    assert.equal(recovered.resolutionPending, false);
    const durableRecords = (await r.hayaku.ledger.inspect({ includeRecords: true })).records;
    assert.ok(recovered.resolution.recordIds.length > 0);
    assert.ok(recovered.resolution.recordIds.every(id => durableRecords.some(record => record.recordId === id && record.hash === recovered.resolution.packetHash)));
    assert.equal(r.llmCalls.length, 0, 'Cold Start proof reconstruction spends no model call');
  } finally { restoreColdLogWrites.forEach(fn => fn()); await r.dispose(); }

  // A retry that fails too keeps the run partial, names the turn, and survives a restart.
  const messages = chat(2);
  messages[3].data = `${sentence(2)}`;
  r = await open({ messages, turns: 2 });
  const stores = { pluginStorage: r.pluginStorage, safeLocalStorage: r.safeLocalStorage };
  try {
    r.setLlmResponder(async call => turnOf(call) === 2
      ? { type: 'success', result: `not json ${SECRET}` }
      : { type: 'success', result: JSON.stringify(envelope(sentence(1))) });
    const out = await r.hayaku.recovery.coldStart({ resume: true, batchTurns: 1 });
    assert.equal(out.completed, false);
    assert.equal(out.automaticRetry.attempted, 1);
    assert.equal(out.failedTurns.length, 1);
    assert.equal(out.failedTurns[0].turn, 2);
  } finally { await r.dispose(); }
  r = await createHayakuRuntime({ messages, autoRepair: false, afterRequestAutoRepair: false, ...stores });
  const gui = createColdStartGuiDocument();
  Object.assign(r.context, { document: gui.document, window: gui.dom.window, Event: gui.dom.window.Event, HTMLElement: gui.dom.window.HTMLElement, MutationObserver: gui.dom.window.MutationObserver });
  try {
    const report = await r.hayaku.recovery.failedAnalysis.report();
    const row = report.rows.find(item => item.turn === 2);
    assert.ok(row, 'the reason outlives a restart');
    assert.equal(row.resolved, false);
    assert.equal(row.count >= 1, true);
    assert.equal(row.flowLabel, 'Cold Start 분석');
    const stored = [...r.pluginStorage.values.entries()].filter(([key]) => key.startsWith('hayaku.v2.analysis_failure_log.'));
    assert.equal(stored.length, 1);
    assert.equal(JSON.stringify(stored).includes(SECRET), false, 'the answer never enters the log');
    assert.equal(JSON.stringify(stored).includes('box number'), false, 'nor does the source');

    assert.equal(await r.hayaku.showUi(), true);
    const root = gui.document.getElementById('hayaku-ledger-viewer-root');
    await waitFor(() => root.querySelector('.app') && !root.querySelector('.app').classList.contains('is-busy'), 'viewer');
    assert.equal(root.querySelector('[data-recovery-view="failures"]'), null, 'status, failures, log and export live in one place');
    await waitFor(() => /실패 1/.test(root.querySelector('#hayakuViewerHealth').textContent), 'count in the header');
    root.querySelector('#hayakuViewerHealth').click();
    await waitFor(() => root.querySelector('#hayakuViewerPanelLogs [data-failure-row="2"]'), 'failure row');
    const page = root.querySelector('#hayakuViewerPanelLogs');
    assert.equal(page.hidden, false, 'the status button opens that place');
    assert.equal(page.querySelector('[data-status-panel="status"]').hidden, false);
    const text = page.querySelector('[data-failure-row="2"]').textContent;
    assert.match(text, /T2/); assert.match(text, /미복구/); assert.match(text, /AI 응답 형식 오류/); assert.match(text, /원인 코드/); assert.match(text, /Cold Start 분석/);
    assert.match(page.dataset.fullLogText, /T2 · AI 응답 형식 오류/, 'and the copied log carries it');
    assert.equal(page.dataset.fullLogText.includes(SECRET), false);
    assert.ok(page.querySelector('#exportHayakuDebug') && page.querySelector('#copyHayakuDebug'), 'debug export sits with it');
    page.querySelector('[data-status-view="log"]').click();
    assert.equal(page.querySelector('[data-status-panel="log"]').hidden, false);
    assert.equal(page.querySelector('[data-status-panel="status"]').hidden, true);
    assert.ok(page.querySelector('[data-status-panel="log"] #hayakuViewerOperationLog'), 'the running log is its second view');
  } finally { await r.dispose(); gui.dom.window.close(); }
  console.log('PASS a misplaced brace keeps the turn, single-turn Cold Start retries, and failures stay visible');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
