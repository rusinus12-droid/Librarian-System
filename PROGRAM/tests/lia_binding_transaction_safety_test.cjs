'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIA_Persona_Linker.js'), 'utf8');
const from = source.indexOf('async function writeSplitLivePersonaStoreRaw');
const to = source.indexOf('async function migrateLegacyLivePersonaStore', from);
assert.ok(from >= 0 && to > from, 'writeSplitLivePersonaStoreRaw source boundary');
const functionSource = source.slice(from, to);

const clone = value => JSON.parse(JSON.stringify(value));
const normalizeStore = value => ({ version: 6, bindings: clone(value?.bindings || {}) });
const normalizeBinding = value => value?.scopeKey ? clone(value) : null;
const shardKey = scopeKey => `shard:${scopeKey}`;
const hashText = value => `digest:${String(value)}`;

const makeStorage = initial => {
  const values = new Map(Object.entries(initial || {}));
  return {
    values,
    async getItem(key) { return values.has(key) ? values.get(key) : null; },
    async setItem(key, value) { values.set(key, value); return true; },
    async removeItem(key) { values.delete(key); return true; }
  };
};

const build = ({ writeIndex, readIndex, removeChecked }) => new Function(
  'normalizeLivePersonaStore', 'readLivePersonaIndex', 'normalizeLivePersonaBinding', 'livePersonaScopeStorageKey',
  'hashText', 'setPluginStorageItemChecked', 'removePluginStorageItemChecked', 'writeLivePersonaIndex',
  `let cachedLivePersonaStore = null; let cachedLivePersonaStoreComplete = false; ${functionSource}\nreturn writeSplitLivePersonaStoreRaw;`
)(
  normalizeStore, readIndex, normalizeBinding, shardKey, hashText,
  async (storage, key, value) => { await storage.setItem(key, value); return true; },
  removeChecked || (async (storage, key, _operation, options = {}) => {
    const before = await storage.getItem(key);
    if (options.missingOk && before == null) return true;
    await storage.removeItem(key);
    assert.equal(await storage.getItem(key), null);
    return true;
  }),
  writeIndex
);

(async () => {
  const oldBinding = { scopeKey: 'scope-a', livePersonaId: 'live-a', updatedAt: 'old', value: 'old' };
  const newBinding = { ...oldBinding, updatedAt: 'new', value: 'new' };
  const key = shardKey('scope-a');
  const oldSerialized = JSON.stringify(oldBinding);
  const oldIndex = { entries: { 'scope-a': { storageKey: key, digest: hashText(oldSerialized), livePersonaId: 'live-a', updatedAt: 'old' } } };
  const storage = makeStorage({ [key]: oldSerialized });
  const write = build({
    writeIndex: async () => { throw new Error('simulated_index_failure'); },
    readIndex: async () => clone(oldIndex)
  });
  await assert.rejects(
    write(storage, { bindings: { 'scope-a': newBinding } }, clone(oldIndex)),
    /simulated_index_failure/
  );
  assert.equal(await storage.getItem(key), oldSerialized, 'failed index commit restores the previous shard bytes');

  const newStorage = makeStorage({});
  const emptyIndex = { entries: {} };
  const writeNew = build({
    writeIndex: async () => { throw new Error('new_index_failure'); },
    readIndex: async () => clone(emptyIndex)
  });
  await assert.rejects(
    writeNew(newStorage, { bindings: { 'scope-new': { scopeKey: 'scope-new', livePersonaId: 'live-new', updatedAt: 'new' } } }, clone(emptyIndex)),
    /new_index_failure/
  );
  assert.equal(await newStorage.getItem(shardKey('scope-new')), null, 'a newly created shard is removed when its index cannot commit');

  const brokenStorage = makeStorage({});
  const writeBrokenRollback = build({
    writeIndex: async () => { throw new Error('index_failure'); },
    readIndex: async () => clone(emptyIndex),
    removeChecked: async () => { throw new Error('remove_failure'); }
  });
  await assert.rejects(
    writeBrokenRollback(brokenStorage, { bindings: { 'scope-broken': { scopeKey: 'scope-broken', livePersonaId: 'live-broken' } } }, clone(emptyIndex)),
    error => error?.code === 'LIA_LIVE_PERSONA_BINDING_ROLLBACK_INCOMPLETE'
  );

  process.stdout.write('lia_binding_transaction_safety_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
