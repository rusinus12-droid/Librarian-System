'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { readLedgerReceipts } = require('./libra_generation_capture_receipt_fixture.cjs');

// Exercise the actual producer/ledger/maintenance functions. Source mode only
// changes the bundle input, allowing isolated ports to test before dist builds.
const fixturePath = path.join(__dirname, 'libra_management_gui_integration_test.cjs');
let source = fs.readFileSync(fixturePath, 'utf8');
source = source.replace('PersonaRuntimeCoordinator};', 'PersonaRuntimeCoordinator,registerPendingFromResponseCapture,buildAssistantResponseCaptureFromSnapshot,PendingTurnManager,DurableTurnLedger,buildTurnMaintenanceRecord,runTurnMaintenanceRecord,resolveActiveChatContext,pruneAfterRequestOriginQueue,previewManagedAfterRequestOriginForChatBySequence,clearAfterRequestMissingRecoveryTimer,clearStreamOutputRecoveryTimer,scheduleDurableTurnReplay:globalThis.__WM_DEADLINE_REPLAY__,LLMProvider};');
source = source.replace('await w.eval(code);', "code=code.replace(/const libraAfterRequestReplacer\\s*=/, 'globalThis.__WM_DEADLINE_REPLAY__=scheduleDurableTurnReplay;const libraAfterRequestReplacer=');await w.eval(code);");
source = source.replace('async addRisuScriptHandler(){}', 'async addRisuScriptHandler(type,fn){callbacks[type]=fn;return true}');
if (process.env.LIBRA_DEADLINE_TEST_SOURCE === '1') {
  const read = "fs.readFileSync(process.env.LIBRA_GUI_TEST_DIST || path.join(__dirname,'../dist/LIBRA World Manager Full.js'),'utf8')";
  assert(source.includes(read), 'source fixture loader anchor');
  source = source.replace(read, "JSON.parse(fs.readFileSync(path.join(__dirname,'../src/build-manifest.json'),'utf8')).parts.map(part=>fs.readFileSync(path.join(__dirname,'../src',part.file),'utf8')).join('')");
}
source = source.replace("code.lastIndexOf('\\n})();')", "code.lastIndexOf('})();')");
const fixtureModule = new Module(fixturePath, module);
fixtureModule.filename = fixturePath;
fixtureModule.paths = Module._nodeModulePaths(__dirname);
fixtureModule._compile(source, fixturePath);
const { loadGui } = fixtureModule.exports;
const clone = x => JSON.parse(JSON.stringify(x));
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const EPOCH = 1900000000000, BUDGET = 480000;
const checks = [];

function installClock(f, now = EPOCH) {
  f.clock = { now, timers: new Map(), sequence: 100000 };
  const NativeDate = f.w.Date;
  f.w.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [f.clock.now])); }
    static now() { return f.clock.now; }
  };
  f.w.setTimeout = (fn, ms) => {
    const id = ++f.clock.sequence;
    f.clock.timers.set(id, { fn, at: f.clock.now + Math.max(0, Number(ms) || 0) });
    return id;
  };
  f.w.clearTimeout = id => f.clock.timers.delete(id);
  f.advance = async ms => {
    f.clock.now += ms;
    for (let i = 0; i < 30; i++) {
      const ready = [...f.clock.timers].filter(([, t]) => t.at <= f.clock.now);
      for (const [id, timer] of ready) {
        f.clock.timers.delete(id);
        Promise.resolve(timer.fn()).catch(error => { f.error = error; });
      }
      await flush();
      if (f.error) throw f.error;
      if (![...f.clock.timers.values()].some(t => t.at <= f.clock.now)) return;
    }
    assert.fail('fake timer drain did not settle');
  };
}
async function fixture() {
  const f = await loadGui({ nativeInitialization: true, store: new Map() });
  installClock(f);
  f.w.Math.random = () => 0.123456789;
  f.response = 'Mira sees a blue key beyond the stone gate.';
  f.control.chat.message = f.control.chat.msgs = [{ role: 'user', data: 'I open the stone gate and ask Mira what she sees.', m_id: 'deadline-user', time: EPOCH }];
  await f.callbacks.beforeRequest([{ role: 'user', content: f.control.chat.message[0].data }], 'model');
  f.origin = [...f.api.MemoryState.afterRequestOriginsByType.values()].flat()[0];
  assert(f.origin?.requestId);
  f.originalOrigin = clone(f.origin);
  f.complete = async () => {
    f.control.chat.isStreaming = false;
    f.control.chat.message.push({ role: 'assistant', data: f.response, m_id: 'deadline-assistant', time: f.clock.now });
    f.context = await f.api.resolveActiveChatContext();
    assert(f.context.ok);
    f.capture = f.api.buildAssistantResponseCaptureFromSnapshot(f.context.chat, f.origin);
    assert(f.capture);
  };
  f.register = (origin = f.origin, capture = f.capture) => f.api.registerPendingFromResponseCapture(f.context.char, f.context.chat, origin, capture, 'afterRequest-missing-fallback');
  f.receipts = () => readLedgerReceipts(f.store);
  f.maintenance = pending => f.api.buildTurnMaintenanceRecord(f.context.char, f.context.chat, pending, f.response, 1, f.api.MemoryEngine.CONFIG);
  f.freezeTimers = () => {
    f.api.clearAfterRequestMissingRecoveryTimer(f.control.chat.id);
    f.api.clearStreamOutputRecoveryTimer(f.control.chat.id);
  };
  f.failRawWrites = () => {
    const original = f.w.risuai.pluginStorage.setItem;
    f.w.risuai.pluginStorage.setItem = async (key, value) => {
      if (key.includes('::record::') && !key.endsWith('::status') && !key.endsWith('::publication')) throw new Error('synthetic raw write rejection');
      return original(key, value);
    };
    return () => { f.w.risuai.pluginStorage.setItem = original; };
  };
  return f;
}
async function test(name, fn) {
  if (process.env.LIBRA_DEADLINE_TEST_FILTER && !new RegExp(process.env.LIBRA_DEADLINE_TEST_FILTER).test(name)) return;
  let f;
  if (process.env.LIBRA_DEADLINE_TEST_VERBOSE) console.error(name);
  try { f = await fixture(); const detail = await fn(f); checks.push({ name, ok: true, detail }); }
  catch (error) { checks.push({ name, ok: false, error: error.stack, receipts: f?.receipts(), captureCost: f?.captureCost }); process.exitCode = 1; }
  finally { f?.close(); }
}
// Retained-owner boundary fixture; use the real map rather than exporting a
// production helper that release Terser legitimately inlines away. Registered
// output-handler tests above separately exercise actual capture publication.
function retainOutputFixture(f,payload){
 const retained={...clone(payload),chatId:f.control.chat.id,expiresAt:f.clock.now+600000};
 f.api.MemoryState.recentMainResponseOutputCaptureByChatId.set(f.control.chat.id,retained);
 return retained;
}
function assertDeadline(f, pending, observedAt, deadline = observedAt + BUDGET) {
  const receipt = f.receipts()[0];
  assert(receipt, 'verified raw receipt exists');
  assert.equal(receipt.observedAt, observedAt, 'raw retains first completed observation');
  assert.equal(receipt.analysisDeadlineAt, deadline, 'raw persists the absolute analysis deadline');
  if (pending) {
    assert.equal(pending.targetContext.analysisDeadlineAt, deadline, 'pending inherits verified raw deadline');
    assert.equal(f.maintenance(pending).analysisDeadlineAt, deadline, 'maintenance cannot restart the budget');
  }
  return receipt;
}
function fakePacket(response) {
  const evidenceRefs = [{ turn: 1, messageId: 'deadline-assistant', snippet: response, sourceKind: 'assistant' }];
  return {
    schema: 'libra.canonical_packet.v3', version: 3,
    meta: { turn: 1, sourceMessageIds: ['deadline-assistant'], summary_memory: { summary: response, recall: 'Mira blue key' } },
    memory: { events: [{ operation: 'add', id: 'deadline-event', summary: response, evidenceRefs, confidence: 0.9 }], facts: [], open_threads: [] },
    entity: { characters: [], relations: [], pov_memories: [], secrets: [], current_state: [] },
    world: { rules: [], places: [], organizations: [], social_rules: [], phenomena: [], systems: {}, physics: {}, exists: {}, active_events: [], offscreen_threads: [], state: {} },
    narrative: { scene_phase: 'continuation', conflict_traces: [], scene_deltas: [], theme_motifs: [], unresolved_threads: [] },
    guards: { continuity_locks: [], audit_cautions: [], overpromotion_risks: [], conflicts: [], uncertain: [] },
    importance: { overall: 0.6, reason: ['confirmed event'] }
  };
}

(async () => {
  for (const kind of ['missing-hook', 'output']) await test(`registered ${kind} fallback persists raw and maintenance deadline`, async f => {
    const get = f.w.risuai.pluginStorage.getItem;
    let gets = 0, removes = 0;
    const remove = f.w.risuai.pluginStorage.removeItem;
    f.w.risuai.pluginStorage.getItem = async (...args) => { gets++; return get(...args); };
    f.w.risuai.pluginStorage.removeItem = async (...args) => { removes++; return remove(...args); };
    f.calls.writes.length = 0;
    await f.complete();
    assert.equal(typeof f.callbacks.output, 'function', 'actual output handler is registered');
    f.control.chat.isStreaming = true;
    assert.equal(f.callbacks.output(f.response), f.response);
    await f.advance(0);
    f.control.chat.isStreaming = false;
    if (kind === 'output') f.api.clearAfterRequestMissingRecoveryTimer(f.control.chat.id);
    else f.api.clearStreamOutputRecoveryTimer(f.control.chat.id);
    await f.advance(5000);
    f.captureCost = { gets, sets: f.calls.writes.length, removes, serializedBytes: f.calls.writes.reduce((sum, item) => sum + Buffer.byteLength(String(item.value), 'utf8'), 0) };
    const receipt = assertDeadline(f, null, EPOCH + 5000);
    assert.equal(receipt.status, 'committed', 'actual fallback timer fast-commits');
    return { captureSource: receipt.captureSource, deadline: receipt.analysisDeadlineAt, committed: receipt.status, captureCost: f.captureCost };
  });
  await test('first completed observation after 650-second active stream receives full configured budget', async f => {
    f.control.chat.isStreaming = true;
    for (let i = 0; i < 130; i++) await f.advance(5000);
    assert.equal(f.api.pruneAfterRequestOriginQueue('model').length, 0, 'queue TTL stays unchanged');
    assert.equal(f.receipts().length, 0);
    assert.equal(f.origin.analysisDeadlineAt, undefined, 'active stream does not start analysis budget');
    await f.complete();
    await f.advance(5000);
    assertDeadline(f, null, EPOCH + 655000);
  });
  await test('direct fallback propagates deadline through pending and maintenance', async f => {
    f.freezeTimers(); await f.complete();
    const result = await f.register(); assert.equal(result.status, 'registered');
    f.clock.now += 60000;
    assertDeadline(f, result.pending, EPOCH);
  });
  await test('earlier valid origin deadline survives raw append and maintenance', async f => {
    f.freezeTimers(); await f.complete();
    f.origin.observedAt = EPOCH - 10000;
    f.origin.analysisDeadlineAt = EPOCH + 120000;
    const result = await f.register(); assert.equal(result.status, 'registered');
    assertDeadline(f, result.pending, EPOCH - 10000, EPOCH + 120000);
  });
  await test('raw ACK delay consumes the frozen original analysis budget', async f => {
    f.freezeTimers(); await f.complete();
    const original = f.w.risuai.pluginStorage.setItem;
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const begun = new Promise(resolve => { entered = resolve; });
    f.w.risuai.pluginStorage.setItem = async (key, value) => {
      if (key.includes('::record::') && !key.endsWith('::status') && !key.endsWith('::publication')) { entered(); await gate; }
      return original(key, value);
    };
    const work = f.register(); await begun;
    const frozen = { observedAt: f.origin.observedAt, deadline: f.origin.analysisDeadlineAt };
    f.clock.now += 1000; release();
    const result = await work; assert.equal(result.status, 'registered');
    assert.equal(frozen.observedAt, EPOCH, 'stamp exists before raw ACK await');
    assert.equal(frozen.deadline, EPOCH + BUDGET, 'deadline exists before raw ACK await');
    assertDeadline(f, result.pending, EPOCH);
  });
  await test('uncertain raw ACK retry uses original receipt deadline', async f => {
    f.freezeTimers(); await f.complete();
    const original = f.w.risuai.pluginStorage.setItem;
    let held = false;
    f.w.risuai.pluginStorage.setItem = async (key, value) => {
      const result = await original(key, value);
      if (!held && key.includes('::record::') && !key.endsWith('::status') && !key.endsWith('::publication')) { held = true; f.clock.now += 2000; }
      return result;
    };
    assert.equal((await f.register()).status, 'durable-unverified');
    assert.equal(f.receipts().length, 1, 'raw write may survive uncertain acknowledgment');
    f.w.risuai.pluginStorage.setItem = original;
    f.clock.now += 60000;
    const result = await f.register(clone(f.originalOrigin)); assert.equal(result.status, 'registered');
    assertDeadline(f, result.pending, EPOCH);
  });
  await test('failed raw write retry from fresh queued clone keeps first deadline', async f => {
    f.freezeTimers(); await f.complete();
    const restore = f.failRawWrites();
    const first = f.api.previewManagedAfterRequestOriginForChatBySequence(f.control.chat, f.origin.requestSequence);
    assert.equal((await f.register(first)).status, 'durable-unverified');
    assert.equal(f.receipts().length, 0);
    restore(); f.clock.now += 60000;
    const next = f.api.previewManagedAfterRequestOriginForChatBySequence(f.control.chat, f.origin.requestSequence);
    const result = await f.register(next); assert.equal(result.status, 'registered');
    assertDeadline(f, result.pending, EPOCH);
  });
  await test('duplicate receipt overrides a reconstructed later origin deadline', async f => {
    f.freezeTimers(); await f.complete();
    assert.equal((await f.register()).status, 'registered');
    f.api.MemoryState.pendingTurnCommits.clear();
    f.api.MemoryState.afterRequestOriginsByType.clear();
    f.api.MemoryState.recentNarrativeOriginByScope.clear();
    f.api.MemoryState.recentMainResponseOutputCaptureByChatId.clear();
    f.capture.originSnapshot = null;
    f.clock.now += 60000;
    const result = await f.register(clone(f.originalOrigin)); assert.equal(result.status, 'registered');
    assertDeadline(f, result.pending, EPOCH);
  });
  for (const field of ['canonicalScope', 'resetGeneration', 'runtimeScopeKey', 'scopeKey', 'requestId', 'requestSequence']) {
    await test(`queued stamp cannot cross ${field} provenance`, async f => {
      f.freezeTimers(); await f.complete();
      const passed = clone(f.originalOrigin);
      f.origin[field] = typeof f.origin[field] === 'number' ? f.origin[field] + 1 : f.origin[field] + '-foreign';
      f.origin.observedAt = EPOCH - 100000;
      f.origin.analysisDeadlineAt = EPOCH + 1000;
      const result = await f.register(passed); assert.equal(result.status, 'registered');
      assertDeadline(f, result.pending, EPOCH);
      assert.equal(f.origin.analysisDeadlineAt, EPOCH + 1000, 'foreign owner is not changed');
    });
  }
  await test('expired queued clones share first deadline through retained owners after failed raw write', async f => {
    f.freezeTimers();
    f.clock.now += 650000;
    assert.equal(f.api.pruneAfterRequestOriginQueue('model').length, 0);
    await f.complete();
    const retained = retainOutputFixture(f, { ...f.capture, originSnapshot: clone(f.originalOrigin) });
    const chunkObservedAt = retained.observedAt;
    const restore = f.failRawWrites();
    assert.equal((await f.register(clone(f.originalOrigin), clone(retained))).status, 'durable-unverified');
    assert.equal(f.receipts().length, 0);
    restore(); f.clock.now += 60000;
    const result = await f.register(clone(retained.originSnapshot), clone(retained)); assert.equal(result.status, 'registered');
    assertDeadline(f, result.pending, EPOCH + 650000);
    assert.equal(retained.observedAt, chunkObservedAt, 'chunk observation clock is unchanged');
  });
  await test('matching retained owners converge on earliest valid stamps', async f => {
    f.freezeTimers(); await f.complete();
    const recent = f.api.MemoryState.recentNarrativeOriginByScope.get(f.origin.scopeKey);
    assert(recent);
    recent.observedAt = EPOCH - 20000; recent.analysisDeadlineAt = EPOCH + 90000;
    f.origin.observedAt = EPOCH - 10000; f.origin.analysisDeadlineAt = EPOCH + 120000;
    const retained = retainOutputFixture(f, { ...f.capture, originSnapshot: clone(f.originalOrigin) });
    const result = await f.register(clone(f.originalOrigin), retained); assert.equal(result.status, 'registered');
    assertDeadline(f, result.pending, EPOCH - 20000, EPOCH + 90000);
    for (const owner of [recent, f.origin, retained.originSnapshot]) {
      assert.equal(owner.observedAt, EPOCH - 20000);
      assert.equal(owner.analysisDeadlineAt, EPOCH + 90000);
    }
  });
  await test('foreign retained snapshots cannot lend or receive a deadline', async f => {
    f.freezeTimers(); await f.complete();
    const foreign = { ...clone(f.origin), requestId: 'unrelated-request', observedAt: EPOCH - 20000, analysisDeadlineAt: EPOCH + 1000 };
    f.api.MemoryState.recentNarrativeOriginByScope.set(f.origin.scopeKey, clone(foreign));
    const retained = retainOutputFixture(f, { ...f.capture, originSnapshot: clone(foreign) });
    const result = await f.register(f.origin, retained); assert.equal(result.status, 'registered');
    assertDeadline(f, result.pending, EPOCH);
    assert.equal(retained.originSnapshot.analysisDeadlineAt, foreign.analysisDeadlineAt);
    assert.equal(f.api.MemoryState.recentNarrativeOriginByScope.get(f.origin.scopeKey).analysisDeadlineAt, foreign.analysisDeadlineAt);
  });
  for (const [budget, expected] of [[1, 30000], [9999999, 900000], [NaN, BUDGET]]) {
    await test(`fallback keeps existing budget normalization ${String(budget)}`, async f => {
      f.freezeTimers(); await f.complete(); f.api.MemoryEngine.CONFIG.afterRequestAnalysisBudgetMs = budget;
      const result = await f.register(); assert.equal(result.status, 'registered');
      assertDeadline(f, result.pending, EPOCH, EPOCH + expected);
    });
  }
  await test('legacy deadline-zero receipt remains unchanged on duplicate fallback', async f => {
    f.freezeTimers(); await f.complete();
    const legacy = await f.api.DurableTurnLedger.appendObserved({ origin: f.origin, recordId: f.origin.requestId, assistantText: f.response, userText: f.origin.canonicalUser.raw });
    assert.equal(legacy.ok, true); assert.equal(legacy.record.analysisDeadlineAt, 0);
    const rawBefore = f.store.get(legacy.recordKey);
    const result = await f.register(); assert.equal(result.status, 'registered');
    assert.equal(f.store.get(legacy.recordKey), rawBefore, 'legacy raw bytes are not migrated');
    assert.equal(result.pending.targetContext.analysisDeadlineAt || 0, 0, 'legacy replay semantics stay unchanged');
  });
  for (const expired of [true, false]) await test(`${expired ? 'expired' : 'within-budget'} fallback restart preserves deadline and provider behavior`, async f => {
    f.freezeTimers(); await f.complete();
    const captured = await f.register(); assert.equal(captured.status, 'registered');
    const committed = await f.api.PendingTurnManager.commitPendingNow(f.context.char, f.context.chat, 'afterRequest-missing-fallback', { pending: captured.pending, deferMaintenance: true });
    assert.equal(committed.status, 'finalized', JSON.stringify(committed));
    const originalReceipt = f.receipts()[0];
    const store = new Map(f.store), character = clone(f.control.char);
    f.close();
    const fresh = await loadGui({ nativeInitialization: true, store, character });
    try {
      installClock(fresh, EPOCH + (expired ? 610000 : 60000));
      let providerCalls = 0;
      Object.assign(fresh.api.MemoryEngine.CONFIG, { useLLM: true, afterRequestParallelAnalysis: false, analysisRecoveryImmediateAttempts: 0, analysisRecoveryDeferredAttempts: 2, worldAdditionalEnabled: false, storyAuthorEnabled: false, directorEnabled: false });
      fresh.api.LLMProvider.isConfigured = () => true;
      fresh.api.LLMProvider.call = async () => { providerCalls++; return { content: JSON.stringify({ canonicalPacket: fakePacket(f.response) }), finishReason: 'stop' }; };
      assert.equal(fresh.api.scheduleDurableTurnReplay(f.originalOrigin), true);
      for (let i = 0; i < 80; i++) {
        await fresh.advance(500);
        const receipt = readLedgerReceipts(store)[0];
        if (['done', 'deadline'].includes(receipt.analysisStatus)) break;
      }
      const receipt = readLedgerReceipts(store)[0];
      assert.equal(providerCalls, expired ? 0 : 1, 'provider invocation obeys original capture window');
      assert.equal(receipt.analysisStatus, expired ? 'deadline' : 'done');
      assert.equal(receipt.analysisDeadlineAt, EPOCH + BUDGET, 'restart cannot renew deadline');
      assert.equal(store.get(originalReceipt.recordKey), f.store.get(originalReceipt.recordKey), 'raw stays immutable across restart');
      return { providerCalls, analysisStatus: receipt.analysisStatus, deadline: receipt.analysisDeadlineAt };
    } finally { fresh.close(); }
  });
  console.log(JSON.stringify({ mode: process.env.LIBRA_DEADLINE_TEST_SOURCE === '1' ? 'manifest-source' : (process.env.LIBRA_GUI_TEST_DIST || 'Full'), passed: checks.filter(x => x.ok).length, failed: checks.filter(x => !x.ok).length, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
