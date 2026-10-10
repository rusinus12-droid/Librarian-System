'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const acorn = require('acorn');
const { readLedgerReceipts } = require('./libra_generation_capture_receipt_fixture.cjs');
const transformed = new Map();
function instrumentArtifact(input) {
  if (transformed.has(input)) return transformed.get(input);
  const ast = acorn.parse(input, { ecmaVersion: 'latest' }), stack = [ast];
  let replacement;
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (n.type === 'VariableDeclarator' && n.id?.name === 'persistLoreToActiveChat') replacement = n.init;
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === 'object') stack.push(value);
    }
  }
  assert(replacement, 'emitted ordinary-persistence initializer found');
  const code = input.slice(0, replacement.start) + "async()=>{globalThis.__OWNER_GUARD_FORBIDDEN__.persist++;throw new Error('fixture forbids ordinary persistence')}" + input.slice(replacement.end);
  transformed.set(input, code); return code;
}
const helper = path.join(__dirname, 'libra_management_gui_integration_test.cjs');
const fixtureModule = new Module(helper, module); fixtureModule.filename = helper;
fixtureModule.paths = Module._nodeModulePaths(__dirname); fixtureModule.instrumentArtifact = instrumentArtifact;
let helperSource = fs.readFileSync(helper, 'utf8')
  .replace('const end=code.lastIndexOf', 'code=module.instrumentArtifact(code);const end=code.lastIndexOf')
  .replace("code.lastIndexOf('\\n})();')", "code.lastIndexOf('})();')")
  .replace('PersonaRuntimeCoordinator};', 'PersonaRuntimeCoordinator,scheduleAfterRequestMissingRecoveryCheck,clearAfterRequestMissingRecoveryTimer,registerPendingFromResponseCapture,PendingTurnManager};')
  .replace('w.risuai=R;w.Risuai=R;', "w.__OWNER_GUARD_FORBIDDEN__={persist:0,host:0,provider:0};w.risuai=R;w.Risuai=R;")
  .replace('async setChatToIndex(ci,ti,value){', "async setChatToIndex(ci,ti,value){w.__OWNER_GUARD_FORBIDDEN__.host++;throw new Error('fixture forbids host mirror');")
  .replace('async setCharacter(value){', "async setCharacter(value){w.__OWNER_GUARD_FORBIDDEN__.host++;throw new Error('fixture forbids character write');")
  .replace('async setCharacterToIndex(_,value){', "async setCharacterToIndex(_,value){w.__OWNER_GUARD_FORBIDDEN__.host++;throw new Error('fixture forbids character write');")
  .replace('async nativeFetch(url,init){', "async nativeFetch(url,init){w.__OWNER_GUARD_FORBIDDEN__.provider++;throw new Error('fixture forbids provider transport');");
fixtureModule._compile(helperSource, helper);
const { loadGui } = fixtureModule.exports;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const answer = 'Mira finally completes the long river crossing and reaches the northern bank.';
async function fixture(file) {
  process.env.LIBRA_GUI_TEST_DIST = path.join(__dirname, '../dist', file);
  const f = await loadGui({ nativeInitialization: true, store: new Map() });
  f.control.chat.message = f.control.chat.msgs = [{ role: 'user', data: 'Mira watches the long river crossing from the stone bridge.', m_id: 'owner-user', time: Date.now() }];
  await f.callbacks.beforeRequest([{ role: 'user', content: f.control.chat.message[0].data }], 'model');
  f.origin = [...f.api.MemoryState.afterRequestOriginsByType.values()].flat()[0]; assert(f.origin);
  const prior = f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.get(f.control.chat.id); f.w.clearTimeout(prior.timer);
  f.clock = { now: f.origin.queuedAt, timers: new Map(), sequence: 100000 };
  const NativeDate = f.w.Date;
  f.w.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [f.clock.now])); } static now() { return f.clock.now; } };
  f.w.setTimeout = (fn, ms) => { const id = ++f.clock.sequence; f.clock.timers.set(id, { fn, at: f.clock.now + Math.max(0, ms) }); return id; };
  f.w.clearTimeout = id => f.clock.timers.delete(id);
  f.advance = async ms => {
    f.clock.now += ms;
    for (let i = 0; i < 12; i++) {
      const ready = [...f.clock.timers].filter(([, t]) => t.at <= f.clock.now);
      for (const [id, t] of ready) { f.clock.timers.delete(id); Promise.resolve(t.fn()).catch(error => { f.error = error; }); }
      await flush(); if (f.error) throw f.error;
      if (![...f.clock.timers.values()].some(t => t.at <= f.clock.now)) break;
    }
  };
  f.control.chat.message.push({ role: 'assistant', data: answer, m_id: 'owner-assistant', time: f.clock.now });
  f.capture = { memorySourceText: answer, displayContent: answer, comparable: answer, rawResponseText: answer, latestMessageId: 'owner-assistant', requestSequence: f.origin.requestSequence, messageCount: 2 };
  f.receipts = () => readLedgerReceipts(f.store);
  f.baselineWrites = f.calls.writes.length;
  f.assertNoExternal = () => {
    assert.deepEqual({ ...f.w.__OWNER_GUARD_FORBIDDEN__ }, { persist: 0, host: 0, provider: 0 });
    assert.equal(f.calls.writes.slice(f.baselineWrites).filter(w => w.key.startsWith('LIBRA_DATA::')).length, 0, 'capture must not write canonical data');
  };
  f.holdRaw = () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const original = f.w.risuai.pluginStorage.setItem; const state = { entered: false, release };
    f.w.risuai.pluginStorage.setItem = async (key, value) => {
      if (key.includes('::record::') && !key.endsWith('::publication') && !key.endsWith('::status')) { state.entered = true; await gate; }
      return original(key, value);
    };
    return state;
  };
  return f;
}
const checks = [];
async function check(file, name, fn) {
  let f;
  try { f = await fixture(file); const detail = await fn(f); f.assertNoExternal(); checks.push({ file, name, ok: true, detail }); }
  catch (error) { checks.push({ file, name, ok: false, error: error.stack }); process.exitCode = 1; }
  finally { f?.close(); }
}
(async () => {
  for (const file of ['LIBRA World Manager Full.js', 'LIBRA World Manager.js']) {
    await check(file, 'current owner capture publishes one pending with retained raw', async f => {
      const result = await f.api.registerPendingFromResponseCapture(f.control.char, f.control.chat, f.origin, f.capture);
      assert.equal(result.status, 'registered'); assert.equal(f.api.MemoryState.pendingTurnCommits.size, 1);
      assert.equal(f.api.PendingTurnManager.getPending(f.control.chat), result.pending);
      assert.equal(f.receipts().length, 1); assert.equal(f.receipts()[0].assistantText, answer);
      return { status: result.status, rawReceipts: 1, pending: 1 };
    });
    await check(file, 'actual afterRequest cancellation during raw ACK retains raw without pending', async f => {
      const held = f.holdRaw();
      f.api.scheduleAfterRequestMissingRecoveryCheck(f.control.chat, f.origin);
      const entry = f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.get(f.control.chat.id);
      const callback = f.clock.timers.get(entry.timer).fn;
      const scope = f.api.MemoryState._activeScopeKey, version = f.api.MemoryState.initVersion;
      await f.advance(5000); assert(held.entered, 'actual recovery paused at raw write');
      assert.equal(await f.callbacks.afterRequest(answer, 'model'), answer); assert(entry.owner.cancelled);
      held.release(); await flush();
      assert.equal(f.api.MemoryState._activeScopeKey, scope); assert.equal(f.api.MemoryState.initVersion, version);
      assert.equal(f.receipts().length, 1); assert.equal(f.receipts()[0].assistantText, answer);
      assert.equal(f.api.MemoryState.pendingTurnCommits.size, 0, 'cancelled fallback must not publish after raw ACK');
      const writes = f.calls.writes.length; await callback(); await flush();
      assert.equal(f.calls.writes.length, writes, 'repeated cancelled callback performs no new writes');
      assert.equal(f.api.MemoryState.pendingTurnCommits.size, 0);
      return { ownerCancelled: true, runtimeLeaseUnchanged: true, retainedRaw: 1, pending: 0, repeatedCallbackWrites: 0 };
    });
    await check(file, 'pending manager winner installed during raw ACK retains exact object and data', async f => {
      const held = f.holdRaw();
      const work = f.api.registerPendingFromResponseCapture(f.control.char, f.control.chat, f.origin, f.capture);
      await flush(); assert(held.entered);
      // This is the actual manager/helper seam, not a claim that a complete
      // normal worker executes concurrently through its own ledger lock.
      const winner = f.api.PendingTurnManager.registerPending(f.control.chat, {
        aiHash: 'newer-winner-hash', sourceHash: 'newer-winner-hash', aiResponse: 'A newer winning pending response.',
        requestSequence: f.origin.requestSequence + 1, memoryCaptureMode: 'fixture-manager-winner',
        targetContext: { scopeKey: f.origin.scopeKey, chatId: f.control.chat.id }, predictedTurn: 2
      });
      assert(winner); const before = JSON.stringify(winner);
      held.release(); const result = await work;
      assert.equal(result.status, 'already-pending');
      assert.equal(f.api.PendingTurnManager.getPending(f.control.chat), winner, 'newer owner keeps exact pending reference');
      assert.equal(JSON.stringify(winner), before, 'newer owner keeps all pending data');
      assert.equal(f.receipts().length, 1);
      return { status: result.status, sameReference: true, sameData: true, retainedRaw: 1 };
    });
    await check(file, 'invalid initial owner guards reject before raw write or deadline mutation', async f => {
      const guards = [
        ['false', () => false], ['throws', () => { throw new Error('owner probe failed'); }],
        ['promise', () => Promise.resolve(true)], ['nonfunction', true]
      ];
      const before = JSON.stringify(f.origin), writes = f.calls.writes.length;
      for (const [name, isCurrent] of guards) {
        const result = await f.api.registerPendingFromResponseCapture(f.control.char, f.control.chat, f.origin, f.capture, 'guard-control', { isCurrent });
        assert.equal(result.status, 'deferred', name); assert.equal(result.reason, 'capture_owner_cancelled', name);
        assert.equal(f.calls.writes.length, writes, name + ' must not write');
        assert.equal(JSON.stringify(f.origin), before, name + ' must not mutate deadline');
        assert.equal(f.api.MemoryState.pendingTurnCommits.size, 0, name);
      }
      assert.equal(f.receipts().length, 0);
      return { guards: guards.map(([name]) => name), writes: 0, pending: 0 };
    });
    await check(file, 'synchronous true owner guard permits normal capture and is rechecked', async f => {
      let checks = 0;
      const result = await f.api.registerPendingFromResponseCapture(f.control.char, f.control.chat, f.origin, f.capture, 'guard-control', { isCurrent: () => { checks++; return true; } });
      assert.equal(result.status, 'registered'); assert(checks >= 2, 'owner checked before and after raw ACK');
      assert.equal(f.api.MemoryState.pendingTurnCommits.size, 1); assert.equal(f.receipts().length, 1);
      return { status: result.status, guardChecks: checks, pending: 1, retainedRaw: 1 };
    });
    await check(file, 'reset during raw ACK keeps raw but blocks pending publication', async f => {
      const held = f.holdRaw();
      const work = f.api.registerPendingFromResponseCapture(f.control.char, f.control.chat, f.origin, f.capture);
      await flush(); assert(held.entered); f.api.MemoryState.reset(); held.release();
      const result = await work; assert.equal(result.status, 'deferred'); assert.equal(result.reason, 'runtime_lease_invalidated');
      assert.equal(f.api.MemoryState.pendingTurnCommits.size, 0); assert.equal(f.receipts().length, 1);
      return { status: result.status, retainedRaw: 1, pending: 0 };
    });
  }
  const report = { passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length, realModelCalls: 0, ordinaryPersistenceTests: false, checks };
  const out = path.join(__dirname, '../verification/capture-owner'); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, (process.env.CAPTURE_OWNER_PHASE || 'results') + '.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
