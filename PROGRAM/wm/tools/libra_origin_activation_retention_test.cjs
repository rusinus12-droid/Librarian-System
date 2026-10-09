'use strict';
const assert = require('node:assert/strict');
const { loadGui } = process.env.LIBRA_GUI_TEST_DIST?.endsWith('LIBRA World Manager.js') ? (() => {
  const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
  const fixturePath = path.join(__dirname, 'libra_management_gui_integration_test.cjs');
  let source = fs.readFileSync(fixturePath, 'utf8');
  const anchor = "code.lastIndexOf('\\n})();')";
  assert(source.includes(anchor), 'known GUI fixture IIFE closure seam');
  source = source.replace(anchor, "code.lastIndexOf('})();')");
  const fixtureModule = new Module(fixturePath, module);
  fixtureModule.filename = fixturePath;
  fixtureModule.paths = Module._nodeModulePaths(__dirname);
  fixtureModule._compile(source, fixturePath);
  return fixtureModule.exports;
})() : require('./libra_management_gui_integration_test.cjs');
const { readLedgerReceipts } = require('./libra_generation_capture_receipt_fixture.cjs');
const clone = x => JSON.parse(JSON.stringify(x));
const checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(test, message, timeout = 8500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (test()) return; await sleep(20); }
  assert.fail(message);
}
async function fixture() {
  const f = await loadGui({ nativeInitialization: true, store: new Map() });
  const r = f.w.risuai;
  // The shared GUI fixture defaults to one chat. Use real indexed host reads
  // here so detached A workers cannot accidentally resolve to visible B.
  r.getCurrentChatIndex = async () => f.control.char.chatPage;
  r.getChatFromIndex = async (_, index) => clone(f.control.char.chats[index]);
  r.setChatToIndex = async (_, index, value) => {
    f.calls.hostWrites.push(clone(value));
    f.control.char.chats[index] = clone(value);
    if (index === f.control.char.chatPage) f.control.chat = f.control.char.chats[index];
    return true;
  };
  f.a = f.control.chat;
  f.a.message = f.a.msgs = [{ role: 'user', data: 'Mira puts the blue notebook on the table.', m_id: 'a-user', time: Date.now() }];
  f.b = { id: 'chat-b', bindedPersona: 'persona-b', localLore: [], message: [], msgs: [], isStreaming: false };
  f.control.char.chats.push(f.b);
  f.select = index => { f.control.char.chatPage = index; f.control.chat = f.control.char.chats[index]; };
  f.begin = () => f.callbacks.beforeRequest([{ role: 'user', content: f.a.message[0].data }], 'model');
  f.response = 'Mira opens the blue notebook and records the northern route.';
  f.saveHostResponse = () => { f.a.message = f.a.msgs = [...f.a.message, { role: 'assistant', data: f.response, m_id: 'a-assistant', time: Date.now() }]; };
  f.origins = () => [...f.api.MemoryState.afterRequestOriginsByType.values()].flat();
  f.receipts = () => readLedgerReceipts(f.store);
  f.io = { storageReads: 0, hostReads: 0 };
  for (const key of ['getCharacter', 'getCharacterFromIndex', 'getChatFromIndex']) {
    const original = r[key]; r[key] = async (...args) => { f.io.hostReads++; return original(...args); };
  }
  const originalRead = r.pluginStorage.getItem;
  r.pluginStorage.getItem = async (...args) => { f.io.storageReads++; return originalRead(...args); };
  return f;
}
async function test(name, fn) {
  if (process.env.LIBRA_ORIGIN_TEST_FILTER && !new RegExp(process.env.LIBRA_ORIGIN_TEST_FILTER).test(name)) return;
  let f;
  try { f = await fixture(); const detail = await fn(f); checks.push({ name, ok: true, detail }); }
  catch (error) { checks.push({ name, ok: false, error: error.stack }); process.exitCode = 1; }
  finally { f?.close(); }
}
(async () => {
  for (const switchKind of ['chat', 'persona']) await test(`registered ${switchKind} GUI activation retains A raw response ownership`, async f => {
    await f.begin();
    const origin = clone(f.origins()[0]);
    assert(origin?.requestId, 'beforeRequest registered an actual A origin');
    if (switchKind === 'chat') f.select(1); else f.a.bindedPersona = 'persona-b';
    await f.callbacks.setting();
    assert(f.api.MemoryState._activeScopeKey.endsWith('::persona:persona-b'));
    const bScope = f.api.MemoryState._activeScopeKey, beforeWrites = f.calls.writes.length;
    const started = Date.now();
    const value = await f.callbacks.afterRequest(f.response, 'model');
    assert.equal(value, f.response, 'host wrapper preserves response identity');
    assert(Date.now() - started < 100, 'response callback does not wait for detached work');
    f.saveHostResponse();
    await waitFor(() => f.receipts().length === 1, 'A response must reach durable raw storage after actual B GUI activation', 2000);
    await waitFor(() => f.receipts()[0].analysisStatus === 'deferred', 'inactive A worker is deferred', 2000);
    const receipt = f.receipts()[0];
    assert.equal(receipt.recordId, origin.requestId);
    assert.equal(receipt.runtimeScopeKey, origin.runtimeScopeKey);
    assert.equal(receipt.canonicalScope, origin.canonicalScope);
    assert.equal(receipt.resetGeneration, origin.resetGeneration);
    assert.equal(receipt.assistantText, f.response);
    assert.equal(receipt.userText, f.a.message[0].data);
    assert.equal(receipt.deferredReason, 'target_not_active');
    assert.equal(f.api.MemoryState._activeScopeKey, bScope);
    assert.equal(f.calls.writes.slice(beforeWrites).filter(x => x.key.startsWith('LIBRA_DATA::')).length, 0);
    assert.equal(f.calls.hostWrites.length, 0);
    assert.equal(f.origins().length, 0);
    return { receiptScope: receipt.canonicalScope, storageWrites: f.calls.writes.length - beforeWrites, io: f.io,
      afterConsumption: { origins: f.origins().length, timers: f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.size } };
  });
  await test('retained missing-response timer survives B activation and recovers on A return', async f => {
    await f.begin(); const origin = clone(f.origins()[0]);
    f.select(1); await f.callbacks.setting();
    assert(f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.has(f.a.id), 'pending A timer survives runtime-only activation');
    f.saveHostResponse();
    // Streaming hosts have no afterRequest callback. Keep the actual fallback
    // timer, return to A, and wait for its ordinary 5-second host snapshot read.
    f.select(0); await f.callbacks.setting();
    await waitFor(() => f.receipts().some(r => r.status === 'committed'), 'missing-hook fallback persists returned A', 12000);
    assert.equal(f.receipts()[0].recordId, origin.requestId);
    assert.equal(f.receipts()[0].assistantText, f.response);
    assert(f.receipts()[0].canonicalScope.endsWith('persona:persona-a'));
  });
  await test('ordinary reset cancels retained ownership and missing-response timer', async f => {
    await f.begin(); f.select(1); await f.callbacks.setting();
    f.api.MemoryState.reset();
    assert.equal(f.origins().length, 0);
    assert.equal(f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.size, 0);
    await f.callbacks.afterRequest(f.response, 'model'); f.saveHostResponse(); await sleep(100);
    assert.equal(f.receipts().length, 0);
  });
  await test('A raw receipt replays to canonical memory and survives fresh runtime after B navigation', async f => {
    await f.begin(); const origin = clone(f.origins()[0]);
    f.select(1); await f.callbacks.setting();
    await f.callbacks.afterRequest(f.response, 'model'); f.saveHostResponse();
    await waitFor(() => f.receipts()[0]?.analysisStatus === 'deferred', 'A raw is durably deferred');
    f.select(0); await f.callbacks.setting();
    await f.callbacks.beforeRequest([{ role: 'user', content: 'Mira carefully turns the next page of her notebook.' }], 'model');
    await waitFor(() => f.receipts().some(r => r.recordId === origin.requestId && r.status === 'committed'), 'A durable replay reaches canonical commit');
    const row = JSON.parse(f.store.get(f.key)).entries.find(e => e.comment === 'lmai_memory' && e.content.includes('a-assistant'));
    assert(row?.content.includes(f.response), 'canonical memory has A response and host anchor');
    const fresh = await loadGui({ nativeInitialization: true, store: f.store, character: f.control.char });
    try {
      const lore = fresh.api.MemoryEngine.getLorebook(fresh.control.char, fresh.control.chat);
      assert(lore.some(e => e.comment === 'lmai_memory' && e.content.includes('a-assistant') && e.content.includes(f.response)));
      assert.equal(fresh.api.MemoryState._activeScopeKey, origin.runtimeScopeKey);
    } finally { fresh.close(); }
  });
  await test('missing-response timer waits through a same-chat B persona and never captures B', async f => {
    await f.begin(); const origin = clone(f.origins()[0]);
    f.a.bindedPersona = 'persona-b'; await f.callbacks.setting(); f.saveHostResponse();
    await sleep(5300);
    assert.equal(f.receipts().length, 0, 'B persona cannot receive A fallback');
    assert(f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.has(f.a.id), 'A remains retryable');
    f.a.bindedPersona = 'persona-a'; await f.callbacks.setting();
    await waitFor(() => f.receipts().some(r => r.status === 'committed'), 'A fallback resumes only after exact persona returns');
    assert.equal(f.receipts()[0].recordId, origin.requestId);
    assert.equal(f.receipts()[0].canonicalScope, origin.canonicalScope);
  });
  await test('unbound A missing-response timer remains retryable while B is active past its first check', async f => {
    delete f.a.bindedPersona;
    await f.begin(); const origin = clone(f.origins()[0]);
    assert(origin.canonicalScope.endsWith('persona:persona-a'));
    f.select(1); await f.callbacks.setting(); f.saveHostResponse();
    await sleep(5300);
    assert.equal(f.receipts().length, 0);
    assert(f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.has(f.a.id), 'inactive unbound A must retain its pending recovery check');
    f.select(0); await f.callbacks.setting();
    await waitFor(() => f.receipts().some(r => r.status === 'committed'), 'unbound A fallback resumes after return');
    assert.equal(f.receipts()[0].recordId, origin.requestId);
    assert.equal(f.receipts()[0].canonicalScope, origin.canonicalScope);
    assert(f.calls.hostWrites.every(chat => chat.id === f.a.id), 'unbound admission may stamp A, never B');
  });
  await test('reset while retained fallback awaits host read cancels its detached continuation', async f => {
    await f.begin(); f.select(1); await f.callbacks.setting(); f.saveHostResponse();
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const original = f.w.risuai.getCharacterFromIndex;
    f.w.risuai.getCharacterFromIndex = async (...args) => { started(); await gate; return original(...args); };
    await Promise.race([entered, sleep(6500).then(() => { throw new Error('fallback never reached host read'); })]);
    f.api.MemoryState.reset(); release(); await sleep(100);
    assert.equal(f.receipts().length, 0);
    assert.equal(f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.size, 0);
    assert.equal(f.api.MemoryState.pendingTurnCommits.size, 0);
  });
  await test('retained origins remain capped and navigation adds no storage writes', async f => {
    for (let i = 0; i < 12; i++) await f.begin();
    assert.equal(f.origins().length, 10, 'unchanged origin cap is enforced');
    const bytes = Buffer.byteLength(JSON.stringify(f.origins())), sequence = f.api.MemoryState.afterRequestOriginSequence;
    const writes = f.calls.writes.length;
    for (const index of [1, 0, 1, 0]) { f.select(index); await f.callbacks.setting(); }
    assert.equal(f.origins().length, 10);
    assert.equal(f.api.MemoryState.afterRequestOriginSequence, sequence);
    assert.equal(f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.size, 1);
    assert.equal(f.calls.writes.length, writes, 'runtime-only preservation adds no persistence I/O');
    assert.equal(Buffer.byteLength(JSON.stringify(f.origins())), bytes, 'repeated navigation does not grow retained state');
    const expired = f.origins(); for (const origin of expired) origin.expiresAt = Date.now() - 1;
    f.select(1); await f.callbacks.setting();
    assert.equal(f.origins().length, 0); assert.equal(f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.size, 0);
    return { cappedOrigins: 10, retainedBytes: bytes, retainedTimers: 1, navigationWrites: f.calls.writes.length - writes, io: f.io };
  });
  await test('unload cancels retained origins and timers', async f => {
    await f.begin(); f.select(1); await f.callbacks.setting();
    for (const unload of f.callbacks.unload || []) await unload();
    assert.equal(f.origins().length, 0); assert.equal(f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.size, 0);
    await f.callbacks.afterRequest(f.response, 'model'); await sleep(100); assert.equal(f.receipts().length, 0);
  });
  await test('registered explicit GUI reset cancels pre-reset A origin without reviving it', async f => {
    await f.begin();
    const pending = f.w.document.querySelector('#lmai-data-reset').onclick();
    const dialog = f.w.document.querySelector('[data-libra-dialog="true"]'); assert(dialog);
    [...dialog.querySelectorAll('button')].find(button => button.textContent === '확인').click(); await pending;
    assert.equal(f.origins().length, 0);
    assert.equal(f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.size, 0);
    await f.callbacks.afterRequest(f.response, 'model'); f.saveHostResponse(); await sleep(100);
    assert.equal(f.receipts().length, 0);
    const canonical = JSON.parse(f.store.get(f.key));
    assert.equal(canonical.resetGeneration, 1); assert.equal(canonical.entries.length, 0);
  });
  await test('genuinely missing origin never falls back to visible B ownership', async f => {
    f.select(1); await f.callbacks.setting();
    assert.equal(await f.callbacks.afterRequest(f.response, 'model'), f.response);
    await sleep(100); assert.equal(f.receipts().length, 0);
  });
  console.log(JSON.stringify({ passed: checks.filter(x => x.ok).length, failed: checks.filter(x => !x.ok).length, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
