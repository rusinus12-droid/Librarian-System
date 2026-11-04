'use strict';

const assert = require('node:assert/strict');
const { before, after, beforeEach, afterEach, test } = require('node:test');
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');

// Run the actual plugin and its Storage bridge. Only expose existing functions;
// storage faults are injected at the host boundary, never into the code under test.
const expose = source => source.replace('      getScopePersonaCatalog:', `
      auditDurable: {
        readStoredResultVault, writeStoredResultVault,
        readWorldBlueprintVault, writeWorldBlueprintVault,
        readPersonaProofStore, writePersonaProof,
        resetCaches: () => { cachedPersonaProofStore = null; },
      },
      getScopePersonaCatalog:`);

let fixture, api, host, original;
const stores = [
  { name: 'result vault', key: 'dynamicPersonaLorebookGeneratorResultVault', read: 'readStoredResultVault', write: 'writeStoredResultVault', old: { version: 1, items: [{ id: 'old-result', personaPrompt: 'Preserve me' }] }, next: [{ id: 'new-result', personaPrompt: 'New result' }] },
  { name: 'world blueprint', key: 'liaPersonaLinkerWorldBlueprintVaultV1', read: 'readWorldBlueprintVault', write: 'writeWorldBlueprintVault', old: { version: 1, items: [] }, next: [{ key: 'new-world', blueprint: { summary: 'New world' } }] },
];
const backupId = 'failure-probe';
const backupPrefix = 'liaPersonaVisualAssetBlobV1::';
const oldBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const newBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 5, 6, 7, 8]);

async function withBackupSavedAt(callback) {
  const previousDate = Object.getOwnPropertyDescriptor(fixture.context, 'Date');
  let savedAt = Date.parse('2026-10-03T14:00:00.000Z');
  // Control backup timestamp construction only; inherited Date.now keeps caller
  // deadlines on the real clock. Restore the VM global at this test boundary.
  fixture.context.Date = class BackupSavedAt extends Date {
    constructor(...args) { super(...(args.length ? args : [savedAt])); }
  };
  try { return await callback(() => new Date(++savedAt).toISOString()); }
  finally {
    if (previousDate) Object.defineProperty(fixture.context, 'Date', previousDate);
    else delete fixture.context.Date;
  }
}

before(async () => {
  fixture = await createFixture('official', { transformSource: expose });
  fixture.context.document = { getElementById: () => null };
  api = fixture.runtime.auditDurable;
  host = fixture.api.pluginStorage;
  original = { getItem: host.getItem, setItem: host.setItem, removeItem: host.removeItem };
});
after(async () => { if (fixture) await fixture.dispose(); });
beforeEach(() => {
  Object.assign(host, original);
  api.resetCaches();
  for (const key of [...fixture.values.keys()]) {
    if (key.startsWith(backupPrefix) || stores.some(store => store.key === key) || key === 'liaPersonaRequestProofV1') fixture.values.delete(key);
  }
  for (const store of stores) fixture.values.set(store.key, JSON.stringify(store.old));
});
afterEach(() => Object.assign(host, original));

for (const store of stores) {
  test(`${store.name}: dropped write cannot report success`, async () => {
    const before = fixture.values.get(store.key);
    host.setItem = async (key, value) => key === store.key ? true : original.setItem(key, value);
    await assert.rejects(() => api[store.write](store.next), /readback|mismatch|failed/i);
    assert.equal(fixture.values.get(store.key), before);
    if (store.name === 'visual presets') assert.equal(api.presetCache(), null, 'unverified value must not enter the UI cache');
  });
  test(`${store.name}: read error aborts read-modify-write`, async () => {
    const before = fixture.values.get(store.key);
    let writes = 0;
    host.getItem = async key => { if (key === store.key) throw new Error('injected_read_failure'); return original.getItem(key); };
    host.setItem = async (key, value) => { if (key === store.key) writes++; return original.setItem(key, value); };
    await assert.rejects(async () => { await api[store.read](true); await api[store.write](store.next); }, /injected_read_failure/);
    assert.equal(writes, 0);
    assert.equal(fixture.values.get(store.key), before);
  });
  test(`${store.name}: malformed JSON is not an empty store`, async () => {
    fixture.values.set(store.key, '{broken');
    await assert.rejects(() => api[store.read](true));
    assert.equal(fixture.values.get(store.key), '{broken');
  });
  test(`${store.name}: wrong JSON shape is not an empty store`, async () => {
    fixture.values.set(store.key, '42');
    await assert.rejects(() => api[store.read](true));
  });
  test(`${store.name}: an existing empty string is corrupt JSON, not absence`, async () => {
    fixture.values.set(store.key, '');
    await assert.rejects(() => api[store.read](true));
    assert.equal(fixture.values.get(store.key), '');
  });
  test(`${store.name}: missing key remains a legitimate empty store`, async () => {
    fixture.values.delete(store.key);
    const value = await api[store.read](true);
    assert(value && typeof value === 'object');
  });
  test(`${store.name}: explicit rejection and missing ACK require durable readback`, async () => {
    for (const acknowledgement of [false, { ok: false }, { success: false }, undefined]) {
      host.setItem = async (key, value) => key === store.key ? acknowledgement : original.setItem(key, value);
      await assert.rejects(() => api[store.write](store.next), /readback|mismatch|failed|rejected/i);
    }
    host.setItem = async (key, value) => { await original.setItem(key, value); return undefined; };
    await api[store.write](store.next);
    assert.notEqual(fixture.values.get(store.key), JSON.stringify(store.old));
  });
  test(`${store.name}: unreadable readback never confirms success`, async () => {
    host.setItem = async (key, value) => {
      await original.setItem(key, value);
      if (key === store.key) host.getItem = async requested => { if (requested === key) throw new Error('readback_unavailable'); return original.getItem(requested); };
      return true;
    };
    await assert.rejects(() => api[store.write](store.next), /readback_unavailable/);
  });
}

test('proof read failure does not replace the existing proof collection', async () => {
  const key = 'liaPersonaRequestProofV1';
  const before = JSON.stringify({ version: 1, proofs: { 'old-scope': { scopeKey: 'old-scope', status: 'preserved' } } });
  fixture.values.set(key, before);
  host.getItem = async requested => { if (requested === key) throw new Error('proof_read_failure'); return original.getItem(requested); };
  await assert.rejects(() => api.writePersonaProof({ scopeKey: 'new-scope', status: 'ready' }), /proof_read_failure/);
  assert.equal(fixture.values.get(key), before);
});

