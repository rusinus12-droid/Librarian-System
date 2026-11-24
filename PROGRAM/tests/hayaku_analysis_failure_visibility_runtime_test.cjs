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

  // Missing-turn recovery (누락 복구) resolves stale afterRequest + native_repair_evidence_verification debt failures,
  // even across empty or stale sourceRevisionIds, removes them from topbar 실패 count, and lets the user clear history.
  const t38Messages = chat(2);
  let t38Stores;
  r = await open({ messages: t38Messages, turns: 2 });
  try {
    const scope = await r.hayaku._test.currentChatScope();
    const logKey = `hayaku.v2.analysis_failure_log.${scope.key}`;
    const seededEntries = [
      {
        scopeKey: scope.key, turn: 2, at: 1000, kind: 'incremental_recovery', flow: 'after_request_current_packet',
        code: 'HAYAKU_AFTER_REQUEST_RECOVERY_FAILED', reason: 'native_repair_envelope_top_level_invalid',
        cause: [{ code: 'Incomplete JSON array.', count: 1 }], physicalCalls: 1, count: 1,
        sourceRevisionId: '', operationId: 'afterreq-t38',
        diagnosisCode: 'RESPONSE_FORMAT', title: 'AI 응답 형식 오류',
        detail: 'AI 응답이 올바른 JSON이 아니어서 내용을 읽지 못했습니다.',
        nextStep: '다시 시도해 주세요. 반복되면 보조 모델을 바꿔 보세요.',
        failureKey: 't38-afterreq-1'
      },
      ...[2000, 2001, 2002].map((at, idx) => ({
        scopeKey: scope.key, turn: 2, at, kind: 'incremental_recovery', flow: 'native_repair_evidence_verification',
        code: 'HAYAKU_RECOVERY_EVIDENCE_UNVERIFIED', reason: 'recovery_evidence_live_pair_unavailable',
        cause: [], physicalCalls: 0, count: 1,
        sourceRevisionId: 'stale-old-prefix', operationId: `sweep-${idx}`,
        diagnosisCode: 'EVIDENCE_STALE_PAIR', title: '이전 응답 리비전 불일치',
        detail: '실패 당시 턴과 현재 대화 원문이 달라 이전 복구 대상을 건너뛰었습니다.',
        nextStep: '현재 대화를 기준으로 누락 복구를 실행하면 새 원문으로 복구됩니다.',
        failureKey: `t38-verify-${idx}`
      }))
    ];
    await r.pluginStorage.setItem(logKey, JSON.stringify({
      schema: 'hayaku.analysis_failure_log.v1',
      scopeKey: scope.key,
      entries: seededEntries
    }));
    r.setLlmResponder(async call => ({ type: 'success', result: JSON.stringify(envelope(sentence(turnOf(call)))) }));
    const repaired = await r.hayaku.recovery.repairSelected({ targetTurns: [1, 2], scopeKey: scope.key });
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    // Re-seed pre-resolution failure log (simulating existing chat already recovered before this plugin update).
    await r.pluginStorage.setItem(logKey, JSON.stringify({
      schema: 'hayaku.analysis_failure_log.v1',
      scopeKey: scope.key,
      entries: seededEntries
    }));
    t38Stores = { pluginStorage: r.pluginStorage, safeLocalStorage: r.safeLocalStorage };
  } finally { await r.dispose(); }

  r = await createHayakuRuntime({ messages: t38Messages, autoRepair: false, afterRequestAutoRepair: false, ...t38Stores });
  const t38Gui = createColdStartGuiDocument();
  Object.assign(r.context, { document: t38Gui.document, window: t38Gui.dom.window, Event: t38Gui.dom.window.Event, HTMLElement: t38Gui.dom.window.HTMLElement, MutationObserver: t38Gui.dom.window.MutationObserver });
  try {
    assert.equal(await r.hayaku.showUi(), true);
    const root = t38Gui.document.getElementById('hayaku-ledger-viewer-root');
    await waitFor(() => root.querySelector('.app') && !root.querySelector('.app').classList.contains('is-busy'), 't38 viewer ready');
    const report = await r.hayaku.recovery.failedAnalysis.report();
    assert.equal(report.rows.length, 4);
    assert.equal(report.rows.every(row => row.resolved === true && row.resolutionDurable === true), true, 'all 4 T38 rows durably resolved via active recovery record');
    assert.equal(report.rows.filter(row => row.flow === 'native_repair_evidence_verification').every(row => row.flowLabel === 'Recovery Journal 원문 대조 점검'), true);
    assert.equal(r.llmCalls.length, 0, 'reconstructing resolved failures spends 0 LLM calls');

    await waitFor(() => /정상 작동/.test(root.querySelector('#hayakuViewerHealth').textContent), 'header health shows 정상 작동');
    assert.doesNotMatch(root.querySelector('#hayakuViewerHealth').textContent, /실패 \d+/);

    root.querySelector('#hayakuViewerHealth').click();
    await waitFor(() => root.querySelector('#hayakuViewerPanelLogs [data-resolved-failures-fold]'), 'resolved failures fold rendered');
    const fold = root.querySelector('#hayakuViewerPanelLogs [data-resolved-failures-fold]');
    assert.equal(fold.querySelectorAll('[data-failure-row="2"]').length, 4);
    assert.doesNotMatch(root.querySelector('#hayakuViewerPanelLogs [data-status-log-list]').textContent, /미복구/);
    assert.match(fold.textContent, /이후 복구됨/);

    fold.querySelector('[data-clear-resolved-failures]').click();
    await waitFor(() => !root.querySelector('#hayakuViewerPanelLogs [data-resolved-failures-fold]'), 'resolved failures fold cleared');
    assert.equal((await r.hayaku.recovery.failedAnalysis.report()).rows.length, 0);
  } finally { await r.dispose(); t38Gui.dom.window.close(); }

  console.log('PASS a misplaced brace keeps the turn, single-turn Cold Start retries, and failures stay visible');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
