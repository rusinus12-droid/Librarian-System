'use strict';

const assert = require('node:assert/strict');
const { before, after, beforeEach, afterEach, test } = require('node:test');
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');

// Run the actual plugin and its Storage bridge. Only expose existing functions;
// storage faults are injected at the host boundary, never into the code under test.
const expose = source => source.replace('      getLiveSyncCaptureState:', `
      auditDurable: {
        readStoredResultVault, writeStoredResultVault,
        readWorldBlueprintVault, writeWorldBlueprintVault,
        readVisualAssetPresetStore, writeVisualAssetPresetStore, saveVisualAssetPreset,
        readPersonaVisualAssetStore, writePersonaVisualAssetStore, upsertPersonaVisualAsset,
        readPersonaProofStore, writePersonaProof,
        readPersonaVisualAssetBackup, writePersonaVisualAssetBackup,
        readVisualAssetBackupManifest, visualAssetBackupManifestKey, visualAssetBackupChunkKey,
        visualAssetBackupIdForKey,
        importPersonaVisualAssetImage,
        resetCaches: () => { cachedPersonaVisualAssetStoreEmpty = null; cachedPersonaProofStore = null; preservedVisualAssetPresetStore = null; },
        presetCache: () => preservedVisualAssetPresetStore,
        seedPresetCache: value => { preservedVisualAssetPresetStore = value; }
      },
      getLiveSyncCaptureState:`);

let fixture, api, host, original;
const stores = [
  { name: 'result vault', key: 'dynamicPersonaLorebookGeneratorResultVault', read: 'readStoredResultVault', write: 'writeStoredResultVault', old: { version: 1, items: [{ id: 'old-result', personaPrompt: 'Preserve me' }] }, next: [{ id: 'new-result', personaPrompt: 'New result' }] },
  { name: 'world blueprint', key: 'liaPersonaLinkerWorldBlueprintVaultV1', read: 'readWorldBlueprintVault', write: 'writeWorldBlueprintVault', old: { version: 1, items: [] }, next: [{ key: 'new-world', blueprint: { summary: 'New world' } }] },
  { name: 'visual presets', key: 'liaPersonaVisualAssetPresetStoreV1', read: 'readVisualAssetPresetStore', write: 'writeVisualAssetPresetStore', old: { version: 1, items: [{ id: 'old-preset', name: 'Preserve me', emotionText: 'neutral' }] }, next: { items: [{ id: 'new-preset', name: 'New preset', emotionText: 'neutral' }] } },
  { name: 'visual assets', key: 'liaPersonaVisualAssetStoreV1', read: 'readPersonaVisualAssetStore', write: 'writePersonaVisualAssetStore', old: { version: 1, sets: { old: { personaKey: 'old', images: { neutral: { emotion: 'neutral', assetPath: 'asset://old' } } } } }, next: { sets: {} } }
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

test('preset save rereads durable data instead of overwriting from stale GUI cache', async () => {
  const key = 'liaPersonaVisualAssetPresetStoreV1';
  api.seedPresetCache({ version: 1, items: [] });
  await api.saveVisualAssetPreset('Fresh');
  const saved = JSON.parse(fixture.values.get(key));
  assert(saved.items.some(item => item.id === 'old-preset'), 'prior preset survives');
  assert(saved.items.some(item => item.name === 'Fresh'));
});

test('asset upsert aborts on read failure and preserves all prior assets', async () => {
  const key = 'liaPersonaVisualAssetStoreV1';
  const before = fixture.values.get(key);
  host.getItem = async requested => { if (requested === key) throw new Error('asset_read_failure'); return original.getItem(requested); };
  await assert.rejects(() => api.upsertPersonaVisualAsset({ personaKey: 'new', personaName: 'New' }, { emotion: 'neutral', assetPath: 'asset://new' }), /asset_read_failure/);
  assert.equal(fixture.values.get(key), before);
});

test('an earlier empty asset cache cannot erase assets added by another writer', async () => {
  const key = 'liaPersonaVisualAssetStoreV1';
  fixture.values.delete(key);
  await api.readPersonaVisualAssetStore();
  fixture.values.set(key, JSON.stringify(stores.find(store => store.key === key).old));
  await api.upsertPersonaVisualAsset({ personaKey: 'new', personaName: 'New' }, { emotion: 'neutral', assetPath: 'asset://new' });
  assert(JSON.parse(fixture.values.get(key)).sets.old, 'durable old asset set survives');
});

test('proof read failure does not replace the existing proof collection', async () => {
  const key = 'liaPersonaRequestProofV1';
  const before = JSON.stringify({ version: 1, proofs: { 'old-scope': { scopeKey: 'old-scope', status: 'preserved' } } });
  fixture.values.set(key, before);
  host.getItem = async requested => { if (requested === key) throw new Error('proof_read_failure'); return original.getItem(requested); };
  await assert.rejects(() => api.writePersonaProof({ scopeKey: 'new-scope', status: 'ready' }), /proof_read_failure/);
  assert.equal(fixture.values.get(key), before);
});

test('successful durable writes are read back and survive a plugin restart', async () => {
  for (const store of stores) await api[store.write](store.next);
  await api.writePersonaVisualAssetBackup(backupId, oldBytes);
  const snapshot = structuredClone({ values: [...fixture.values], personas: fixture.db.personas, selectedPersona: fixture.db.selectedPersona, chat: fixture.liveChat });
  const restarted = await createFixture('official', { snapshot, transformSource: expose });
  try {
    for (const store of stores) {
      const reloaded = await restarted.runtime.auditDurable[store.read](true);
      assert.equal(JSON.stringify(reloaded), JSON.stringify(await api[store.read](true)), store.name);
    }
    assert.deepEqual(Array.from((await restarted.runtime.auditDurable.readPersonaVisualAssetBackup(backupId)).bytes), Array.from(oldBytes));
  } finally { await restarted.dispose(); }
});

test('backup dropped manifest write rolls back verified previous bytes', async () => {
  await withBackupSavedAt(async advanceSavedAt => {
    await api.writePersonaVisualAssetBackup(backupId, oldBytes);
    const manifestKey = api.visualAssetBackupManifestKey(backupId);
    const chunkKey = api.visualAssetBackupChunkKey(backupId, 0);
    const before = [fixture.values.get(manifestKey), fixture.values.get(chunkKey)];
    const intendedManifest = JSON.stringify({ ...JSON.parse(before[0]), savedAt: advanceSavedAt() });
    assert.notEqual(intendedManifest, before[0], 'dropped manifest must differ from the already durable value');
    let attemptedManifest;
    host.setItem = async (key, value) => {
      if (key === manifestKey) { attemptedManifest = value; return true; }
      return original.setItem(key, value);
    };
    await assert.rejects(() => api.writePersonaVisualAssetBackup(backupId, newBytes), /readback|mismatch|failed/i);
    assert.equal(attemptedManifest, intendedManifest, 'fault drops the intended distinct manifest');
    assert.deepEqual([fixture.values.get(manifestKey), fixture.values.get(chunkKey)], before);
    assert.deepEqual(Array.from((await api.readPersonaVisualAssetBackup(backupId)).bytes), Array.from(oldBytes));
  });
});

test('backup identical desired manifest succeeds with verified new chunk bytes', async () => {
  await withBackupSavedAt(async () => {
    await api.writePersonaVisualAssetBackup(backupId, oldBytes);
    const manifestKey = api.visualAssetBackupManifestKey(backupId);
    const chunkKey = api.visualAssetBackupChunkKey(backupId, 0);
    const before = [fixture.values.get(manifestKey), fixture.values.get(chunkKey)];
    let attemptedManifest;
    host.setItem = async (key, value) => {
      if (key === manifestKey) { attemptedManifest = value; return true; }
      return original.setItem(key, value);
    };
    const result = await api.writePersonaVisualAssetBackup(backupId, newBytes);
    assert.equal(attemptedManifest, before[0], 'desired manifest is already durable byte-for-byte');
    assert.equal(fixture.values.get(manifestKey), attemptedManifest);
    assert.notEqual(fixture.values.get(chunkKey), before[1]);
    assert.equal(fixture.values.get(chunkKey), Buffer.from(newBytes).toString('base64'));
    assert.equal(result.bytes, newBytes.length);
    assert.deepEqual(Array.from((await api.readPersonaVisualAssetBackup(backupId)).bytes), Array.from(newBytes));
  });
});

test('backup read failure occurs before any chunk is overwritten', async () => {
  await api.writePersonaVisualAssetBackup(backupId, oldBytes);
  const chunkKey = api.visualAssetBackupChunkKey(backupId, 0);
  const before = fixture.values.get(chunkKey);
  let writes = 0;
  host.getItem = async key => { if (key === chunkKey) throw new Error('backup_snapshot_unreadable'); return original.getItem(key); };
  host.setItem = async (key, value) => { if (String(key).includes(backupId)) writes++; return original.setItem(key, value); };
  await assert.rejects(() => api.writePersonaVisualAssetBackup(backupId, newBytes), /backup_snapshot_unreadable/);
  assert.equal(writes, 0);
  assert.equal(fixture.values.get(chunkKey), before);
});

test('backup manifest changes during snapshot abort before any write', async () => {
  await api.writePersonaVisualAssetBackup(backupId, oldBytes);
  const manifestKey = api.visualAssetBackupManifestKey(backupId);
  const before = fixture.values.get(manifestKey);
  const newer = JSON.stringify({ ...JSON.parse(before), savedAt: 'newer-writer' });
  let reads = 0, writes = 0;
  host.getItem = async key => {
    const value = await original.getItem(key);
    if (key === manifestKey && ++reads === 1) fixture.values.set(key, newer);
    return value;
  };
  host.setItem = async (key, value) => { if (String(key).includes(backupId)) writes++; return original.setItem(key, value); };
  await assert.rejects(() => api.writePersonaVisualAssetBackup(backupId, newBytes), /SNAPSHOT_CHANGED|snapshot_changed/);
  assert.equal(writes, 0);
  assert.equal(fixture.values.get(manifestKey), newer);
});

test('backup rollback never overwrites a newer external chunk value', async () => {
  await api.writePersonaVisualAssetBackup(backupId, oldBytes);
  const manifestKey = api.visualAssetBackupManifestKey(backupId);
  const chunkKey = api.visualAssetBackupChunkKey(backupId, 0);
  const externalValue = Buffer.from('newer-external-writer').toString('base64');
  host.setItem = async (key, value) => {
    if (key === manifestKey) { fixture.values.set(chunkKey, externalValue); throw new Error('manifest_write_failed'); }
    return original.setItem(key, value);
  };
  await assert.rejects(() => api.writePersonaVisualAssetBackup(backupId, newBytes), error => error.code === 'LIA_ASSET_BACKUP_ROLLBACK_INCOMPLETE');
  assert.equal(fixture.values.get(chunkKey), externalValue);
});

test('backup restored bytes must match declared manifest lengths', async () => {
  await api.writePersonaVisualAssetBackup(backupId, oldBytes);
  fixture.values.set(api.visualAssetBackupChunkKey(backupId, 0), Buffer.from(newBytes.slice(0, 8)).toString('base64'));
  await assert.rejects(() => api.readPersonaVisualAssetBackup(backupId), /size|length|mismatch|손상/i);
});

test('new backup failure removes newly written chunks after verified rollback', async () => {
  const manifestKey = api.visualAssetBackupManifestKey(backupId);
  host.setItem = async (key, value) => { if (key === manifestKey) throw new Error('new_manifest_failed'); return original.setItem(key, value); };
  await assert.rejects(() => api.writePersonaVisualAssetBackup(backupId, newBytes), /new_manifest_failed/);
  assert.equal(fixture.values.has(api.visualAssetBackupChunkKey(backupId, 0)), false);
  assert.equal(fixture.values.has(manifestKey), false);
});

test('backup rollback readback failure is reported as incomplete', async () => {
  await api.writePersonaVisualAssetBackup(backupId, oldBytes);
  const manifestKey = api.visualAssetBackupManifestKey(backupId);
  const chunkKey = api.visualAssetBackupChunkKey(backupId, 0);
  const oldValue = fixture.values.get(chunkKey);
  host.setItem = async (key, value) => {
    if (key === manifestKey) throw new Error('manifest_failed');
    if (key === chunkKey && value === oldValue) return true;
    return original.setItem(key, value);
  };
  await assert.rejects(() => api.writePersonaVisualAssetBackup(backupId, newBytes), error => error.code === 'LIA_ASSET_BACKUP_ROLLBACK_INCOMPLETE');
  assert.notEqual(fixture.values.get(chunkKey), oldValue);
});

test('local backup writers and readers are serialized through manifest publication', async () => {
  const manifestKey = api.visualAssetBackupManifestKey(backupId);
  let enter, release, held = false, secondFinished = false, readerFinished = false;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  host.setItem = async (key, value) => {
    if (key === manifestKey && !held) { held = true; enter(); await gate; }
    return original.setItem(key, value);
  };
  const first = api.writePersonaVisualAssetBackup(backupId, oldBytes);
  await entered;
  const second = api.writePersonaVisualAssetBackup(backupId, newBytes).then(value => { secondFinished = true; return value; });
  const reader = api.readPersonaVisualAssetBackup(backupId).then(value => { readerFinished = true; return value; });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(secondFinished, false);
    assert.equal(readerFinished, false);
  } finally { release(); }
  await Promise.all([first, second]);
  assert.deepEqual(Array.from((await reader).bytes), Array.from(newBytes));
});

test('manual asset import cannot record a failed backup as present', async () => {
  let nativeBytes;
  fixture.api.saveAsset = async bytes => { nativeBytes = new Uint8Array(bytes); return 'asset://uploaded'; };
  fixture.api.readImage = async key => { assert.equal(key, 'asset://uploaded'); return new Uint8Array(nativeBytes); };
  const key = 'liaPersonaVisualAssetStoreV1';
  const before = fixture.values.get(key);
  host.setItem = async (requested, value) => {
    if (String(requested).startsWith(backupPrefix)) throw new Error('backup_unavailable');
    return original.setItem(requested, value);
  };
  await assert.rejects(() => api.importPersonaVisualAssetImage({ personaKey: 'new', personaName: 'New', assetPrefix: 'new' }, 'neutral', newBytes), /backup_unavailable/);
  assert.equal(fixture.values.get(key), before);
});

test('failed asset metadata publication preserves the prior referenced backup byte-for-byte', async () => {
  let nativeBytes;
  fixture.api.saveAsset = async bytes => { nativeBytes = new Uint8Array(bytes); return 'asset://new-upload'; };
  fixture.api.readImage = async key => { assert.equal(key, 'asset://new-upload'); return new Uint8Array(nativeBytes); };
  const target = { personaKey: 'old', personaName: 'Old', assetPrefix: 'old' };
  const priorId = api.visualAssetBackupIdForKey(target.personaKey, 'neutral');
  await api.writePersonaVisualAssetBackup(priorId, oldBytes);
  const key = 'liaPersonaVisualAssetStoreV1';
  const store = JSON.parse(fixture.values.get(key));
  store.sets.old.images.neutral.backupId = priorId;
  store.sets.old.images.neutral.backupBytes = oldBytes.length;
  fixture.values.set(key, JSON.stringify(store));
  const oldMetadata = fixture.values.get(key);
  const oldBackup = [...fixture.values].filter(([entry]) => entry.includes(priorId));
  host.setItem = async (requested, value) => requested === key ? true : original.setItem(requested, value);
  await assert.rejects(() => api.importPersonaVisualAssetImage(target, 'neutral', newBytes), /readback|mismatch/);
  assert.equal(fixture.values.get(key), oldMetadata);
  for (const [entry, value] of oldBackup) assert.equal(fixture.values.get(entry), value, entry);
  assert.deepEqual(Array.from((await api.readPersonaVisualAssetBackup(priorId)).bytes), Array.from(oldBytes));
});
