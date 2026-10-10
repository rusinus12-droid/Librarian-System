'use strict';
const assert = require('node:assert/strict');
const { loadGui } = require('./libra_management_gui_integration_test.cjs');
const { readLedgerReceipts } = require('./libra_generation_capture_receipt_fixture.cjs');
const checks = [];
const rawTurns = f => readLedgerReceipts(f.store);
async function waitFor(test, message, timeout = 8500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(message);
}
async function sendTurn(f, id, user, assistant) {
  const history = JSON.parse(JSON.stringify(f.control.chat.message || []));
  const userMessage = { role: 'user', data: user, m_id: id + '-user', time: Date.now() };
  f.control.chat.message = f.control.chat.msgs = [...history, userMessage];
  await f.callbacks.beforeRequest([{ role: 'user', content: user }], 'model');
  f.control.chat.message = f.control.chat.msgs = [...history, userMessage, { role: 'assistant', data: assistant, m_id: id + '-assistant', time: Date.now() }];
  await f.callbacks.afterRequest(assistant, 'model');
}
function beginReset(f) {
  const button = f.overlay.querySelector('#lmai-data-reset');
  assert(button, 'registered reset control exists');
  const pending = button.onclick();
  const dialog = f.w.document.querySelector('[data-libra-dialog="true"]');
  assert(dialog, 'registered reset asks for confirmation');
  return { pending, dialog, choose(text) { const control = [...dialog.querySelectorAll('button')].find(node => node.textContent === text); assert(control); control.click(); } };
}
async function test(name, fn) {
  if (process.env.LIBRA_RESET_GUI_TEST_FILTER && !new RegExp(process.env.LIBRA_RESET_GUI_TEST_FILTER).test(name)) return;
  let f;
  try { f = await loadGui(); await fn(f); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, error: error.stack }); process.exitCode = 1; }
  finally { f?.close(); }
}
(async () => {
  await test('confirmed registered reset empties canonical memory and stays empty after reopening', async f => {
    const hostMessages = JSON.stringify(f.control.chat.message);
    f.store.set('synthetic-diagnostic-history', 'preserved diagnostic history');
    const action = beginReset(f);
    assert.match(action.dialog.textContent, /진단|처리 기록/);
    action.choose('확인'); await action.pending;
    const payload = JSON.parse(f.store.get(f.key));
    assert.equal(payload.entries.length, 0);
    assert.equal(payload.resetGeneration, 1);
    assert.equal(f.store.get('synthetic-diagnostic-history'), 'preserved diagnostic history');
    assert.equal(JSON.stringify(f.control.chat.message), hostMessages);
    assert.equal(f.calls.hostWrites.length, 0);
    const fresh = await loadGui({ nativeInitialization: true, store: f.store });
    try {
      assert.equal(fresh.overlay.querySelector('#health-summary').dataset.readState, 'current');
      assert.equal(fresh.overlay.querySelector('[data-health-id="q1"]'), null);
      assert.equal(fresh.api.EntityManager.getEntityCache().size, 0);
    } finally { fresh.close(); }
  });
  await test('cancelled confirmation leaves canonical data and runtime identity untouched', async f => {
    const before = f.store.get(f.key), scope = f.api.MemoryState._activeScopeKey, version = f.api.MemoryState.initVersion;
    const action = beginReset(f); action.choose('취소'); await action.pending;
    assert.equal(f.store.get(f.key), before);
    assert.equal(f.api.MemoryState._activeScopeKey, scope);
    assert.equal(f.api.MemoryState.initVersion, version);
    assert.equal(f.calls.writes.length, 0);
  });
  await test('an old detached reset button cannot open a confirmation or write data', async f => {
    const handler = f.overlay.querySelector('#lmai-data-reset').onclick;
    const before = f.store.get(f.key);
    f.overlay.remove();
    const pending = handler(), prompt = f.w.document.querySelector('[data-libra-dialog="true"]');
    if (prompt) [...prompt.querySelectorAll('button')].find(button => button.textContent === '취소').click();
    await pending;
    assert.equal(prompt, null);
    assert.equal(f.store.get(f.key), before);
    assert.equal(f.calls.writes.length, 0);
  });
  await test('actual health refresh during confirmation cannot authorize a newer reset generation', async f => {
    const action = beginReset(f);
    const scope = f.api.LibraDataStorage.scopeKeyFor(f.control.char, f.control.chat);
    assert.equal((await f.api.LibraDataStorage.resetVerified(scope, { expectedGeneration: 0, isCurrent: async () => true })).ok, true);
    const newer = f.store.get(f.key), writes = f.calls.writes.filter(item => item.key === f.key).length;
    await f.click('#btn-health-refresh');
    action.choose('확인'); await action.pending;
    assert.equal(f.store.get(f.key), newer);
    assert.equal(JSON.parse(newer).resetGeneration, 1);
    assert.equal(f.calls.writes.filter(item => item.key === f.key).length, writes);
    assert(!f.w.document.body.textContent.includes('초기화 완료'));
  });
  await test('repeated registered reset clicks produce one confirmed canonical write', async f => {
    const action = beginReset(f), second = f.overlay.querySelector('#lmai-data-reset').onclick();
    assert.equal(f.w.document.querySelector('[data-libra-dialog="true"]'), action.dialog);
    action.choose('확인'); await Promise.all([action.pending, second]);
    assert.equal(JSON.parse(f.store.get(f.key)).resetGeneration, 1);
    assert.equal(f.calls.writes.filter(item => item.key === f.key).length, 1);
  });
  await test('confirmed reset removes its cached session snapshot without dropping another scope', async f => {
    const scope = f.api.MemoryState._activeScopeKey;
    f.api.NarrativeTracker.resetState({ storylines: [{ name: 'STALE_RESET_SNAPSHOT', turns: [], keyPoints: [] }], turnLog: [] });
    f.api.rememberScopedRuntimeState(scope);
    const other = { marker: 'OTHER_SCOPE_SNAPSHOT' };
    f.api.MemoryState.sessionCache.set('another-owned-scope', other);
    const action = beginReset(f); action.choose('확인'); await action.pending;
    f.api.reloadChatScopedRuntime([], f.control.chat.id, { scopeKey: scope, resetScopedState: true });
    assert(!JSON.stringify(f.api.NarrativeTracker.getState()).includes('STALE_RESET_SNAPSHOT'));
    assert.equal(f.api.MemoryState.sessionCache.get('another-owned-scope'), other);
  });
  await test('a busy runtime owner is reported without clearing its state or canonical data', async f => {
    const before = f.store.get(f.key), token = f.api.ScopedRuntimeTransaction.begin(f.api.MemoryState._activeScopeKey, 'busy-test');
    try {
      const action = beginReset(f); action.choose('확인'); await action.pending;
      assert.equal(f.store.get(f.key), before);
      assert(f.api.ScopedRuntimeTransaction.owns(token));
      assert.match(f.w.document.body.textContent, /작업이 진행 중/);
      assert(!f.w.document.body.textContent.includes('초기화 완료'));
    } finally { f.api.ScopedRuntimeTransaction.end(token); }
  });
  await test('persona change while confirmation is open cannot clear either persona', async f => {
    const other = f.api.LibraDataStorage.storageKeyFor('char:fixture-char|chat:fixture-chat|persona:persona-b');
    f.store.set(other, JSON.stringify({ scopeKey: 'char:fixture-char|chat:fixture-chat|persona:persona-b', entries: [] }));
    const before = f.store.get(f.key), otherBefore = f.store.get(other);
    const action = beginReset(f); f.control.chat.bindedPersona = 'persona-b'; action.choose('확인'); await action.pending;
    assert.equal(f.store.get(f.key), before);
    assert.equal(f.store.get(other), otherBefore);
    assert.equal(f.calls.writes.filter(item => item.key.startsWith('LIBRA_DATA::')).length, 0);
    assert(!f.w.document.body.textContent.includes('초기화 완료'));
  });
  await test('rejected reset storage write never displays success', async f => {
    const before = f.store.get(f.key); f.control.rejectWrites = true;
    const action = beginReset(f); action.choose('확인'); await action.pending;
    assert.equal(f.store.get(f.key), before);
    assert(!f.w.document.body.textContent.includes('초기화 완료'));
    assert.match(f.w.document.body.textContent, /확인할 수 없|실패|불확실/);
  });
  await test('accepted write with unavailable readback is visible as uncertain and cannot expose old cache as current', async f => {
    f.control.afterSet = async () => { f.control.failReads = true; };
    const action = beginReset(f); action.choose('확인'); await action.pending;
    assert.equal(JSON.parse(f.store.get(f.key)).entries.length, 0);
    assert.equal(f.api.MemoryState.isInitialized, false);
    assert(!f.w.document.body.textContent.includes('초기화 완료'));
    assert.match(f.w.document.body.textContent, /확인할 수 없|불확실/);
  });
  await test('closing after a durable reset never compensates by restoring old data', async f => {
    f.control.afterSet = async () => { f.overlay.remove(); };
    const action = beginReset(f); action.choose('확인'); await action.pending;
    assert.equal(JSON.parse(f.store.get(f.key)).entries.length, 0);
    assert.equal(JSON.parse(f.store.get(f.key)).resetGeneration, 1);
    assert.equal(f.calls.writes.filter(item => item.key === f.key).length, 1);
    assert.equal(f.overlay.isConnected, false);
  });
  await test('an uncertain old reset cannot clear a replacement runtime owner', async f => {
    let replacement;
    f.control.afterSet = async () => {
      f.api.MemoryState.reset();
      f.api.MemoryState._activeScopeKey = 'replacement-scope';
      f.api.TimeEngine.resetState({ notes: 'replacement state' });
      replacement = f.api.ScopedRuntimeTransaction.begin('replacement-scope', 'replacement');
    };
    try {
      const action = beginReset(f); action.choose('확인'); await action.pending;
      assert.equal(f.api.MemoryState._activeScopeKey, 'replacement-scope');
      assert.equal(f.api.TimeEngine.getState().notes, 'replacement state');
      assert(f.api.ScopedRuntimeTransaction.owns(replacement));
      assert.equal(JSON.parse(f.store.get(f.key)).entries.length, 0);
    } finally { f.api.ScopedRuntimeTransaction.end(replacement); }
  });
  await test('a new registered turn after reset persists under the new generation', async f => {
    const reset = beginReset(f); reset.choose('확인'); await reset.pending;
    await sendTurn(f, 'new-generation', 'Mira catalogs a new green notebook.', 'Mira puts the new green notebook on the east shelf.');
    await waitFor(() => rawTurns(f).some(record => record.status === 'committed'), 'new-generation turn must commit normally');
    const record = rawTurns(f).find(record => record.status === 'committed');
    assert.equal(record.resetGeneration, 1);
    const payload = JSON.parse(f.store.get(f.key));
    assert.equal(payload.resetGeneration, 1);
    assert(payload.entries.some(entry => entry.comment === 'lmai_memory' && entry.content.includes('new-generation-assistant')));
  });
  await test('old pending WAL receipt cannot restore cleared memory after a fresh runtime replays it', async f => {
    await sendTurn(f, 'old-generation', 'Mira catalogs an old red notebook.', 'Mira puts the old red notebook on the west shelf.');
    await waitFor(() => rawTurns(f).some(record => record.analysisStatus === 'awaiting_host_anchor'), 'old turn reached its normal stabilization wait');
    await waitFor(() => !f.api.ScopedRuntimeTransaction.current(), 'old worker released its runtime owner');
    const reset = beginReset(f); reset.choose('확인'); await reset.pending;
    assert.equal(JSON.parse(f.store.get(f.key)).entries.length, 0);
    const fresh = await loadGui({ nativeInitialization: true, store: f.store });
    try {
      fresh.control.chat.message = fresh.control.chat.msgs = JSON.parse(JSON.stringify(f.control.chat.message));
      await fresh.callbacks.beforeRequest([{ role: 'user', content: 'Begin a new scene after memory reset.' }], 'model');
      await waitFor(() => rawTurns(fresh).some(record => record.deferredReason === 'reset_generation_changed'), 'old receipt is explicitly invalidated by the durable reset generation');
      assert.equal(JSON.parse(fresh.store.get(fresh.key)).entries.length, 0);
      assert(rawTurns(fresh).some(record => record.assistantText.includes('old red notebook')), 'diagnostic receipt remains as disclosed');
    } finally { fresh.close(); }
  });
  await test('a finalizer already awaiting host context cannot publish a turn after reset', async f => {
    await sendTurn(f, 'held-finalizer', 'Mira records a silver notebook.', 'Mira places the silver notebook in the archive.');
    await waitFor(() => rawTurns(f).some(record => record.analysisStatus === 'awaiting_host_anchor'), 'turn reached stabilization wait');
    let entered = false, release;
    const gate = new Promise(resolve => { release = resolve; });
    f.control.afterChatRead = async () => { if (!entered) { entered = true; await gate; } };
    await waitFor(() => entered, 'normal finalizer reached its awaited target read', 7000);
    const reset = beginReset(f); reset.choose('확인'); await reset.pending;
    assert.equal(JSON.parse(f.store.get(f.key)).entries.length, 0);
    const turn = f.api.MemoryState.currentTurn, version = f.api.MemoryState.initVersion;
    release();
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(JSON.parse(f.store.get(f.key)).entries.length, 0);
    assert.equal(f.api.MemoryState.currentTurn, turn);
    assert.equal(f.api.MemoryState.initVersion, version);
    assert.equal(f.api.MemoryState.pendingTurnCommits.size, 0);
  });
  for (const outcome of ['success', 'failure']) await test(`a memory preparation ${outcome} arriving after reset cannot replace the fresh runtime`, async f => {
    await sendTurn(f, 'held-memory-' + outcome, 'Mira records a copper notebook.', 'Mira places the copper notebook on a low shelf.');
    await waitFor(() => rawTurns(f).some(record => record.analysisStatus === 'awaiting_host_anchor'), 'turn reached stabilization wait');
    let entered = false, release;
    const gate = new Promise(resolve => { release = resolve; }), original = f.api.MemoryEngine.prepareMemory;
    f.api.MemoryEngine.prepareMemory = async (...args) => {
      const result = await original(...args);
      if (!entered) { entered = true; await gate; if (outcome === 'failure') throw new Error('synthetic late preparation failure'); }
      return result;
    };
    await waitFor(() => entered, 'normal finalizer reached its awaited memory preparation', 7000);
    const reset = beginReset(f); reset.choose('확인'); await reset.pending;
    const before = JSON.stringify([...f.api.MemoryState.hashIndex]), turn = f.api.MemoryState.currentTurn;
    release(); await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(JSON.parse(f.store.get(f.key)).entries.length, 0);
    assert.equal(JSON.stringify([...f.api.MemoryState.hashIndex]), before);
    assert.equal(f.api.MemoryState.currentTurn, turn);
    assert.equal(f.api.MemoryState.pendingTurnCommits.size, 0);
  });
  console.log(JSON.stringify({ passed: checks.filter(item => item.ok).length, failed: checks.filter(item => !item.ok).length, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
