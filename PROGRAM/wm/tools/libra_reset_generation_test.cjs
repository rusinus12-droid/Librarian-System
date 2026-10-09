'use strict';
const assert = require('node:assert/strict');
const { load } = require('./libra_management_storage_verified_test.cjs');
const checks = [];
const clone = value => JSON.parse(JSON.stringify(value));
const row = text => ({ key: 'memory', comment: 'lmai_memory', content: text });
async function fixture(mode = 'ok') {
  const f = await load({ artifact: true, mode, extraExports: 'PersonaScopeIdentity,MemoryState,MemoryEngine,buildTurnMaintenanceRecord,resolveChatContextByTarget,getChatRuntimeScopeKey' });
  f.d = f.api.LibraDataStorage;
  f.chat = { id: 'reset-chat', bindedPersona: 'persona-a', localLore: [], message: [{ role: 'user', data: 'preserved host message' }] };
  f.char = { id: 'reset-char', chatPage: 0, chats: [f.chat] };
  f.scope = f.d.scopeKeyFor(f.char, f.chat);
  f.key = f.d.storageKeyFor(f.scope);
  f.store.set(f.key, JSON.stringify({ version: '1.0', scopeKey: f.scope, entries: [row('old memory')], inheritedFrom: 'proven-parent' }));
  const admitted = await f.d.preparePersonaContext(f.char, f.chat);
  assert.equal(admitted.ok, true);
  f.reset = options => f.d.resetVerified(f.scope, { expectedGeneration: 0, isCurrent: async () => true, ...options });
  return f;
}
async function test(name, fn) {
  try { await fn(await fixture()); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, error: error.stack }); process.exitCode = 1; }
}
(async () => {
  await test('verified reset persists an empty envelope and advances the captured generation', async f => {
    const host = JSON.stringify(f.char), result = await f.reset();
    assert.equal(result.ok, true);
    const after = await f.d.readVerified(f.scope);
    assert.equal(after.missing, false);
    assert.equal(after.entries.length, 0);
    assert.equal(after.resetGeneration, 1);
    assert.equal(JSON.stringify(f.char), host);
    assert.equal(f.api.PersonaScopeIdentity.snapshotProof(f.char, f.chat).resetGeneration, 0);
  });
  await test('old general writer cannot overwrite a completed reset; a freshly admitted writer can', async f => {
    assert.equal((await f.reset()).ok, true);
    const empty = f.store.get(f.key), old = await f.d.save(f.char, f.chat, [row('late old result')]);
    assert.equal(old.ok, false);
    assert.equal(old.reason, 'reset_generation_changed');
    assert.equal(f.store.get(f.key), empty);
    const freshChat = clone(f.chat), freshChar = { ...clone(f.char), chats: [freshChat] };
    assert.equal((await f.d.preparePersonaContext(freshChar, freshChat)).resetGeneration, 1);
    assert.equal((await f.d.save(freshChar, freshChat, [row('new generation result')])).ok, true);
    const saved = JSON.parse(f.store.get(f.key));
    assert.equal(saved.resetGeneration, 1);
    assert.equal(saved.inheritedFrom, 'proven-parent');
    assert.equal(saved.entries[0].content, 'new generation result');
  });
  await test('strict old-generation writer is rejected without a compensating overwrite', async f => {
    await f.reset();
    const empty = f.store.get(f.key), result = await f.d.saveVerified(f.scope, [row('stale')], {
      expectedGeneration: 0, isCurrent: async () => true
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'reset_generation_changed');
    assert.equal(f.store.get(f.key), empty);
  });
  await test('re-admitting an old snapshot cannot silently renew its expired reset lease', async f => {
    const proof = f.api.PersonaScopeIdentity.snapshotProof(f.char, f.chat);
    await f.reset();
    const result = await f.d.preparePersonaContext(f.char, f.chat);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'reset_generation_changed');
    assert.equal(f.api.PersonaScopeIdentity.snapshotProof(f.char, f.chat), proof);
  });
  await test('late native inheritance cannot replace a reset tombstone with parent data', async f => {
    const messages = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', data: 'parent ' + i, chatId: 'pm' + i }));
    const parent = { id: 'parent', bindedPersona: 'persona-a', message: messages, localLore: [] };
    f.chat.message = [...clone(messages), { role: 'assistant', data: '{{specialcomment::branchedfrom::parent::Parent::pm5::}}', chatId: 'marker', isComment: true, disabled: true }];
    f.char.chats = [parent, f.chat]; f.char.chatPage = 1;
    f.store.delete(f.key);
    const parentScope = f.d.scopeKeyFor(f.char, parent), parentKey = f.d.storageKeyFor(parentScope);
    f.store.set(parentKey, JSON.stringify({ scopeKey: parentScope, entries: [row('parent memory')] }));
    let release, started, held = false;
    const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
    const get = f.runtime.pluginStorage.getItem;
    f.runtime.pluginStorage.getItem = async key => {
      if (key === parentKey && !held) { held = true; started(); await gate; }
      return get(key);
    };
    const inheritance = f.d.inheritFromBranch(f.char, f.chat, {
      runtimeScopeKey: f.api.getChatRuntimeScopeKey(f.chat, f.char), runtimeChatId: f.chat.id
    });
    await entered;
    assert.equal((await f.reset()).ok, true);
    const empty = f.store.get(f.key);
    release();
    assert.equal((await inheritance).ok, false);
    assert.equal(f.store.get(f.key), empty);
    assert.equal(f.d.getShadowEntries(f.scope).length, 0);
  });
  await test('in-flight write finishes before queued reset; a later queued old writer cannot resurrect data', async f => {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const set = f.runtime.pluginStorage.setItem;
    let held = false;
    f.runtime.pluginStorage.setItem = async (key, value) => {
      if (key === f.key && !held) { held = true; started(); await gate; }
      return set(key, value);
    };
    const first = f.d.save(f.char, f.chat, [row('write already in flight')]);
    await entered;
    const reset = f.reset();
    const late = f.d.save(f.char, f.chat, [row('queued old result')]);
    release();
    assert.equal((await first).ok, true);
    assert.equal((await reset).ok, true);
    assert.equal((await late).ok, false);
    const payload = JSON.parse(f.store.get(f.key));
    assert.equal(payload.entries.length, 0);
    assert.equal(payload.resetGeneration, 1);
    assert.equal(f.d.getShadowEntries(f.scope).length, 0);
  });
  await test('reset preserves a different persona and its host transcript byte for byte', async f => {
    const other = f.scope.replace('persona-a', 'persona-b'), key = f.d.storageKeyFor(other);
    const raw = JSON.stringify({ scopeKey: other, entries: [row('persona B private')] });
    f.store.set(key, raw);
    const host = JSON.stringify(f.char);
    await f.reset();
    assert.equal(f.store.get(key), raw);
    assert.equal(JSON.stringify(f.char), host);
  });
  for (const mode of ['false_after_write', 'throw_after_write', 'undefined_after_write']) {
    await test(`reset trusts exact durable readback despite ${mode}`, async f => {
      f.control.mode = mode;
      assert.equal((await f.reset()).ok, true);
      assert.equal(JSON.parse(f.store.get(f.key)).resetGeneration, 1);
    });
  }
  for (const mode of ['reject', 'readback_error']) {
    await test(`reset never reports verified success after ${mode}`, async f => {
      f.control.mode = mode;
      const result = await f.reset();
      assert.equal(result.ok, false);
      assert.equal(result.verified, false);
      assert.equal(result.uncertain, true);
    });
  }
  await test('malformed persisted reset generation is unavailable rather than generation zero', async f => {
    const payload = JSON.parse(f.store.get(f.key));
    for (const value of ['invalid', null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      payload.resetGeneration = value;
      f.store.set(f.key, JSON.stringify(payload));
      const result = await f.d.readVerified(f.scope);
      assert.equal(result.ok, false, `invalid generation ${JSON.stringify(value)} must not become zero`);
      assert.equal(result.reason, 'canonical_invalid');
    }
  });
  for (const generation of [0, 1]) await test(`maintenance record preserves generation ${generation} through actual target resolution`, async f => {
    await f.reset();
    f.runtime.getCharacterFromIndex = async () => clone(f.char);
    f.runtime.getChatFromIndex = async () => clone(f.chat);
    const record = f.api.buildTurnMaintenanceRecord(f.char, f.chat, { targetContext: {
      characterId: f.char.id, characterIndex: 0, chatId: f.chat.id, chatIndex: 0,
      canonicalScope: f.scope, resetGeneration: generation
    } }, 'synthetic maintenance response', 1, f.api.MemoryEngine.CONFIG);
    assert.equal(record.targetContext.resetGeneration, generation);
    assert.equal(record.targetContext.canonicalScope, f.scope);
    const target = await f.api.resolveChatContextByTarget(record.targetContext);
    assert.equal(target.ok, generation === 1);
    if (!target.ok) assert.equal(target.reason, 'reset_generation_changed');
  });
  console.log(JSON.stringify({ passed: checks.filter(item => item.ok).length, failed: checks.filter(item => !item.ok).length, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
