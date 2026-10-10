'use strict';
// Actual emitted GUI + durable raw/status sidecars, reopened in a fresh runtime.
// No replacement ledger, pending inspector, historical handler, or provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const fixturePath = path.join(__dirname, 'libra_management_gui_integration_test.cjs');
const fixtureModule = new Module(fixturePath, module); fixtureModule.filename = fixturePath;
fixtureModule.paths = Module._nodeModulePaths(__dirname);
fixtureModule._compile(fs.readFileSync(fixturePath, 'utf8')
  .replace("code.lastIndexOf('\\n})();')", "code.lastIndexOf('})();')")
  .replace('PersonaRuntimeCoordinator};', 'PersonaRuntimeCoordinator,PendingTurnManager,DurableTurnLedger,getStableChatScopeKey};'), fixturePath);
const { loadGui } = fixtureModule.exports;
const clone = value => JSON.parse(JSON.stringify(value));
const flush = async f => { while (f.pending.length) await Promise.allSettled(f.pending.splice(0)); await new Promise(resolve => setImmediate(resolve)); };
async function waitFor(test, label) { const end = Date.now() + 3000; while (Date.now() < end) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail(label); }
const checks = [];
async function fixture(file, reasons = ['blocked_host_source_changed'], options = {}) {
  process.env.LIBRA_GUI_TEST_DIST = path.join(__dirname, '../dist', file);
  const { mutateSeed, ...guiOptions } = options;
  const seed = await loadGui({ beforeHydrate: ({store, key}) => store.set(key, JSON.stringify({version:'1.0', scopeKey:'char:fixture-char|chat:fixture-chat|persona:persona-a', entries:[]})) });
  const handles = [];
  try {
    for (const [i, reason] of reasons.entries()) {
      const handle = await seed.api.DurableTurnLedger.appendObserved({
        scopeKey:seed.api.getStableChatScopeKey(seed.control.chat, seed.control.char),
        runtimeScopeKey:seed.api.getChatRuntimeScopeKey(seed.control.chat, seed.control.char),
        canonicalScope:'char:fixture-char|chat:fixture-chat|persona:persona-a', characterId:'fixture-char', characterIndex:0,
        chatId:'fixture-chat', chatIndex:0, recordId:'parked-'+i, requestSequence:i+1, originMessageCount:2*i+1,
        userText:'Private raw question '+i, assistantText:'Private raw answer '+i
      });
      assert.equal(handle.ok, true);
      const updated = await seed.api.DurableTurnLedger.markStatus(handle, {status:'observed', analysisStatus:reason === 'blocked_host_source_changed' ? reason : 'awaiting_host_anchor', deferredReason:reason});
      assert.equal(updated.ok, true); handles.push(handle);
    }
    if (mutateSeed) await mutateSeed(seed, handles);
    const store = new Map(seed.store), character = clone(seed.control.char);
    character.chats[0].message = [{role:'user', data:'Open the old notebook.', chatId:'u0'}, {role:'char', data:'Mira finds a notebook.', chatId:'a0'}];
    character.chats[0].msgs = clone(character.chats[0].message);
    seed.close();
    let providers = 0;
    const f = await loadGui({store, character, nativeFetch:async () => { providers++; throw Error('provider calls forbidden'); }, ...guiOptions});
    f.handles = handles; f.providers = () => providers;
    f.section = () => { const node = f.overlay.querySelector('#health-pending-capture'); assert(node, 'existing health review must expose parked raw receipts'); return node; };
    f.snapshot = () => JSON.stringify([...f.store]);
    f.assertReadOnly = before => { assert.equal(f.snapshot(), before); assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.hostWrites.length, 0); assert.equal(f.providers(), 0); };
    return f;
  } finally { seed.close(); }
}
async function check(file, name, run, reasons, options) {
  if (process.env.WM_PENDING_HEALTH_FILTER && !new RegExp(process.env.WM_PENDING_HEALTH_FILTER).test(name)) return;
  let f;
  try { f = await fixture(file, reasons, options); await run(f); checks.push({file, name, ok:true}); console.log('PASS '+file+': '+name); }
  catch (error) { checks.push({file, name, ok:false, error:error.stack}); console.error('FAIL '+file+': '+name+': '+error.message); }
  finally { f?.close(); }
}
async function resetSeed(seed) {
  const operation = seed.overlay.querySelector('#lmai-data-reset').onclick();
  const dialog = seed.w.document.querySelector('[data-libra-dialog="true"]');
  assert(dialog, 'actual reset requires its existing confirmation');
  const approve = [...dialog.querySelectorAll('button')].find(node => node.textContent === '확인');
  assert(approve); approve.click(); await operation;
  assert.equal(JSON.parse(seed.store.get(seed.key)).resetGeneration, 1, 'actual verified reset persisted generation one');
}
async function main() {
  const files = process.env.WM_PENDING_VARIANT === 'min' ? ['LIBRA World Manager.js'] : ['LIBRA World Manager Full.js'];
  for (const file of files) {
    await check(file, 'fresh runtime exposes retained source-changed receipt with restoration guidance', async f => {
      const section = f.section(), before = f.snapshot();
      assert.equal(section.dataset.readState, 'current'); assert.equal(section.dataset.coverage, 'complete');
      assert.match(section.textContent, /blocked_host_source_changed/);
      assert.match(section.textContent, /원문.*보존/); assert.match(section.textContent, /정본.*미완료|정본.*미저장/); assert.match(section.textContent, /분석.*미완료|미분석/);
      assert.match(section.textContent, /호스트.*원문.*복원/); assert.match(section.textContent, /전체 대화.*재분석/);
      assert(!section.textContent.includes('Private raw'), 'GUI explains metadata without exposing raw text');
      assert.equal(f.overlay.querySelector('#health-summary').dataset.healthSeverity, 'warn');
      assert.equal(f.overlay.querySelector('#health-summary').dataset.coverage, 'complete', 'canonical coverage stays separate');
      await f.click('#btn-health-refresh'); f.assertReadOnly(before);
      const receipt = await f.api.DurableTurnLedger.readRecord(f.handles[0]); assert.equal(receipt.record.status, 'observed');
      assert.equal(receipt.record.analysisStatus, 'blocked_host_source_changed');
    });
    await check(file, 'fresh runtime displays each capacity and ordering blocker read only', async f => {
      const section = f.section(), before = f.snapshot();
      for (const reason of ['pending_queue_capacity','pending_durable_backlog','pending_order_read_unverified','pending_order_scan_incomplete']) assert(section.textContent.includes(reason));
      assert.equal(section.querySelectorAll('[data-pending-reason]').length, 4);
      assert.equal(section.querySelector('#btn-pending-capture-review'), null, 'queue-only blockers do not trigger source restoration reanalysis');
      await f.click('#btn-health-scan'); assert(f.section().textContent.includes('pending_queue_capacity')); f.assertReadOnly(before);
    }, ['pending_queue_capacity','pending_durable_backlog','pending_order_read_unverified','pending_order_scan_incomplete']);
    await check(file, 'bounded pending scan is explicitly incomplete independent of complete canonical coverage', async f => {
      const section = f.section();
      assert.equal(section.dataset.coverage, 'incomplete'); assert.equal(Number(section.dataset.scanned), 16);
      assert.equal(section.querySelectorAll('[data-pending-reason]').length, 16); assert.match(section.textContent, /일부|제한/);
      assert.match(section.textContent, /전체.*확인.*않|정상.*확정.*않/);
      assert.equal(f.overlay.querySelector('#health-summary').dataset.coverage, 'complete');
      assert.equal(f.overlay.querySelector('#health-summary').dataset.healthSeverity, 'warn');
    }, Array(17).fill('pending_queue_capacity'));
    await check(file, 'failed durable read is unavailable and cannot masquerade as empty health', async f => {
      f.section(); const before = f.snapshot(), original = f.w.risuai.pluginStorage.getItem;
      f.w.risuai.pluginStorage.getItem = async key => { if (key.startsWith('libra.v5.ltm.turn-ledger::')) throw Error('synthetic sidecar read failure'); return original(key); };
      await f.click('#btn-health-refresh'); const section = f.section();
      assert.equal(section.dataset.readState, 'unavailable'); assert.equal(section.dataset.coverage, 'unavailable');
      assert.match(section.textContent, /확인 불가|확인할 수 없/); assert(!section.textContent.includes('보류된 원문 없음'));
      assert.equal(f.overlay.querySelector('#health-summary').dataset.healthSeverity, 'warn');
      assert.equal(section.querySelector('#btn-pending-capture-review'), null); f.assertReadOnly(before);
    });
    await check(file, 'canonical read failure disables pending review route and preserves stored raw', async f => {
      f.section(); const before = f.snapshot(); f.control.failReads = true;
      await f.click('#btn-health-refresh'); const section = f.section();
      assert.equal(section.dataset.readState, 'unavailable'); assert.equal(section.querySelector('#btn-pending-capture-review'), null);
      assert.notEqual(f.overlay.querySelector('#health-summary').dataset.readState, 'current'); f.assertReadOnly(before);
    });
    await check(file, 'source-change review reaches existing whole-conversation confirmation and cancel makes no model calls', async f => {
      const section = f.section(), before = f.snapshot();
      f.api.MemoryEngine.CONFIG.useLLM = true;
      f.api.MemoryEngine.CONFIG.llm = {...f.api.MemoryEngine.CONFIG.llm, provider:'openai', url:'https://mock-only.invalid', key:'mock-only', model:'mock', stream:false};
      const button = section.querySelector('#btn-pending-capture-review'); assert(button);
      let existingClicks = 0; f.overlay.querySelector('#btn-cold-reanalyze').addEventListener('click', () => existingClicks++);
      button.click();
      await waitFor(() => f.w.document.querySelector('[data-libra-dialog="true"]'), 'existing whole-conversation confirmation must be reachable');
      const dialog = f.w.document.querySelector('[data-libra-dialog="true"]');
      assert.equal(existingClicks, 1); assert.match(dialog.textContent, /예상 LLM 호출/);
      const cancel = [...dialog.querySelectorAll('button')].find(node => node.textContent === '취소'); assert(cancel); cancel.click();
      await waitFor(() => f.overlay.querySelector('#historical-reanalysis-status').dataset.state === 'rejected', 'existing cancelled handler finishes');
      await flush(f); f.assertReadOnly(before);
      assert.equal((await f.api.DurableTurnLedger.readRecord(f.handles[0])).record.status, 'observed');
    });
    await check(file, 'actual verified reset keeps old raw historical rather than a current blocker after reopen', async f => {
      const section = f.section(), before = f.snapshot();
      assert.equal(section.dataset.currentResetGeneration, '1');
      assert.equal(section.dataset.currentBlockers, '0'); assert.equal(section.dataset.historicalCount, '1');
      assert.equal(section.dataset.unknownGenerationCount, '0');
      const row = section.querySelector('#health-pending-historical [data-pending-generation="historical"]');
      assert(row, 'retained historical raw remains visible in its own section');
      assert.match(row.textContent, /blocked_host_source_changed/);
      assert.match(section.textContent, /초기화 이전|초기화 전/); assert.match(section.textContent, /현재.*보류.*제외|현재.*차단.*제외/);
      assert.equal(section.querySelector('#btn-pending-capture-review'), null, 'reset historical raw must not prompt restoration into the new generation');
      assert.equal(f.api.ActivityDashboardCore.getState().healthSummary.total, 0, 'historical receipt is excluded from current health blockers');
      const receipt = await f.api.DurableTurnLedger.readRecord(f.handles[0]);
      assert.equal(receipt.record.resetGeneration, 0); assert.equal(receipt.record.status, 'observed');
      await f.click('#btn-health-refresh'); f.assertReadOnly(before);
    }, undefined, {mutateSeed: resetSeed});
    await check(file, 'mixed historical and current reset generations are counted separately', async f => {
      const section = f.section(), before = f.snapshot();
      assert.equal(section.dataset.currentResetGeneration, '1');
      assert.equal(section.dataset.currentBlockers, '1'); assert.equal(section.dataset.historicalCount, '1');
      assert.equal(section.querySelectorAll('[data-pending-generation="current"]').length, 1);
      assert.equal(section.querySelectorAll('[data-pending-generation="historical"]').length, 1);
      assert.equal(f.api.ActivityDashboardCore.getState().healthSummary.total, 1);
      assert(section.querySelector('#btn-pending-capture-review'), 'verified current source-change still reaches the existing review route');
      await f.click('#btn-health-refresh'); f.assertReadOnly(before);
    }, undefined, {mutateSeed: async seed => {
      await resetSeed(seed);
      const handle = await seed.api.DurableTurnLedger.appendObserved({scopeKey:seed.api.getStableChatScopeKey(seed.control.chat, seed.control.char),
        runtimeScopeKey:seed.api.getChatRuntimeScopeKey(seed.control.chat, seed.control.char), canonicalScope:'char:fixture-char|chat:fixture-chat|persona:persona-a',
        characterId:'fixture-char', characterIndex:0, chatId:'fixture-chat', chatIndex:0, recordId:'current-after-reset', requestSequence:2, originMessageCount:3,
        resetGeneration:1, userText:'New question after reset', assistantText:'New answer after reset'});
      assert.equal(handle.ok, true);
      assert.equal((await seed.api.DurableTurnLedger.markStatus(handle, {status:'observed', analysisStatus:'blocked_host_source_changed', deferredReason:'blocked_host_source_changed'})).ok, true);
    }});
    for (const generation of ['missing', null, 'invalid', -1]) await check(file, 'unresolved raw reset metadata remains visible and never healthy: '+String(generation), async f => {
      const section = f.section(), before = f.snapshot();
      assert.equal(section.dataset.currentResetGeneration, '1');
      assert.equal(section.dataset.unknownGenerationCount, '1'); assert.equal(section.dataset.currentBlockers, '0');
      assert.equal(section.dataset.historicalCount, '0', 'unknown metadata must not be treated as old harmless history');
      assert(section.querySelector('#health-pending-unknown [data-pending-generation="unknown"]'));
      assert.match(section.textContent, /초기화 세대.*미확인|초기화 세대.*확인할 수 없/);
      assert.equal(f.overlay.querySelector('#health-summary').dataset.healthSeverity, 'warn');
      assert.equal(f.api.ActivityDashboardCore.getState().healthSummary.total, null, 'unknown generation makes current blocker count unresolved');
      assert.equal(section.querySelector('#btn-pending-capture-review'), null, 'unknown ownership cannot authorize current reanalysis routing');
      await f.click('#btn-health-refresh'); f.assertReadOnly(before);
    }, undefined, {mutateSeed: async (seed, handles) => {
      await resetSeed(seed);
      const raw = JSON.parse(seed.store.get(handles[0].recordKey));
      if (generation === 'missing') delete raw.resetGeneration; else raw.resetGeneration = generation;
      seed.store.set(handles[0].recordKey, JSON.stringify(raw));
    }});
    for (const transition of ['persona','close','newer-refresh']) await check(file, 'delayed pending read cannot publish after '+transition, async f => {
      f.section(); const before = f.snapshot(), original = f.w.risuai.pluginStorage.getItem;
      let enter, release, held = false; const started = new Promise(resolve => enter = resolve), gate = new Promise(resolve => release = resolve);
      f.w.risuai.pluginStorage.getItem = async key => { const value = await original(key); if (!held && key.startsWith('libra.v5.ltm.turn-ledger::')) { held = true; enter(); await gate; } return value; };
      f.overlay.querySelector('#btn-health-refresh').click(); const older = f.pending.splice(0); await started;
      if (transition === 'persona') { f.control.chat.bindedPersona = 'persona-b'; f.control.char.chats[0] = f.control.chat; }
      else if (transition === 'close') f.overlay.querySelector('#xbtn').click();
      else { f.w.risuai.pluginStorage.getItem = async key => { if (key.startsWith('libra.v5.ltm.turn-ledger::')) throw Error('new read unavailable'); return original(key); }; await f.click('#btn-health-refresh'); }
      release(); await Promise.allSettled(older); await flush(f);
      if (transition === 'close') assert.equal(f.overlay.isConnected, false);
      else { assert.equal(f.section().dataset.readState, 'unavailable'); assert.equal(f.section().querySelector('#btn-pending-capture-review'), null); }
      f.assertReadOnly(before);
    });
  }
  console.log(JSON.stringify({passed:checks.filter(check=>check.ok).length, failed:checks.filter(check=>!check.ok).length, checks}, null, 2));
  if (checks.some(check=>!check.ok)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
