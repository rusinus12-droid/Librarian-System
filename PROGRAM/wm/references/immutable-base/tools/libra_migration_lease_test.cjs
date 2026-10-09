'use strict';
const assert = require('node:assert/strict');
const { load } = require('./libra_management_storage_verified_test.cjs');
const checks = [];
async function test(name, fn) {
  try {
    const f = await load({ artifact: true, extraExports: 'MemoryState,MemoryEngine,EntityManager,EntityCanonicalNameMigration,SecretKnowledgeCore,TimeEngine,WorldStateTracker,getChatRuntimeScopeKey' });
    f.chat = { id: 'migration-chat', bindedPersona: 'persona-a', localLore: [] };
    f.char = { id: 'migration-char', chatPage: 0, chats: [f.chat] };
    const admitted = await f.api.LibraDataStorage.preparePersonaContext(f.char, f.chat);
    assert.equal(admitted.ok, true);
    f.scope = admitted.runtimeScopeKey;
    f.api.MemoryState._activeScopeKey = f.scope; f.api.MemoryState._activeChatId = f.chat.id;
    await fn(f); checks.push({ name, ok: true });
  } catch (error) { checks.push({ name, ok: false, error: error.stack }); process.exitCode = 1; }
}
(async () => {
  for (const change of ['reset', 'scope']) for (const stage of ['entity', 'time', 'world']) await test(`migration continuation refuses late publication after ${change} at ${stage}`, async f => {
    const a = f.api;
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    const held = stage === 'entity' ? [a.EntityManager, 'saveToLorebook'] : stage === 'time' ? [a.TimeEngine, 'saveState'] : [a.WorldStateTracker, 'saveState'];
    const next = stage === 'entity' ? [a.TimeEngine, 'saveState'] : stage === 'time' ? [a.WorldStateTracker, 'saveState'] : [a.MemoryEngine, 'rebuildIndex'];
    const save = held[0][held[1]], downstream = next[0][next[1]];
    let downstreamCalls = 0;
    held[0][held[1]] = async (...args) => { const result = await save(...args); entered(); await gate; return result; };
    next[0][next[1]] = async (...args) => { downstreamCalls++; return downstream(...args); };
    const task = a.EntityCanonicalNameMigration.saveMigratedState([], { char: f.char, chat: f.chat, scopeKey: f.scope, persist: false });
    await started;
    if (change === 'reset') a.MemoryState.reset();
    else a.MemoryState._activeScopeKey = 'replacement-scope';
    a.TimeEngine.resetState({ notes: 'replacement state must survive' });
    const before = JSON.stringify(a.TimeEngine.getState());
    release();
    await assert.rejects(task, /stale|invalidated/i);
    assert.equal(downstreamCalls, 0);
    assert.equal(JSON.stringify(a.TimeEngine.getState()), before);
    assert.equal(f.writes.length, 0);
  });
  await test('current migration lease still serializes its normal manager state', async f => {
    const lore = [];
    const result = await f.api.EntityCanonicalNameMigration.saveMigratedState(lore, { char: f.char, chat: f.chat, scopeKey: f.scope, persist: false });
    assert.equal(result.ok, true);
    assert(lore.some(entry => entry.comment === 'lmai_time_engine'));
  });
  await test('migration never reports a completed save when canonical storage rejects the write', async f => {
    f.runtime.getCharacter = async () => JSON.parse(JSON.stringify(f.char));
    f.runtime.getChatFromIndex = async () => JSON.parse(JSON.stringify(f.chat));
    f.control.mode = 'reject';
    const before = JSON.stringify([...f.store]);
    await assert.rejects(f.api.EntityCanonicalNameMigration.saveMigratedState([], {
      char: f.char, chat: f.chat, scopeKey: f.scope, persist: true
    }), /persist.*failed/i);
    assert.equal(JSON.stringify([...f.store]), before);
  });
  console.log(JSON.stringify({ passed: checks.filter(item => item.ok).length, failed: checks.filter(item => !item.ok).length, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
