'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { readLedgerReceipts } = require('./libra_generation_capture_receipt_fixture.cjs');
// Export real closure functions without replacing product behavior or timing.
const fixturePath = path.join(__dirname, 'libra_management_gui_integration_test.cjs');
let fixtureSource = fs.readFileSync(fixturePath, 'utf8');
fixtureSource = fixtureSource.replace('PersonaRuntimeCoordinator};', 'PersonaRuntimeCoordinator,registerPendingFromResponseCapture,buildAssistantResponseCaptureFromSnapshot,PendingTurnManager,runTurnMaintenanceRecord,resolveActiveChatContext};');
if (process.env.LIBRA_GUI_TEST_DIST?.endsWith('LIBRA World Manager.js')) fixtureSource = fixtureSource.replace("code.lastIndexOf('\\n})();')", "code.lastIndexOf('})();')");
const fixtureModule = new Module(fixturePath, module); fixtureModule.filename = fixturePath;
fixtureModule.paths = Module._nodeModulePaths(__dirname); fixtureModule._compile(fixtureSource, fixturePath);
const { loadGui } = fixtureModule.exports;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
async function waitFor(test, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (test()) return; await sleep(20); }
  assert.fail(message);
}
async function fixture() {
  const f = await loadGui({ nativeInitialization: true, store: new Map() });
  f.begin = async () => {
    f.control.chat.message = f.control.chat.msgs = [{ role: 'user', data: 'Mira charts the northern route in the blue notebook.', m_id: 'fallback-user', time: Date.now() }];
    await f.callbacks.beforeRequest([{ role: 'user', content: f.control.chat.message[0].data }], 'model');
    f.origin = [...f.api.MemoryState.afterRequestOriginsByType.values()].flat()[0]; assert(f.origin);
    f.response = 'Mira marks the stone bridge and the quiet river crossing on the northern route.';
    f.control.chat.message.push({ role: 'assistant', data: f.response, m_id: 'fallback-assistant', time: Date.now() });
    f.context = await f.api.resolveActiveChatContext(); assert(f.context.ok);
    f.capture = f.api.buildAssistantResponseCaptureFromSnapshot(f.context.chat, f.origin); assert(f.capture);
  };
  f.register = () => f.api.registerPendingFromResponseCapture(f.context.char, f.context.chat, f.origin, f.capture, 'afterRequest-missing-fallback');
  f.receipts = () => readLedgerReceipts(f.store);
  return f;
}
async function test(name, fn) {
  if (process.env.LIBRA_FALLBACK_TEST_FILTER && !new RegExp(process.env.LIBRA_FALLBACK_TEST_FILTER).test(name)) return;
  let f;
  try { f = await fixture(); const detail = await fn(f); checks.push({ name, ok: true, detail }); }
  catch (error) { checks.push({ name, ok: false, error: error.stack, evidence: f?.evidence }); process.exitCode = 1; }
  finally { f?.close(); }
}
(async () => {
  await test('new stream fallback after explicit reset preserves generation through immediate maintenance', async f => {
    const pending = f.w.document.querySelector('#lmai-data-reset').onclick();
    const dialog = f.w.document.querySelector('[data-libra-dialog="true"]'); assert(dialog);
    [...dialog.querySelectorAll('button')].find(button => button.textContent === '확인').click(); await pending;
    await f.begin(); assert.equal(f.origin.resetGeneration, 1);
    const captured = await f.register(); assert.equal(captured.status, 'registered');
    const committed = await f.api.PendingTurnManager.commitPendingNow(f.context.char, f.context.chat, 'afterRequest-missing-fallback', { pending: captured.pending, deferMaintenance: true });
    assert.equal(committed.status, 'finalized', JSON.stringify(committed));
    assert(committed.maintenanceRecord);
    const outcome = await f.api.runTurnMaintenanceRecord(committed.maintenanceRecord);
    f.evidence = { originGeneration: f.origin.resetGeneration, maintenanceGeneration: committed.maintenanceRecord.targetContext.resetGeneration, outcome };
    assert.notEqual(outcome?.reason, 'reset_generation_changed', 'fresh generation-1 fallback must run maintenance now rather than skip as stale generation 0');
    assert.equal(committed.maintenanceRecord.targetContext.resetGeneration, 1);
    assert.equal(committed.maintenanceRecord.targetContext.canonicalScope, f.origin.canonicalScope);
    assert(f.receipts()[0].analysisStartedAt > 0, 'actual analysis reservation was reached without a new request/replay');
    return { outcome, resetGeneration: committed.maintenanceRecord.targetContext.resetGeneration, receipt: f.receipts()[0].analysisStatus };
  });
  for (const invalidation of ['persona', 'reset', 'unload']) await test(`fallback raw append suspended across ${invalidation} cannot publish old A into the current runtime`, async f => {
    await f.begin();
    let entered, release; const begun = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const original = f.w.risuai.pluginStorage.setItem; let held = false;
    f.w.risuai.pluginStorage.setItem = async (key, value) => {
      if (!held && key.includes('::record::') && !key.endsWith('::publication') && !key.endsWith('::status')) {
        held = true; entered(); await gate;
      }
      return original(key, value);
    };
    const work = f.register(); await begun;
    if (invalidation === 'persona') { f.control.chat.bindedPersona = 'persona-b'; await f.callbacks.setting(); }
    else if (invalidation === 'reset') f.api.MemoryState.reset();
    else for (const unload of f.callbacks.unload || []) await unload();
    release(); const captured = await work;
    let committed = null, commitError = null;
    if (captured.pending) { try { committed = await f.api.PendingTurnManager.commitPendingNow(f.context.char, f.context.chat, 'afterRequest-missing-fallback', { pending: captured.pending, deferMaintenance: true, suppressFinalizeRetry: true }); } catch (error) { commitError = error.message; } }
    const bKey = f.api.LibraDataStorage.storageKeyFor('char:fixture-char|chat:fixture-chat|persona:persona-b');
    f.evidence = { capturedStatus: captured.status, committedStatus: committed?.status, commitError, pending: f.api.MemoryState.pendingTurnCommits.size, bCanonicalMemories: f.store.has(bKey) ? JSON.parse(f.store.get(bKey)).entries.filter(e => e.comment === 'lmai_memory') : [] };
    assert.equal(f.store.has(bKey), false, 'A source must never be canonically saved under B persona after raw await');
    assert.equal(f.api.MemoryState.pendingTurnCommits.size, 0, 'stale continuation must not repopulate current pending state');
    assert.equal(f.calls.hostWrites.length, 0);
    if (invalidation !== 'unload') {
      assert.equal(f.receipts().length, 1, 'frozen A raw receipt remains recoverable');
      assert.equal(f.receipts()[0].canonicalScope, f.origin.canonicalScope);
      assert.equal(f.receipts()[0].assistantText, f.response);
    }
    return { captureStatus: captured.status, commitStatus: committed?.status || null, rawReceipts: f.receipts().length };
  });
  await test('registered missing-hook timer after reset reaches analysis reservation without replay', async f => {
    const pending = f.w.document.querySelector('#lmai-data-reset').onclick();
    const dialog = f.w.document.querySelector('[data-libra-dialog="true"]'); assert(dialog);
    [...dialog.querySelectorAll('button')].find(button => button.textContent === '확인').click(); await pending;
    await f.begin();
    await waitFor(() => f.receipts()[0]?.status === 'committed', 'registered missing-hook timer must fast commit');
    await waitFor(() => f.receipts()[0]?.analysisStartedAt > 0, 'registered missing-hook timer must start immediate generation-1 maintenance');
    assert.equal(f.receipts()[0].resetGeneration, 1);
    assert.equal(f.receipts()[0].canonicalScope, f.origin.canonicalScope);
  });
  await test('registered missing-hook timer held at raw append cannot write A memory after B GUI activation', async f => {
    await f.begin();
    let entered, release; const begun = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const original = f.w.risuai.pluginStorage.setItem; let held = false;
    f.w.risuai.pluginStorage.setItem = async (key, value) => {
      if (!held && key.includes('::record::') && !key.endsWith('::publication') && !key.endsWith('::status')) { held = true; entered(); await gate; }
      return original(key, value);
    };
    await Promise.race([begun, sleep(7000).then(() => { throw new Error('actual missing-hook timer did not reach raw append'); })]);
    f.control.chat.bindedPersona = 'persona-b'; await f.callbacks.setting(); release();
    await waitFor(() => f.receipts().length === 1, 'A raw receipt survives GUI switch'); await sleep(150);
    const bKey = f.api.LibraDataStorage.storageKeyFor('char:fixture-char|chat:fixture-chat|persona:persona-b');
    assert.equal(f.store.has(bKey), false);
    assert.equal(f.api.MemoryState.pendingTurnCommits.size, 0);
    assert.equal(f.receipts()[0].canonicalScope, f.origin.canonicalScope);
    assert.equal(f.receipts()[0].assistantText, f.response);
  });
  console.log(JSON.stringify({ passed: checks.filter(x => x.ok).length, failed: checks.filter(x => !x.ok).length, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
