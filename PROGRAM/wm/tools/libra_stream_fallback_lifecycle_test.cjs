'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { readLedgerReceipts } = require('./libra_generation_capture_receipt_fixture.cjs');
const fixturePath = path.join(__dirname, 'libra_management_gui_integration_test.cjs');
let source = fs.readFileSync(fixturePath, 'utf8').replace('PersonaRuntimeCoordinator};', 'PersonaRuntimeCoordinator,scheduleAfterRequestMissingRecoveryCheck,clearAfterRequestMissingRecoveryTimer,pruneAfterRequestOriginQueue};');
if (process.env.LIBRA_GUI_TEST_DIST?.endsWith('LIBRA World Manager.js')) source = source.replace("code.lastIndexOf('\\n})();')", "code.lastIndexOf('})();')");
const fixtureModule = new Module(fixturePath, module); fixtureModule.filename = fixturePath;
fixtureModule.paths = Module._nodeModulePaths(__dirname); fixtureModule._compile(source, fixturePath);
const { loadGui } = fixtureModule.exports;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const checks = [];
async function fixture() {
  const f = await loadGui({ nativeInitialization: true, store: new Map() });
  f.control.chat.message = f.control.chat.msgs = [{ role: 'user', data: 'Mira watches the long river crossing from the stone bridge.', m_id: 'long-user', time: Date.now() }];
  await f.callbacks.beforeRequest([{ role: 'user', content: f.control.chat.message[0].data }], 'model');
  f.origin = [...f.api.MemoryState.afterRequestOriginsByType.values()].flat()[0]; assert(f.origin);
  const originalTimer = f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.get(f.control.chat.id); f.w.clearTimeout(originalTimer.timer);
  f.clock = { now: f.origin.queuedAt, timers: new Map(), sequence: 100000 };
  const NativeDate = f.w.Date;
  f.w.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [f.clock.now])); } static now() { return f.clock.now; } };
  f.w.setTimeout = (fn, ms) => { const id = ++f.clock.sequence; f.clock.timers.set(id, { fn, at: f.clock.now + Math.max(0, ms) }); return id; };
  f.w.clearTimeout = id => f.clock.timers.delete(id);
  f.advance = async ms => {
    f.clock.now += ms;
    for (let i = 0; i < 12; i++) {
      const ready = [...f.clock.timers].filter(([, timer]) => timer.at <= f.clock.now);
      for (const [id, timer] of ready) { f.clock.timers.delete(id); Promise.resolve(timer.fn()).catch(error => { f.error = error; }); }
      await flush(); if (f.error) throw f.error;
      if (![...f.clock.timers.values()].some(timer => timer.at <= f.clock.now)) break;
    }
  };
  f.control.chat.isStreaming = true;
  f.api.scheduleAfterRequestMissingRecoveryCheck(f.control.chat, f.origin);
  f.receipts = () => readLedgerReceipts(f.store);
  return f;
}
async function test(name, fn) {
  let f; try { f = await fixture(); await fn(f); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, error: error.stack }); process.exitCode = 1; }
  finally { f?.close(); }
}
(async () => {
  await test('continuously active stream keeps frozen ownership after queue TTL and captures final at 650 seconds', async f => {
    for (let i = 0; i < 130; i++) await f.advance(5000);
    assert.equal(f.api.pruneAfterRequestOriginQueue('model').length, 0, 'original ten-minute queue TTL is unchanged');
    assert(f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.has(f.control.chat.id), 'active stream retains original 30-minute recovery window');
    f.control.chat.isStreaming = false;
    f.control.chat.message.push({ role: 'assistant', data: 'Mira finally completes the long river crossing and reaches the northern bank.', m_id: 'long-assistant', time: f.clock.now });
    for (let i = 0; i < 20 && !f.receipts().length; i++) await f.advance(5000);
    assert.equal(f.receipts().length, 1); assert.equal(f.receipts()[0].recordId, f.origin.requestId);
    assert.equal(f.receipts()[0].canonicalScope, f.origin.canonicalScope);
  });
  await test('explicit cancellation still retires ownership after queue TTL pruning', async f => {
    for (let i = 0; i < 130; i++) await f.advance(5000);
    f.api.pruneAfterRequestOriginQueue('model');
    f.api.clearAfterRequestMissingRecoveryTimer(f.control.chat.id);
    f.control.chat.isStreaming = false;
    f.control.chat.message.push({ role: 'assistant', data: 'Cancelled late crossing result must remain uncaptured.', m_id: 'cancelled-assistant', time: f.clock.now });
    for (let i = 0; i < 5; i++) await f.advance(5000);
    assert.equal(f.receipts().length, 0);
    assert.equal(f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.size, 0);
  });
  await test('active stream recovery remains bounded to the existing 360 attempts', async f => {
    for (let i = 0; i < 362; i++) await f.advance(5000);
    assert.equal(f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.size, 0);
    assert.equal(f.receipts().length, 0);
  });
  await test('explicit cancellation reaches a running callback after queue TTL pruning', async f => {
    for (let i = 0; i < 130; i++) await f.advance(5000);
    f.api.pruneAfterRequestOriginQueue('model');
    let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
    const original = f.w.risuai.getCharacterFromIndex;
    f.w.risuai.getCharacterFromIndex = async (...args) => { entered = true; await gate; return original(...args); };
    f.control.chat.isStreaming = false;
    f.control.chat.message.push({ role: 'assistant', data: 'An explicitly cancelled in-flight callback must not publish this late crossing.', m_id: 'cancelled-running-assistant', time: f.clock.now });
    await f.advance(5000); assert(entered, 'fallback is suspended in actual host lookup');
    assert.equal(f.api.clearAfterRequestMissingRecoveryTimer(f.control.chat.id), true, 'running callback still has a reachable owner');
    release(); await flush();
    assert.equal(f.receipts().length, 0);
    assert.equal(f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.size, 0);
  });
  console.log(JSON.stringify({ passed: checks.filter(x => x.ok).length, failed: checks.filter(x => !x.ok).length, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
