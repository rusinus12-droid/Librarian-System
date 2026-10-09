'use strict';
const assert = require('node:assert/strict');
const { load } = require('./libra_management_storage_verified_test.cjs');
const checks = [], row = value => ({ key: value, comment: 'lmai_memory', content: value });
async function test(name, fn) {
  try { await fn(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, error: error.stack }); process.exitCode = 1; }
}
async function fixture(mode) {
  const f = await load({ artifact: true, mode });
  f.d = f.api.LibraDataStorage;
  f.chat = { id: 'publication-chat', bindedPersona: 'persona-a', localLore: [row('host only')], message: ['preserved message'] };
  f.char = { id: 'publication-char', chats: [f.chat] };
  f.scope = f.d.scopeKeyFor(f.char, f.chat); f.key = f.d.storageKeyFor(f.scope);
  return f;
}
(async () => {
  for (const mode of ['reject', 'ack_without_write', 'mismatch', 'readback_error']) await test(`${mode} preserves the pre-write shadow and host bytes`, async () => {
    const f = await fixture(mode), before = JSON.stringify(f.char);
    const result = await f.d.save(f.char, f.chat, [row('new canonical')]);
    assert.equal(result.ok, false);
    assert.equal(f.d.getShadowEntries(f.scope).length, 0);
    assert.equal(f.d.isHydrated(f.scope), false);
    assert.equal(JSON.stringify(f.char), before);
    assert.equal(f.writes.length, 1, 'no compensating overwrite');
  });
  for (const mode of ['ok', 'false_after_write', 'throw_after_write']) await test(`${mode} publishes only after exact durable readback`, async () => {
    const f = await fixture(mode), input = [row('host only')];
    const result = await f.d.save(f.char, f.chat, input);
    assert.equal(result.ok, true);
    assert.equal(result.verified, true);
    assert.equal(f.d.getShadowEntries(f.scope)[0].content, 'host only');
    assert.equal(JSON.parse(f.store.get(f.key)).entries[0].content, 'host only');
    assert.equal(f.chat.localLore.length, 0);
  });
  await test('a failed replacement retains an existing shadow and can retry', async () => {
    const f = await fixture('ok'); await f.d.save(f.char, f.chat, [row('prior')]);
    f.control.mode = 'reject'; assert.equal((await f.d.save(f.char, f.chat, [row('next')])).ok, false);
    assert.equal(f.d.getShadowEntries(f.scope)[0].content, 'prior');
    assert.equal(JSON.parse(f.store.get(f.key)).entries[0].content, 'prior');
    f.control.mode = 'ok'; assert.equal((await f.d.save(f.char, f.chat, [row('next')])).ok, true);
    assert.equal(f.d.getShadowEntries(f.scope)[0].content, 'next');
  });
  await test('host lore added during storage await remains byte-identical', async () => {
    const f = await fixture('ok'), set = f.runtime.pluginStorage.setItem;
    let concurrent;
    f.runtime.pluginStorage.setItem = async (...args) => {
      const result = await set(...args); f.chat.localLore.push(row('concurrent managed row'));
      f.chat.message.push('concurrent message'); concurrent = JSON.stringify(f.char); return result;
    };
    assert.equal((await f.d.save(f.char, f.chat, [row('host only')])).ok, true);
    assert.equal(JSON.stringify(f.char), concurrent);
  });
  await test('successful save preserves an original managed host row absent from its payload', async () => {
    const f = await fixture('ok');
    const original = JSON.stringify(f.chat.localLore);
    assert.equal((await f.d.save(f.char, f.chat, [row('different canonical row')])).ok, true);
    assert.equal(JSON.stringify(f.chat.localLore), original);
    assert.equal(JSON.parse(f.store.get(f.key)).entries[0].content, 'different canonical row');
  });
  await test('persona replacement during storage await cannot publish or clean its host state', async () => {
    const f = await fixture('ok'), set = f.runtime.pluginStorage.setItem;
    f.runtime.pluginStorage.setItem = async (...args) => { const result = await set(...args); f.chat.bindedPersona = 'persona-b'; return result; };
    const result = await f.d.save(f.char, f.chat, [row('old persona')]);
    assert.equal(result.ok, false); assert.equal(result.reason, 'stale_identity');
    assert.equal(f.d.getShadowEntries(f.scope).length, 0);
    assert.equal(f.chat.localLore[0].content, 'host only');
    assert.equal(JSON.parse(f.store.get(f.key)).entries[0].content, 'old persona', 'old captured durable write is not compensated');
  });
  console.log(JSON.stringify({ passed: checks.filter(x => x.ok).length, failed: checks.filter(x => !x.ok).length, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
