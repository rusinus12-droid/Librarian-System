'use strict';
// Rebuilding every turn deletes nothing first: a failed turn keeps its memory, the turns already
// replaced stay replaced, a turn with no record is filled, and doubled Cold Start records are cleared.
const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage, waitFor } = require('./fixtures/hayaku_runtime_harness.cjs');
const { createColdStartGuiDocument } = require('./fixtures/hayaku_cold_start_gui_dom_fixture.cjs');

const line = n => `Alice opened box number ${n} and found a ribbon.`;
const envelope = n => {
  const q = line(n), packet = createValidPacket({ turn: n, subject: 'Alice', summary: q });
  for (const axis of ['entity', 'world', 'narrative', 'planner']) for (const [key, value] of Object.entries(packet[axis])) if (Array.isArray(value)) packet[axis][key] = [];
  packet.world.active_events = [{ summary: q }]; packet.meta.summary_memory.summary = q;
  return { schema: 'hayaku.native_repair_output.v1', packet, grounding: ['world.active_events[0]', 'meta.summary_memory.summary'].map(path => ({ path, source: 'target', evidence: [q] })) };
};
// T4 has no packet at all.
const chat = () => [1, 2, 3, 4].flatMap(n => [{ role: 'user', id: `u${n}`, chatId: `u${n}`, data: `Continue ${n}` }, { role: 'assistant', id: `a${n}`, chatId: `a${n}`, data: n === 4 ? line(n) : hiddenPacketMessage(line(n), createValidPacket({ turn: n, subject: 'Alice', summary: `${line(n)} ORIGINAL` })) }]);
const turnOf = call => Number((call.messages.map(m => m.content).join('\n').match(/box number (\d) and found/) || [])[1] || 1);
const good = call => ({ type: 'success', result: JSON.stringify(envelope(turnOf(call))) });
const open = async (options = {}) => {
  const r = await createHayakuRuntime({ messages: chat(), autoRepair: false, afterRequestAutoRepair: false, ...options });
  await r.callBeforeRequest([{ role: 'user', content: '이어서', memo: 'x' }], 'model'); await r.callAfterRequest('', 'model');
  r.setLlmResponder(async call => good(call));
  return r;
};
const active = async r => {
  const l = await r.hayaku.ledger.inspect({ includeRecords: true });
  return new Map(l.records.filter(x => x.recordState === 'active').map(x => [x.targetPairIndex, x]));
};
const covered = async r => [...(await r.hayaku.recovery.status({ includeDebts: true, refreshDebts: true })).debt.coverage.coveredTurns];

(async () => {
  let r = await open();
  try {
    const preview = await r.hayaku.previewRebuild();
    assert.equal(preview.storedTurns, 3); assert.deepEqual([...preview.missingTurns], [4]); assert.equal(preview.calls, 4);
    assert.equal(r.llmCalls.length, 0, 'the preview spends nothing');
    const out = await r.hayaku.rebuildAllTurns();
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual([...out.replaced], [1, 2, 3]); assert.deepEqual([...out.filled], [4]);
    assert.equal(r.llmCalls.length, 4);
    assert.deepEqual(await covered(r), [1, 2, 3, 4]);
    for (const row of (await active(r)).values()) assert.equal(row.raw.includes('ORIGINAL'), false, 'every turn is the new memory');
  } finally { await r.dispose(); }

  // T2 fails twice: T1 and T3 are still replaced, T2 keeps its old memory and says so.
  r = await open();
  try {
    r.setLlmResponder(async call => turnOf(call) === 2 ? { type: 'success', result: 'not json' } : good(call));
    const out = await r.hayaku.rebuildAllTurns();
    assert.equal(out.ok, false); assert.equal(out.reason, 'rebuild_some_turns_failed');
    assert.deepEqual([...out.replaced], [1, 3]);
    assert.deepEqual(Array.from(out.failed, row => row.turn), [2]);
    assert.equal(out.retried, 1, 'the failed turn gets one more try');
    const rows = await active(r);
    assert.equal(rows.get(2).raw.includes('ORIGINAL'), true, 'the old memory is still there');
    assert.equal(rows.get(1).raw.includes('ORIGINAL'), false);
    assert.equal(rows.get(3).raw.includes('ORIGINAL'), false);
    assert.deepEqual(await covered(r), [1, 2, 3, 4]);
    const row = (await r.hayaku.recovery.failedAnalysis.report()).rows.find(item => item.turn === 2);
    assert.equal(row.resolved, false, 'an existing record does not resolve the failed analysis');
    assert.equal(row.keptOld, true); assert.equal(row.flowLabel, '직접 원문 재분석');
    assert.ok(row.sourceRevisionId && row.operationId && row.failureKey);
    const logKey = [...r.pluginStorage.values.keys()].find(key => key.startsWith('hayaku.v2.analysis_failure_log.'));
    const log = JSON.parse(r.pluginStorage.values.get(logKey));
    log.entries.push({ ...row, failureKey: 'other-source-failure', sourceRevisionId: 'other-source-revision' });
    log.entries.push({ ...row, failureKey: 'legacy-unbound-failure', sourceRevisionId: '' });
    r.pluginStorage.values.set(logKey, JSON.stringify(log));
    r.setLlmResponder(async call => good(call));
    assert.equal((await r.hayaku.rebuildAllTurns()).ok, true);
    const recovered = (await r.hayaku.recovery.failedAnalysis.report()).rows.find(item => item.failureKey === row.failureKey);
    assert.equal(recovered.resolved, true);
    assert.equal(recovered.keptOld, false);
    assert.equal(recovered.resolution.sourceRevisionId, row.sourceRevisionId);
    assert.ok(recovered.resolution.recordIds.includes((await active(r)).get(2).recordId));
    const history = (await r.hayaku.recovery.failedAnalysis.report()).rows;
    assert.equal(history.find(item => item.failureKey === 'other-source-failure').resolved, false, 'another source revision is not certified by this recovery');
    assert.equal(history.find(item => item.failureKey === 'legacy-unbound-failure').resolved, false, 'legacy coverage without a source binding proves no recovery');
    const stores = { pluginStorage: r.pluginStorage, safeLocalStorage: r.safeLocalStorage };
    const messages = r.chat.message;
    await r.dispose();
    r = await createHayakuRuntime({ messages, autoRepair: false, afterRequestAutoRepair: false, ...stores });
    const afterRestart = (await r.hayaku.recovery.failedAnalysis.report()).rows.find(item => item.failureKey === row.failureKey);
    assert.equal(afterRestart.resolved, true, 'the recovery link survives a restart');
    assert.equal(afterRestart.keptOld, false);
    r.setLlmResponder(async call => turnOf(call) === 2 ? { type: 'success', result: 'not json' } : good(call));
    assert.equal((await r.hayaku.rebuildAllTurns()).ok, false);
    const later = (await r.hayaku.recovery.failedAnalysis.report()).rows.filter(item => item.turn === 2);
    assert.ok(later.some(item => item.failureKey === row.failureKey && item.resolved), 'a later failure preserves the earlier recovery');
    assert.ok(later.some(item => item.failureKey !== row.failureKey && !item.resolved && item.keptOld), 'a later failed operation is not resolved by the old record');
  } finally { await r.dispose(); }

  // Three failures in a row stop the spending; what was replaced stays.
  r = await open();
  try {
    r.setLlmResponder(async call => turnOf(call) === 1 ? good(call) : { type: 'success', result: 'not json' });
    const out = await r.hayaku.rebuildAllTurns();
    assert.equal(out.ok, false); assert.deepEqual([...out.replaced], [1]);
    assert.equal(out.failed.length, 3, JSON.stringify(out));
    assert.equal(out.stopped, 'three_turns_failed_in_a_row');
    assert.equal((await active(r)).get(1).raw.includes('ORIGINAL'), false);
  } finally { await r.dispose(); }

  // Doubled by an additive Cold Start: the rebuild leaves one record per turn.
  r = await open();
  try {
    await r.hayaku.recovery.coldStart({ resume: true, allowExisting: true, batchTurns: 1 });
    const doubled = (await r.hayaku.recovery.status({ includeDebts: true, refreshDebts: true })).debt.coverage.logicalRecords;
    assert.ok(doubled > 4);
    assert.equal((await r.hayaku.rebuildAllTurns()).ok, true);
    assert.equal((await r.hayaku.recovery.status({ includeDebts: true, refreshDebts: true })).debt.coverage.logicalRecords, 4);
    const l = await r.hayaku.ledger.inspect({ includeRecords: true });
    assert.equal(l.records.filter(x => x.recordState === 'historical').length, 0);
  } finally { await r.dispose(); }

  // Memory recovery remains successful when diagnostic writes fail. The UI distinguishes
  // the pending log write, and a later report retries it without another model call.
  r = await open();
  const pendingGui = createColdStartGuiDocument();
  const restore = [];
  try {
    // Failure and successful adoption can share a clock tick. Their durable link proves order.
    require('node:vm').runInContext('Date.now = () => ' + Date.now(), r.context);
    r.setLlmResponder(async call => turnOf(call) === 2 ? { type: 'success', result: 'not json' } : good(call));
    assert.equal((await r.hayaku.rebuildAllTurns()).ok, false);
    const failure = (await r.hayaku.recovery.failedAnalysis.report()).rows.find(row => row.turn === 2);
    for (const store of new Set([r.pluginStorage, r.safeLocalStorage])) {
      const set = store.setItem.bind(store);
      restore.push(() => { store.setItem = set; });
      store.setItem = async (key, value) => {
        if (String(key).startsWith('hayaku.v2.analysis_failure_log.') && JSON.parse(value).entries.some(row => row.resolution)) throw Error('injected_diagnostic_write_failure');
        return await set(key, value);
      };
    }
    r.setLlmResponder(async call => good(call));
    assert.equal((await r.hayaku.rebuildAllTurns()).ok, true);
    const pending = (await r.hayaku.recovery.failedAnalysis.report()).rows.find(row => row.failureKey === failure.failureKey);
    assert.equal(pending.resolved, true);
    assert.equal(pending.resolutionPending, true);
    assert.equal(pending.resolutionDurable, false);
    assert.equal(pending.keptOld, false);
    assert.equal((await active(r)).get(2).boundAt, failure.at);
    assert.ok(pending.resolution.recordIds.includes((await active(r)).get(2).recordId));
    assert.ok(r.hayaku.activityLog.list().some(row => row.event === 'analysis:failure_resolution_not_saved'));
    Object.assign(r.context, { document: pendingGui.document, window: pendingGui.dom.window, Event: pendingGui.dom.window.Event, HTMLElement: pendingGui.dom.window.HTMLElement, MutationObserver: pendingGui.dom.window.MutationObserver });
    assert.equal(await r.hayaku.showUi(), true);
    const root = pendingGui.document.getElementById('hayaku-ledger-viewer-root');
    await waitFor(() => root.querySelector('.app') && !root.querySelector('.app').classList.contains('is-busy'), 'pending diagnostic viewer');
    root.querySelector('#hayakuViewerHealth').click();
    await waitFor(() => root.querySelector('#hayakuViewerPanelLogs [data-failure-row="2"]'), 'pending diagnostic row');
    assert.match(root.querySelector('[data-failure-row="2"]').textContent, /복구됨 · 기록 저장 대기/);
    assert.doesNotMatch(root.querySelector('[data-failure-row="2"]').textContent, /기존 기억 유지|미복구/);
    const pendingLogKey = [...r.pluginStorage.values.keys()].find(key => key.startsWith('hayaku.v2.analysis_failure_log.'));
    const pendingLog = JSON.parse(r.pluginStorage.values.get(pendingLogKey));
    pendingLog.entries.push({ ...failure, failureKey: 'restart-other-source', sourceRevisionId: 'other-source-revision' });
    pendingLog.entries.push({ ...failure, failureKey: 'restart-same-time-unlinked' });
    pendingLog.entries.push({ ...failure, failureKey: 'restart-newer-failure', at: Date.now() + 600000 });
    r.pluginStorage.values.set(pendingLogKey, JSON.stringify(pendingLog));
    const crashedStores = { pluginStorage: r.pluginStorage, safeLocalStorage: r.safeLocalStorage }, crashedMessages = r.chat.message;
    await r.dispose();
    r = await createHayakuRuntime({ messages: crashedMessages, autoRepair: false, afterRequestAutoRepair: false, ...crashedStores });
    const reconstructed = (await r.hayaku.recovery.failedAnalysis.report()).rows.find(row => row.failureKey === failure.failureKey);
    assert.equal(reconstructed.resolved, true, 'a restart rebuilds the proof from the durable recovery record');
    assert.equal(reconstructed.resolutionPending, true, 'the still-failing diagnostic store remains pending');
    assert.equal(reconstructed.resolutionDurable, false);
    assert.equal(reconstructed.keptOld, false);
    assert.ok(reconstructed.resolution.recordIds.includes((await active(r)).get(2).recordId));
    const negatives = (await r.hayaku.recovery.failedAnalysis.report()).rows;
    assert.equal(negatives.find(row => row.failureKey === 'restart-other-source').resolved, false, 'a different source revision stays unresolved');
    assert.equal(negatives.find(row => row.failureKey === 'restart-same-time-unlinked').resolved, false, 'an equal clock without a committed failure link proves no recovery');
    assert.equal(negatives.find(row => row.failureKey === 'restart-newer-failure').resolved, false, 'a record adopted before a failure proves no later recovery');
    assert.equal(r.llmCalls.length, 0, 'proof reconstruction never invokes a model');
    const calls = r.llmCalls.length;
    restore.forEach(fn => fn());
    await new Promise(resolve => setTimeout(resolve, 5100));
    const saved = (await r.hayaku.recovery.failedAnalysis.report()).rows.find(row => row.failureKey === failure.failureKey);
    assert.equal(saved.resolved, true);
    assert.equal(saved.resolutionPending, false);
    assert.equal(saved.resolutionDurable, true);
    assert.equal(r.llmCalls.length, calls, 'only the diagnostic write is retried');
    const stores = { pluginStorage: r.pluginStorage, safeLocalStorage: r.safeLocalStorage }, messages = r.chat.message;
    await r.dispose();
    r = await createHayakuRuntime({ messages, autoRepair: false, afterRequestAutoRepair: false, ...stores });
    assert.equal((await r.hayaku.recovery.failedAnalysis.report()).rows.find(row => row.failureKey === failure.failureKey).resolutionDurable, true);
  } finally { restore.forEach(fn => fn()); await r.dispose(); pendingGui.dom.window.close(); }

  // A negative check is reused only for the same physical ledger, transcript, and failure set.
  r = await open({ transformSource: source => source.replace(
    'const reconstructAnalysisFailureResolutionsFromStored = async (scopeKey, unresolved, scope, storedRaw) => {',
    'const reconstructAnalysisFailureResolutionsFromStored = async (scopeKey, unresolved, scope, storedRaw) => { globalThis.reconciliationChecks = (globalThis.reconciliationChecks || 0) + 1;') });
  try {
    r.setLlmResponder(async call => turnOf(call) === 2 ? { type: 'success', result: 'not json' } : good(call));
    assert.equal((await r.hayaku.rebuildAllTurns()).ok, false);
    await r.hayaku.recovery.failedAnalysis.report();
    const checks = r.context.reconciliationChecks;
    await Promise.all(Array.from({ length: 3 }, () => r.hayaku.recovery.failedAnalysis.report()));
    assert.equal(r.context.reconciliationChecks, checks, 'unchanged unresolved failures do not rescan');
    const ledgerKey = [...r.pluginStorage.values.keys()].find(key => key.startsWith('hayaku.v2.ledger.'));
    const ledger = JSON.parse(r.pluginStorage.values.get(ledgerKey));
    ledger.updatedAt += 1;
    r.pluginStorage.values.set(ledgerKey, JSON.stringify(ledger));
    await Promise.all(Array.from({ length: 3 }, () => r.hayaku.recovery.failedAnalysis.report()));
    assert.equal(r.context.reconciliationChecks, checks + 1, 'a changed ledger is checked once across concurrent viewers');
    const logKey = [...r.pluginStorage.values.keys()].find(key => key.startsWith('hayaku.v2.analysis_failure_log.'));
    const log = JSON.parse(r.pluginStorage.values.get(logKey));
    log.entries.find(row => row.turn === 2).count += 1;
    r.pluginStorage.values.set(logKey, JSON.stringify(log));
    await r.hayaku.recovery.failedAnalysis.report();
    assert.equal(r.context.reconciliationChecks, checks + 2, 'a new failed attempt invalidates the check');
    r.chat.message[1].data = 'A changed source revision with no verified recovery.';
    await r.hayaku.recovery.failedAnalysis.report();
    assert.ok(r.context.reconciliationChecks > checks + 2, 'a changed source invalidates the check');
    // A transient interpretation failure is not cached as a valid negative check.
    const validRaw = r.pluginStorage.values.get(ledgerKey);
    r.pluginStorage.values.set(ledgerKey, 'not-valid-json');
    const beforeErrorChecks = r.context.reconciliationChecks;
    await r.hayaku.recovery.failedAnalysis.report();
    assert.equal(r.context.reconciliationChecks, beforeErrorChecks + 1, 'unreadable ledger triggers a fresh check');
    r.pluginStorage.values.set(ledgerKey, validRaw);
    await r.hayaku.recovery.failedAnalysis.report();
    assert.equal(r.context.reconciliationChecks, beforeErrorChecks + 2, 'restored ledger rescans instead of reusing failed interpretation cache');
  } finally { await r.dispose(); }

  // The screen asks first, spends nothing on cancel, and reports what happened.
  r = await open();
  const gui = createColdStartGuiDocument();
  Object.assign(r.context, { document: gui.document, window: gui.dom.window, Event: gui.dom.window.Event, HTMLElement: gui.dom.window.HTMLElement, MutationObserver: gui.dom.window.MutationObserver });
  try {
    assert.equal(await r.hayaku.showUi(), true);
    const root = gui.document.getElementById('hayaku-ledger-viewer-root');
    await waitFor(() => root.querySelector('.app') && !root.querySelector('.app').classList.contains('is-busy'), 'viewer');
    root.querySelector('[data-recovery-view="reanalysis"]').click();
    const run = root.querySelector('#runHayakuRebuild'), overlay = () => root.querySelector('#hayakuSourceReanalysisConfirmOverlay');
    run.click();
    await waitFor(overlay, 'dialog');
    assert.match(overlay().textContent, /모든 턴을 다시 만들까요/); assert.match(overlay().textContent, /먼저 지우지 않습니다/); assert.match(overlay().textContent, /Other Ax 4회/); assert.match(overlay().textContent, /최대 8회/);
    overlay().querySelector('[data-reanalysis-confirm="cancel"]').click();
    await waitFor(() => /취소했습니다/.test(root.querySelector('#hayakuRebuildStatus').textContent), 'cancelled');
    assert.equal(r.llmCalls.length, 0);
    run.click();
    await waitFor(overlay, 'dialog again');
    overlay().querySelector('[data-reanalysis-confirm="apply"]').click();
    await waitFor(() => /재구성 완료/.test(root.querySelector('#hayakuRebuildStatus').textContent), 'finished', 40000);
    assert.match(root.querySelector('#hayakuRebuildStatus').textContent, /교체 3턴 · 채움 1턴/);
    assert.equal(r.llmCalls.length, 4);
  } finally { await r.dispose(); gui.dom.window.close(); }
  console.log('PASS rebuilding every turn replaces what succeeds and keeps the rest');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
