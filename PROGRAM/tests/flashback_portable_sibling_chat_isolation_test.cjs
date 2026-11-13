'use strict';
// A chat's JSON backup and same-chat restore must never reach another chat of the same bot.
// The character ID is shared by every chat of one bot, so it cannot prove ownership; the
// global scope registry lists every chat, so it is never chat data. A file written before
// ownership was exact may still carry both, and restoring it must leave them untouched.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pair = (prefix, n, user, assistant) => [
  { role: 'user', data: user, chatId: `${prefix}-u${n}` },
  { role: 'assistant', data: assistant, chatId: `${prefix}-a${n}` }
];
const canonicalize = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const sha = value => ({ algorithm: 'SHA-256', digest: crypto.createHash('sha256').update(canonicalize(value)).digest('hex') });
const resign = envelope => {
  for (const record of envelope.records) record.integrity = sha({ key: record.key, value: record.value });
  const unsigned = JSON.parse(JSON.stringify(envelope));
  delete unsigned.integrity;
  envelope.integrity = sha(unsigned);
  return envelope;
};
const REGISTRY_KEY = 'vector_rag_memory:scope_registry:v2';

(async () => {
  const chatB = { id: 'chat-B', chatId: 'chat-B', name: 'Sibling', message: pair('b', 1, 'Rowan guards the north gate tonight.', 'Rowan nods and lights the lantern by the gate.') };
  chatB.messages = chatB.message;
  const chatA = { id: 'chat-A', chatId: 'chat-A', name: 'Current', message: pair('a', 1, 'Mira hides the brass key under the sundial.', 'Mira pockets the key and waits for moonrise.') };
  chatA.messages = chatA.message;
  const f = await createFixture({ characterId: 'same-bot', chat: chatB });
  try {
    const select = chat => { for (const key of Object.keys(f.currentChat)) delete f.currentChat[key]; Object.assign(f.currentChat, chat); };
    const ingest = () => f.api.ingestLiveChatColdStart({ scope: 'current', incremental: false, skipEpisodeRebuild: true, skipGuiRefresh: true, allowHashFallback: true });
    let portable;
    for (let i = 0; i < 300 && !portable; i += 1) { portable = f.context.__FlashbackPortableMemoryBackup; await sleep(20); }
    const idle = async operation => {
      for (let i = 0; i < 120; i += 1) {
        try { return await operation(); } catch (error) {
          if (!/BUSY|manifest_changed/.test(String(error?.code || error?.message))) throw error;
          await sleep(250);
        }
      }
      throw new Error('Flashback stayed busy');
    };
    const physical = async prefix => {
      const keys = (await f.pluginStorage.keys()).filter(key => key.startsWith(prefix)).sort();
      return JSON.stringify(await Promise.all(keys.map(async key => [key, await f.pluginStorage.getItem(key)])));
    };

    await ingest();
    const scopeB = await f.api.resolveCurrentScope(true);
    select(chatA);
    await ingest();
    const scopeA = await f.api.resolveCurrentScope(true);
    await sleep(3000);
    const prefixA = `vector_rag_memory:scope:${scopeA.storageHash}:`;
    const prefixB = `vector_rag_memory:scope:${scopeB.storageHash}:`;

    const envelope = await idle(() => portable.exportCurrentScope());
    const exported = envelope.records.map(record => record.key);
    assert.equal(exported.filter(key => key.startsWith(prefixB)).length, 0, 'a backup of chat A carries nothing of chat B');
    assert.equal(exported.includes(REGISTRY_KEY), false, 'the global scope registry is not chat data');
    const storedA = (await f.pluginStorage.keys()).filter(key => key.startsWith(prefixA));
    assert.ok(storedA.some(key => key.endsWith(':turn_worldline:v1')), 'fixture stores a worldline for chat A');
    for (const key of storedA) assert.ok(exported.includes(key), `chat A storage is exported: ${key}`);
    console.log('PASS backup of chat A is exactly chat A');

    // A file written before ownership was exact: chat B's rows and the registry are inside it.
    const legacy = JSON.parse(JSON.stringify(envelope));
    for (const key of [...(await f.pluginStorage.keys()).filter(key => key.startsWith(prefixB)), REGISTRY_KEY]) {
      legacy.records.push({ key, kind: 'other', mode: 'replace', value: await f.pluginStorage.getItem(key) });
    }
    resign(legacy);
    await portable.validateBackup(legacy);

    // Chat B moves on after the backup.
    select(chatB);
    chatB.message.push(...pair('b', 2, 'Rowan hears hooves on the road.', 'Rowan raises the alarm bell at the north gate.'));
    chatB.messages = chatB.message;
    await ingest();
    await sleep(3000);
    const bRecordsBefore = (await f.api._test.loadScopeRecords(scopeB.scopeKey)).records.length;
    assert.equal(bRecordsBefore, 2);
    const bPhysicalBefore = await physical(prefixB);
    const registryBefore = await f.pluginStorage.getItem(REGISTRY_KEY);

    select(chatA);
    await f.api.resolveCurrentScope(true);
    const restoredLegacy = await idle(() => portable.restoreCurrentScope(legacy));
    assert.equal(restoredLegacy.ok, true);
    assert.ok(restoredLegacy.skippedOutsideChat >= 2, `the other chat and the registry are skipped (${restoredLegacy.skippedOutsideChat})`);
    assert.equal(await physical(prefixB), bPhysicalBefore, 'restoring an old backup of chat A leaves chat B untouched');
    assert.equal(await f.pluginStorage.getItem(REGISTRY_KEY), registryBefore, 'restoring an old backup leaves the registry untouched');
    console.log('PASS old mixed backup restores chat A only');

    const restored = await idle(() => portable.restoreCurrentScope(envelope));
    assert.equal(restored.ok, true);
    assert.equal(restored.skippedOutsideChat, 0);
    assert.equal(await physical(prefixB), bPhysicalBefore, 'restoring chat A leaves chat B untouched');
    select(chatB);
    await f.api.resolveCurrentScope(true);
    assert.equal((await f.api._test.loadScopeRecords(scopeB.scopeKey)).records.length, bRecordsBefore,
      'chat B keeps the memory it made after chat A was backed up');
    console.log('PASS flashback_portable_sibling_chat_isolation_test');
  } finally {
    await f.dispose();
  }
  process.exit(0);
})().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
