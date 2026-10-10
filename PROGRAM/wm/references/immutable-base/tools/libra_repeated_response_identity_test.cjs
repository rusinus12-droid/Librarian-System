'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { readLedgerReceipts, readCanonicalRecords } = require('./libra_generation_capture_receipt_fixture.cjs');
const fixturePath = path.join(__dirname, 'libra_management_gui_integration_test.cjs');
let source = fs.readFileSync(fixturePath, 'utf8');
source = source.replace('PersonaRuntimeCoordinator};', 'PersonaRuntimeCoordinator,PendingTurnManager,ScopedRuntimeTransaction,findPersistedAssistantSnapshotByHash,TokenizerEngine};');
if (process.env.LIBRA_GUI_TEST_DIST?.endsWith('LIBRA World Manager.js')) source = source.replace("code.lastIndexOf('\\n})();')", "code.lastIndexOf('})();')");
const fixtureModule = new Module(fixturePath, module); fixtureModule.filename = fixturePath;
fixtureModule.paths = Module._nodeModulePaths(__dirname); fixtureModule._compile(source, fixturePath);
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
  f.response = 'Mira nods slowly and places the blue notebook back on the wooden table.';
  f.receipts = () => readLedgerReceipts(f.store);
  f.memories = () => readCanonicalRecords(f.store).flatMap(x => x.record.entries || []).filter(x => x.comment === 'lmai_memory');
  f.meta = m => JSON.parse(m.content.slice(6, m.content.indexOf(']\n')));
  f.payload = m => JSON.parse(m.content.slice(m.content.indexOf(']\n') + 2));
  f.memoryFor = id => f.memories().find(m => f.meta(m).messageId === id);
  f.sourceEvidence = () => f.memories().map(m => ({ messageId: f.meta(m).messageId, ids: f.meta(m).sourceMessageIds, hash: f.meta(m).sourceHash }));
  f.addUser = (n, text) => {
    f.control.chat.message.push({ role: 'user', data: text, m_id: `user-${n}`, time: Date.now() });
    f.control.chat.msgs = f.control.chat.message;
  };
  f.begin = async (n, text) => {
    f.addUser(n, text);
    await f.callbacks.beforeRequest(f.control.chat.message.map(m => ({ role: m.role, content: m.data })), 'model');
    const origins = [...f.api.MemoryState.afterRequestOriginsByType.values()].flat();
    return origins[origins.length - 1];
  };
  f.save = n => { f.control.chat.message.push({ role: 'assistant', data: f.response, m_id: `assistant-${n}`, time: Date.now() }); f.control.chat.msgs = f.control.chat.message; };
  f.finish = async (n, text) => {
    const origin = await f.begin(n, text);
    assert(origin?.requestId);
    assert.equal(await f.callbacks.afterRequest(f.response, 'model'), f.response);
    f.save(n);
    await waitFor(() => f.receipts().find(r => r.recordId === origin.requestId)?.status === 'committed', `turn ${n} receipt committed`);
    await waitFor(() => !f.api.ScopedRuntimeTransaction.current() && !f.api.MemoryState.pendingTurnCommits.size && !f.api.MemoryState.pendingTurnCommitLocksByScope.size, 'post-response finalizer and transaction released');
    return origin;
  };
  return f;
}
async function test(name, fn) {
  if (process.env.WM_REPEAT_TEST_FILTER && !new RegExp(process.env.WM_REPEAT_TEST_FILTER).test(name)) return;
  let f;
  try { f = await fixture(); const detail = await fn(f); checks.push({ name, ok: true, detail }); }
  catch (error) { checks.push({ name, ok: false, error: error.stack, receipts: f?.receipts(), memories: f?.memories(), pending: f ? [...f.api.MemoryState.pendingTurnCommits.values()] : [], host: f?.control.chat }); process.exitCode = 1; }
  finally { f?.close(); }
}
(async () => {
  for (const sameUser of [false, true]) await test(`registered repeated assistant text keeps distinct ${sameUser ? 'identical' : 'different'} user turns`, async f => {
    const firstText = 'Mira, please mark the northern route in your blue notebook.';
    const secondText = sameUser ? firstText : 'Mira, please record the southern ferry route in the blue notebook.';
    await f.finish(1, firstText);
    assert(f.memories().some(m => m.content.includes('assistant-1')));
    const second = await f.finish(2, secondText);
    assert(f.memories().some(m => m.content.includes('assistant-2')), 'second accepted assistant message must have its own durable canonical memory');
    const memories = f.memories();
    assert.equal(memories.filter(m => m.content.includes('assistant-1')).length, 1);
    assert.equal(memories.filter(m => m.content.includes('assistant-2')).length, 1);
    const receipt = f.receipts().find(r => r.recordId === second.requestId);
    assert.notEqual(receipt.terminalReason, 'already_finalized_turn_anchor', 'new origin must not be falsely terminalized');
    const fresh = await loadGui({ nativeInitialization: true, store: f.store, character: f.control.char });
    try { assert(fresh.api.MemoryEngine.getLorebook(fresh.control.char, fresh.control.chat).some(m => m.comment === 'lmai_memory' && m.content.includes('assistant-2'))); }
    finally { fresh.close(); }
    return { receipts: f.receipts().map(r => ({ recordId: r.recordId, status: r.status, turn: r.turn, turnKey: r.turnKey })), memories: memories.length };
  });
  await test('registered delayed repeated response cannot bind the previous assistant', async f => {
    await f.finish(1, 'Mira, please mark the northern route in your blue notebook.');
    const second = await f.begin(2, 'Mira, please record the southern ferry route in the blue notebook.');
    const before = JSON.stringify(f.sourceEvidence());
    await f.callbacks.afterRequest(f.response, 'model');
    await waitFor(() => f.receipts().some(r => r.recordId === second.requestId), 'second raw receipt captured');
    await sleep(5700);
    const receipt = f.receipts().find(r => r.recordId === second.requestId);
    assert.notEqual(receipt.status, 'committed', 'response without a new accepted host message must stay uncommitted');
    assert.equal(JSON.stringify(f.sourceEvidence()), before, 'waiting response must not change previous canonical source identity');
    assert(!f.memoryFor('assistant-1').content.includes('southern ferry route'), 'waiting new user must not enter old response evidence');
    f.save(2);
    await waitFor(() => f.receipts().find(r => r.recordId === second.requestId)?.status === 'committed', 'delayed host anchor eventually commits');
    assert(f.memories().some(m => m.content.includes('assistant-2')));
    assert(!f.memories().some(m => m.content.includes('afterrequest:')), 'diagnostic synthetic IDs must not persist as canonical provenance');
  });
  await test('registered host-transformed repeated response binds the new accepted message', async f => {
    await f.finish(1, 'Mira, please mark the northern route in your blue notebook.');
    const second = await f.begin(2, 'Mira, please record the southern ferry route in the blue notebook.');
    await f.callbacks.afterRequest(f.response, 'model');
    const transformed = 'Mira puts the blue notebook away after adding a note about the southern ferry.';
    f.control.chat.message.push({ role: 'assistant', data: transformed, m_id: 'assistant-2', time: Date.now() });
    await waitFor(() => f.receipts().find(r => r.recordId === second.requestId)?.status === 'committed', 'transformed host response commits');
    assert(f.memories().some(m => m.content.includes('assistant-2') && m.content.includes(transformed)), 'host-transform must attach to assistant-2 instead of old equal raw text');
    assert(!f.memoryFor('assistant-1').content.includes('southern ferry route'), 'new user evidence must not contaminate assistant-1');
  });
  await test('identity matcher rejects conflicting IDs and later repeated replies while retaining exact backlog', async f => {
    const msg = (role, data, id) => ({ role, data, m_id: id });
    const raw = f.response, hash = f.api.TokenizerEngine.simpleHash(raw);
    const u = 'Mira opens the blue notebook.';
    const chat = { id: f.control.chat.id, message: [msg('user', u, 'u1'), msg('assistant', raw, 'a1'), msg('user', u, 'u2'), msg('assistant', raw, 'a2'), msg('user', u, 'u3'), msg('assistant', raw, 'a3')] };
    const match = options => f.api.findPersistedAssistantSnapshotByHash(chat, hash, options);
    assert.equal(match({ originMessageCount: 3, expectedUserText: u, expectedMessageIds: ['afterrequest:fixture:2:h'] }).latestLiveId, 'a2');
    assert.equal(match({ expectedUserText: 'Different user text' }), null, 'without an exact slot or ID, incompatible user text must not establish identity');
    assert.equal(match({ expectedMessageIds: ['deleted-id'], expectedUserText: u }), null);
    assert.equal(match({ expectedMessageIds: ['a1'], expectedUserText: u }).latestLiveId, 'a1', 'committed replay can locate its exact older message');
    chat.message[3].data = 'Original answer was edited.';
    assert.equal(match({ originMessageCount: 3, expectedUserText: u }), null, 'later repeated reply cannot substitute for a changed original');
  });
  for (const newId of [false, true]) await test(`registered exact continuation retains ${newId ? 'replaced' : 'stable'} host message identity`, async f => {
    f.addUser(1, 'Mira, please mark the northern route in your blue notebook.'); f.save(1);
    await f.callbacks.beforeRequest([{ role: 'assistant', content: f.response }, { role: 'user', content: 'continue' }], 'model');
    const origin = [...f.api.MemoryState.afterRequestOriginsByType.values()].flat().at(-1);
    assert.equal(origin.latestAiId, 'assistant-1');
    assert.equal(origin.messageCount, 2, 'captured origin ended with the assistant being continued');
    const continuation = 'She then draws a careful arrow beside the river crossing.';
    await f.callbacks.afterRequest(f.response + ' ' + continuation, 'model');
    const id = newId ? 'assistant-continued' : 'assistant-1';
    f.control.chat.message[f.control.chat.message.length - 1] = { role: 'assistant', data: f.response + ' ' + continuation, m_id: id, time: Date.now() };
    f.control.chat.msgs = f.control.chat.message;
    await waitFor(() => f.receipts().find(r => r.recordId === origin.requestId)?.status === 'committed', 'true continuation commits at its replaced final host slot');
    assert(f.memories().some(m => m.content.includes(id) && m.content.includes(continuation)));
    assert(!f.memories().some(m => m.content.includes('afterrequest:')));
  });
  await test('same receipt stays idempotent and hash alone cannot suppress an unrelated turn', async f => {
    const origin = await f.finish(1, 'Mira, please mark the northern route in your blue notebook.');
    const finalized = f.api.PendingTurnManager.getFinalizedTurnMeta(f.control.chat);
    assert(finalized);
    const payload = { aiHash: finalized.sourceHash, sourceHash: finalized.sourceHash, targetContext: { ...finalized.targetContext } };
    assert.equal(f.api.PendingTurnManager.isLikelyAlreadyFinalized(f.control.chat, payload), true);
    assert.equal(f.api.PendingTurnManager.registerPending(f.control.chat, payload), null);
    payload.targetContext.durableLedgerRecordId = origin.requestId + '-different';
    payload.liveMessageIds = finalized.liveMessageIds;
    assert.equal(f.api.PendingTurnManager.isLikelyAlreadyFinalized(f.control.chat, payload), false);
    assert.equal(f.api.PendingTurnManager.isLikelyAlreadyFinalized(f.control.chat, { aiHash: finalized.sourceHash }), false);
  });
  await test('frozen host slot lookup bounds hashing for a long repeated-text history', async f => {
    const user = 'Mira opens the blue notebook.';
    const messages = Array.from({ length: 10000 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', data: index % 2 ? f.response : user, m_id: 'long-' + index }));
    const hash = f.api.TokenizerEngine.simpleHash(f.response), original = f.api.TokenizerEngine.simpleHash;
    let hashed = 0;
    f.api.TokenizerEngine.simpleHash = function(...args) { hashed++; return original.apply(this, args); };
    let match;
    try { match = f.api.findPersistedAssistantSnapshotByHash({ id: 'long-chat', message: messages }, hash, { originMessageCount: 5001, expectedUserText: user }); }
    finally { f.api.TokenizerEngine.simpleHash = original; }
    assert.equal(match.latestLiveId, 'long-5001');
    assert(hashed <= 6, 'a frozen exact slot should not hash the whole chat: ' + hashed);
    return { messages: messages.length, hashCalls: hashed };
  });
  await test('registered formatted user input keeps its exact native host response slot', async f => {
    const native = 'I ask {{char}} to open the northern gate.';
    const formatted = 'I ask Mira to open the northern gate.';
    f.addUser(1, native);
    await f.callbacks.beforeRequest([{ role: 'user', content: formatted }], 'model');
    const origin = [...f.api.MemoryState.afterRequestOriginsByType.values()].flat().at(-1);
    assert.equal(origin.canonicalUser.raw, formatted);
    await f.callbacks.afterRequest(f.response, 'model'); f.save(1);
    await waitFor(() => f.receipts().find(r => r.recordId === origin.requestId)?.status === 'committed', 'formatted input must not block exact host slot');
    assert(f.memoryFor('assistant-1'));
    assert(f.memoryFor('assistant-1').content.includes(formatted));
  });
  console.log(JSON.stringify({ passed: checks.filter(x => x.ok).length, failed: checks.filter(x => !x.ok).length, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
