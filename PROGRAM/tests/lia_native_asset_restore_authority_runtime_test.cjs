'use strict';

// Actual LIA owner functions against a mock native API with physical Temp asset
// files. This establishes host-seam behavior, not installed Risu GUI acceptance.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');
const { createMemorySuiteServer } = require('../server/server.cjs');

const ASSETS = 'liaPersonaVisualAssetStoreV1';
const BLOBS = 'liaPersonaVisualAssetBlobV1::';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const OTHER_PNG = Buffer.from(PNG); OTHER_PNG[OTHER_PNG.length - 1] ^= 1;
const expose = source => source.replace('      getLiveSyncCaptureState:', `
      auditNativeRestore: {
        ensurePersonaVisualAssetAvailable, readPersonaVisualAssetUrl,
        readPersonaVisualAssetStore, writePersonaVisualAssetStore,
        writePersonaVisualAssetBackup, readPersonaVisualAssetBackup,
        bridge: MemorySuiteStorageBridge,
        readLogs: () => readLogStore(true)
      },
      getLiveSyncCaptureState:`);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function launch(baseUrl = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lia-native-asset-authority-'));
  const calls = { saves: 0, reads: 0, readKeys: [], models: 0 };
  const fixture = await createFixture('official', {
    transformSource: expose,
    configureApi(api) {
      if (baseUrl) {
        const localRows = new Map();
        const args = { memory_suite_server_url: baseUrl, memory_suite_server_mode: 'plugin_only', enable_gui: 'false', mode: 'off', live_sync_enabled: 'false' };
        api.getArgument = async key => args[String(key)] ?? '';
        api.getArg = api.getArgument;
        api.setArgument = async (key, value) => { args[String(key)] = String(value); return true; };
        api.safeLocalStorage = {
          async getItem(key) { return localRows.get(String(key)) ?? null; },
          async setItem(key, value) { localRows.set(String(key), value); return true; },
          async removeItem(key) { localRows.delete(String(key)); return true; },
          async keys() { return [...localRows.keys()]; }
        };
        api.getLocalPluginStorage = async () => api.safeLocalStorage;
        api.nativeFetch = async (url, init) => fetch(url, init);
      }
      api.saveAsset = async bytes => {
        calls.saves++;
        const name = `restored-${calls.saves}.png`;
        fs.writeFileSync(path.join(directory, name), Buffer.from(bytes));
        structuredClone(bytes, { transfer: [bytes.buffer] });
        return `assets/${name}`;
      };
      api.readImage = async key => {
        calls.reads++;
        calls.readKeys.push(key);
        assert.match(key, /^(?:missing|restored-\d+)\.png$/);
        return new Uint8Array(fs.readFileSync(path.join(directory, key)));
      };
      for (const name of ['llm', 'requestModel', 'generateImage', 'embed']) api[name] = async () => {
        calls.models++; throw new Error(`unexpected_model_call:${name}`);
      };
    }
  });
  fixture.context.document = { getElementById: () => null };
  const owner = fixture.runtime.auditNativeRestore;
  await owner.writePersonaVisualAssetBackup('original-backup', new Uint8Array(PNG));
  await owner.writePersonaVisualAssetStore({ sets: {
    'persona:authority': { personaKey: 'persona:authority', personaName: 'Authority', images: {
      neutral: { emotion: 'neutral', assetPath: 'assets/missing.png', backupId: 'original-backup', backupBytes: PNG.length }
    } }
  } });
  const entry = (await owner.readPersonaVisualAssetStore()).sets['persona:authority'].images.neutral;
  const rows = () => [...fixture.values].filter(([key]) => key === ASSETS || key.startsWith(BLOBS)).sort(([a], [b]) => a.localeCompare(b));
  return { fixture, owner, directory, calls, entry, rows,
    recover: () => owner.ensurePersonaVisualAssetAvailable(entry, { personaKey: 'persona:authority', emotion: 'neutral' }),
    async close() {
      await fixture.dispose();
      assert.equal(calls.models, 0);
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function withServer(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lia-native-restore-server-'));
  const server = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: directory, autoBackup: false });
  let env;
  try {
    const address = await server.listen();
    env = await launch(`http://127.0.0.1:${address.port}`);
    await env.owner.bridge.setMode('server_only');
    assert.equal(await env.owner.bridge.getMode(), 'server_only');
    await run(env, server);
  } finally {
    if (env) await env.close();
    await server.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('native backup recovery publishes only a physically read-back exact image and preserves detached bytes', async () => {
  const env = await launch();
  try {
    const backupBefore = env.rows().filter(([key]) => key.startsWith(BLOBS));
    const available = await env.recover();
    assert.equal(available.restored, true);
    assert.deepEqual(Buffer.from(available.bytes), PNG);
    assert.ok(env.calls.readKeys.includes(available.entry.assetPath.slice(7)), 'returned native path was physically read back');
    const saved = (await env.owner.readPersonaVisualAssetStore()).sets['persona:authority'].images.neutral;
    assert.equal(saved.assetPath, available.entry.assetPath);
    assert.deepEqual(fs.readFileSync(path.join(env.directory, saved.assetPath.slice(7))), PNG);
    assert.deepEqual(env.rows().filter(([key]) => key.startsWith(BLOBS)), backupBefore);
  } finally { await env.close(); }
});

for (const fault of ['dropped', 'rewritten', 'blank', 'false', 'basename-only']) {
  test(`native backup recovery refuses a ${fault} host save without publishing metadata or success`, async () => {
    const env = await launch();
    try {
      const before = env.rows();
      env.fixture.api.saveAsset = async () => {
        env.calls.saves++;
        if (fault === 'blank') return '';
        if (fault === 'false') return false;
        if (fault === 'rewritten') fs.writeFileSync(path.join(env.directory, 'restored-1.png'), OTHER_PNG);
        if (fault === 'basename-only') {
          fs.writeFileSync(path.join(env.directory, 'restored-1.png'), PNG);
          return 'assets/wrong-folder/restored-1.png';
        }
        return 'assets/restored-1.png';
      };
      await assert.rejects(env.recover, /LIA_ASSET_RECOVERY_(?:WRITE_REJECTED|READBACK_FAILED|READBACK_MISMATCH)/);
      assert.deepEqual(env.rows(), before, 'all canonical metadata and immutable backup bytes remain exact');
      const logs = await env.owner.readLogs();
      assert.equal(logs.debug.filter(row => row.event === 'image_asset_restored_after_update').length, 0);
    } finally { await env.close(); }
  });
}

for (const change of ['new-backup', 'same-backup-new-path', 'same-backup-metadata', 'deleted', 'deleted-with-alias', 'unloaded', 'scope-changed']) {
  test(`native backup recovery rejects a delayed old result after target is ${change}`, async () => {
    const env = await launch();
    const entered = deferred(), release = deferred();
    try {
      const originalSave = env.fixture.api.saveAsset;
      env.fixture.api.saveAsset = async bytes => { entered.resolve(); await release.promise; return originalSave(bytes); };
      const pending = env.recover();
      await entered.promise;
      if (change === 'unloaded') await env.fixture.runtime.dispose();
      else if (change === 'scope-changed') {
        env.fixture.liveChat.id = 'different-chat';
        env.fixture.liveChat.chatId = 'different-chat';
      }
      else {
        const store = await env.owner.readPersonaVisualAssetStore();
        if (change === 'deleted') delete store.sets['persona:authority'];
        else if (change === 'deleted-with-alias') {
          store.sets['persona:other'] = { ...store.sets['persona:authority'], personaKey: 'persona:other' };
          delete store.sets['persona:authority'];
        }
        else if (change === 'same-backup-metadata') store.sets['persona:authority'].images.neutral.assetName = 'new-authoritative-name';
        else {
          store.sets['persona:authority'].images.neutral.assetPath = 'assets/new-authoritative.png';
          if (change === 'new-backup') store.sets['persona:authority'].images.neutral.backupId = 'new-authoritative-backup';
        }
        await env.owner.writePersonaVisualAssetStore(store);
      }
      const changed = env.rows();
      release.resolve();
      await assert.rejects(() => pending, /LIA_ASSET_RECOVERY_STALE/);
      assert.deepEqual(env.rows(), changed, 'late result cannot overwrite or resurrect the current target');
      const logs = await env.owner.readLogs();
      assert.equal(logs.debug.filter(row => row.event === 'image_asset_restored_after_update').length, 0);
    } finally { release.resolve(); await env.close(); }
  });
}

test('a completed real server restore fences a delayed native recovery even when restored entry bytes are identical', async () => {
  await withServer(async (env, server) => {
    const entered = deferred(), release = deferred();
    try {
      const originalSave = env.fixture.api.saveAsset;
      env.fixture.api.saveAsset = async bytes => { entered.resolve(); await release.promise; return originalSave(bytes); };
      const pending = env.recover();
      await entered.promise;
      const restored = await env.owner.bridge.restorePluginStorage();
      assert.equal(restored.ok, true);
      assert.equal(restored.validation.ok, true);
      const afterRestore = env.rows();
      const expectedRaw = afterRestore.find(([key]) => key === ASSETS)[1];
      release.resolve();
      await assert.rejects(() => pending, /LIA_ASSET_RECOVERY_STALE/);
      assert.deepEqual(env.rows(), afterRestore, 'accepted server snapshot remains physically unchanged');
      server.repositories.lia.checkpoint();
      const physical = new DatabaseSync(server.repositories.lia.filePath, { readOnly: true });
      try {
        assert.equal(physical.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        const stored = physical.prepare('SELECT value_json FROM kv WHERE space=? AND key=? AND deleted=0').get('plugin', ASSETS);
        assert.equal(JSON.parse(stored.value_json), expectedRaw, 'independent SQLite readback retains exact authoritative asset JSON');
      } finally { physical.close(); }
    } finally { release.resolve(); }
  });
});

test('a completed real server restore invalidates a warmed native preview cache', async () => {
  await withServer(async env => {
    fs.writeFileSync(path.join(env.directory, 'missing.png'), PNG);
    const first = await env.owner.readPersonaVisualAssetUrl(env.entry.assetPath, 'image/png');
    assert.deepEqual(Buffer.from(first.split(',')[1], 'base64'), PNG);
    fs.writeFileSync(path.join(env.directory, 'missing.png'), OTHER_PNG);
    const restored = await env.owner.bridge.restorePluginStorage();
    assert.equal(restored.ok, true);
    const fresh = await env.owner.readPersonaVisualAssetUrl(env.entry.assetPath, 'image/png');
    assert.deepEqual(Buffer.from(fresh.split(',')[1], 'base64'), OTHER_PNG, 'next preview reads physical host bytes after restore');
  });
});

test('native recovery cannot publish an older metadata read after another writer replaces the target', async () => {
  const env = await launch();
  const entered = deferred(), release = deferred();
  try {
    const originalRead = env.fixture.api.pluginStorage.getItem;
    let hold = true;
    env.fixture.api.pluginStorage.getItem = async key => {
      const value = await originalRead(key);
      if (key === ASSETS && hold) { hold = false; entered.resolve(); await release.promise; }
      return value;
    };
    const pending = env.recover();
    await entered.promise;
    const store = await env.owner.readPersonaVisualAssetStore();
    store.sets['persona:authority'].images.neutral.assetPath = 'assets/new-authoritative.png';
    await env.owner.writePersonaVisualAssetStore(store);
    const changed = env.rows();
    release.resolve();
    await assert.rejects(() => pending, /LIA_ASSET_RECOVERY_STALE/);
    assert.deepEqual(env.rows(), changed, 'older read cannot overwrite the replacement');
  } finally { release.resolve(); await env.close(); }
});

test('identical real server restore during the metadata read invalidates the native completion', async () => {
  await withServer(async env => {
    const entered = deferred(), release = deferred();
    try {
      const originalRead = env.fixture.api.pluginStorage.getItem;
      let hold = true;
      env.fixture.api.pluginStorage.getItem = async key => {
        const value = await originalRead(key);
        if (key === ASSETS && hold) { hold = false; entered.resolve(); await release.promise; }
        return value;
      };
      const pending = env.recover();
      await entered.promise;
      const restored = await env.owner.bridge.restorePluginStorage();
      assert.equal(restored.ok, true);
      const afterRestore = env.rows();
      release.resolve();
      await assert.rejects(() => pending, /LIA_ASSET_RECOVERY_STALE/);
      assert.deepEqual(env.rows(), afterRestore, 'metadata read resumes without changing the completed restore');
    } finally { release.resolve(); }
  });
});

test('after server restore fences old work, explicit plugin_only recovery ignores a rejected old server binding and makes no network request', async () => {
  await withServer(async env => {
    const entered = deferred(), release = deferred();
    try {
      const originalSave = env.fixture.api.saveAsset;
      env.fixture.api.saveAsset = async bytes => { entered.resolve(); await release.promise; return originalSave(bytes); };
      const pending = env.recover();
      await entered.promise;
      assert.equal((await env.owner.bridge.restorePluginStorage()).ok, true);
      release.resolve();
      await assert.rejects(() => pending, /LIA_ASSET_RECOVERY_STALE/);
      env.fixture.api.saveAsset = originalSave;

      // Corrupt one actual server identity envelope at the native transport
      // seam; production bridge validation records reconnect-required state.
      const originalFetch = env.fixture.api.nativeFetch;
      let corruptNext = true;
      env.fixture.api.nativeFetch = async (url, init) => {
        const response = await originalFetch(url, init);
        if (corruptNext && String(url).includes('/v1/kv/get?')) {
          corruptNext = false;
          const payload = await response.json();
          return new Response(JSON.stringify({ ...payload, dataInstanceId: 'rejected-test-identity' }), {
            status: response.status, headers: { 'Content-Type': 'application/json' }
          });
        }
        return response;
      };
      await assert.rejects(() => env.owner.bridge.serverGet('plugin', ASSETS), /MEMORY_SUITE_DATA_INSTANCE_CHANGED/);
      assert.equal(env.owner.bridge.serverBinding().rejected, true, 'actual bridge rejected the mismatched server identity');
      await env.owner.bridge.setMode('plugin_only');
      assert.equal(await env.owner.bridge.getMode(), 'plugin_only');
      assert.equal(env.owner.bridge.serverBinding().rejected, true, 'old server rejection remains recorded');

      let networkCalls = 0;
      env.fixture.api.nativeFetch = async () => { networkCalls++; throw new Error('plugin_only_must_not_request_server'); };
      const recovered = await env.recover();
      assert.equal(recovered.restored, true);
      assert.deepEqual(Buffer.from(recovered.bytes), PNG);
      assert.equal(networkCalls, 0, 'local recovery has no server dependency');
    } finally { release.resolve(); }
  });
});
