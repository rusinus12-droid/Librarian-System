'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');

function memoryStore(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    async getItem(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    async setItem(key, value) { map.set(String(key), value); return true; },
    async removeItem(key) { map.delete(String(key)); return true; },
    async keys() { return Array.from(map.keys()); }
  };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-modes-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const previous = globalThis.risuai;
  const args = { memory_suite_server_mode: '', memory_suite_server_url: baseUrl };
  const scopeA = { scopeId: 'scope-a', scopeKey: 'scope-a', label: 'Scope A', aliases: ['a'] };
  const scopeB = { scopeId: 'scope-b', scopeKey: 'scope-b', label: 'Scope B', aliases: ['b'] };
  let currentScope = scopeA;
  const remoteKey = key => key;
  try {
    globalThis.risuai = {
      async getArgument(name) { return args[name] || ''; },
      async setArgument(name, value) { args[name] = String(value); return true; },
      async nativeFetch(url, init) { return await fetch(url, init); }
    };
    const sdkText = fs.readFileSync(path.join(__dirname, '..', 'sdk', 'MemorySuiteStorageClient.source.js'), 'utf8');
    const createBridge = new Function(`${sdkText}\nreturn createMemorySuiteStorageBridge;`)();
    const legacy = memoryStore({
      'scope:a:key:seed': { scope: 'a', n: 1 },
      'scope:b:key:seed': { scope: 'b', n: 2 },
      'global:settings': { local: true },
      'suite:secret': 'stay-local'
    });
    const bridge = createBridge({
      namespace: 'libra', pluginId: 'libra', pluginVersion: '1.0.98',
      pluginPrefixes: ['scope:'], excludedKeys: ['suite:secret'], managementButton: false,
      migrationDelayMs: 100000,
      currentScopeProvider: async () => currentScope,
      resolveKeyScope: async ({ key }) => {
        if (key.startsWith('scope:a:')) return { kind: 'scope', ...scopeA };
        if (key.startsWith('scope:b:')) return { kind: 'scope', ...scopeB };
        return { kind: 'global' };
      }
    });
    const proxy = bridge.createPluginStorageProxy(legacy);

    // Every new scope defaults independently to plugin-only. The legacy ARG is reset.
    assert.equal(await bridge.getMode(), 'plugin_only');
    assert.equal(args.memory_suite_server_mode, 'plugin_only');
    currentScope = scopeB;
    assert.equal(await bridge.getMode(), 'plugin_only');
    currentScope = scopeA;

    // Scope A enters mirror; scope B remains local-only and is not uploaded.
    const mirrorA = await require('./helpers/legacy_mirror_fixture.cjs').seedLegacyMirrorFixture(bridge,legacy);
    assert.equal(mirrorA.to, 'mirror');
    assert.equal(args.memory_suite_server_mode, 'plugin_only', 'ARG is only a legacy import slot');
    await proxy.setItem('scope:a:key:mirror', { both: true });
    assert.deepEqual(legacy.map.get('scope:a:key:mirror'), { both: true });
    const conn = await bridge.bootstrap();
    const remoteA = await bridge.serverGet('plugin', remoteKey('scope:a:key:mirror', scopeA));
    assert.equal(remoteA.exists, true);
    assert.deepEqual(remoteA.value, { both: true });
    const remoteBSeedBefore = await bridge.serverGet('plugin', remoteKey('scope:b:key:seed', scopeB));
    assert.equal(remoteBSeedBefore.exists, false, 'another scope must not be migrated');

    currentScope = scopeB;
    assert.equal(await bridge.getMode(), 'plugin_only');
    await proxy.setItem('scope:b:key:local', { localOnly: true });
    assert.equal((await bridge.serverGet('plugin', remoteKey('scope:b:key:local', scopeB))).exists, false);

    // Scope B can independently become server-only; scope A remains mirror.
    const serverB = await bridge.setMode('server_only');
    assert.equal(serverB.to, 'server_only');
    await proxy.setItem('scope:b:key:server', 42);
    assert.equal(legacy.map.has('scope:b:key:server'), false);
    assert.equal((await bridge.serverGet('plugin', remoteKey('scope:b:key:server', scopeB))).value, 42);
    currentScope = scopeA;
    assert.equal(await bridge.getMode(), 'mirror');

    // Mirror survives a temporary outage using its local copy.
    await bridge.setServerUrl('http://127.0.0.1:65534');
    await proxy.setItem('scope:a:key:offline-write', { localSurvives: true });
    assert.deepEqual(legacy.map.get('scope:a:key:offline-write'), { localSurvives: true });
    await bridge.setServerUrl(baseUrl);
    assert.deepEqual(await proxy.getItem('scope:a:key:offline-write'), { localSurvives: true });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual((await bridge.serverGet('plugin', remoteKey('scope:a:key:offline-write', scopeA))).value, { localSurvives: true });

    // Server-only + server offline must fail closed for scope data, while global/local UI data remains accessible.
    currentScope = scopeB;
    await bridge.setServerUrl('http://127.0.0.1:65534');
    await assert.rejects(() => proxy.getItem('scope:b:key:server'), /fetch|server|connection|bootstrap/i);
    assert.deepEqual(await proxy.getItem('global:settings'), { local: true });
    await bridge.setServerUrl(baseUrl);

    // Current-scope pluginStorage deletion changes only Scope A to server-only.
    currentScope = scopeA;
    const deletedA = await bridge.deletePluginStorageAfterServerVerification();
    assert.equal(deletedA.ok, true);
    assert.equal(await bridge.getMode(), 'server_only');
    assert.equal(legacy.map.has('scope:a:key:seed'), false);
    assert.equal(legacy.map.has('scope:a:key:mirror'), false);
    assert.equal(legacy.map.has('scope:b:key:seed'), true, 'Scope B local data must be untouched');
    currentScope = scopeB;
    assert.equal(await bridge.getMode(), 'server_only', 'Scope B retains its own earlier mode');

    // Restore and return Scope A to plugin-only without changing Scope B.
    currentScope = scopeA;
    const restoredA = await bridge.restorePluginStorage();
    assert.equal(restoredA.ok, true);
    assert.deepEqual(legacy.map.get('scope:a:key:seed'), { scope: 'a', n: 1 });
    await bridge.setMode('plugin_only');
    assert.equal(await bridge.getMode(), 'plugin_only');
    currentScope = scopeB;
    assert.equal(await bridge.getMode(), 'server_only');

    // Owner deletion proof applies only to the requested scope.
    currentScope = scopeA;
    await require('./helpers/legacy_mirror_fixture.cjs').seedLegacyMirrorFixture(bridge,legacy);
    await proxy.setItem('scope:a:key:scope-delete', { protectedLocalCopy: true });
    const scopeRemote = await bridge.serverGet('plugin', remoteKey('scope:a:key:scope-delete', scopeA));
    const ownerProof = await bridge.prepareServerScopeDeletion({
      scopeId: scopeA.scopeId,
      scopeLabel: scopeA.label,
      members: [{
        space: 'plugin', key: remoteKey('scope:a:key:scope-delete', scopeA),
        revision: scopeRemote.revision, digest: scopeRemote.digest,
        exists: true, tombstone: false
      }]
    });
    assert.equal(ownerProof.schema, 'memory-suite.server-scope-delete-owner-receipt.v1');
    assert.equal(ownerProof.verified, true);
    assert.equal(ownerProof.modeAfter, 'plugin_only');
    assert.equal(await bridge.getMode(), 'plugin_only');
    assert.deepEqual(legacy.map.get('scope:a:key:scope-delete'), { protectedLocalCopy: true });

    // A server tombstone blocks re-entering mirror and never erases the only local copy.
    const removeId = `libra_remove_scope_test_${Date.now()}`;
    const removedResponse = await fetch(`${baseUrl}/v1/kv/remove`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${conn.token}`,
        'X-Memory-Suite-Plugin': 'libra',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        namespace: 'libra', space: 'plugin', key: remoteKey('scope:a:key:scope-delete', scopeA),
        operationId: removeId, expectedRevision: scopeRemote.revision
      })
    });
    assert.equal(removedResponse.ok, true);
    await legacy.setItem('scope:a:key:atomic-preflight', { mustRemainLocalOnly: true });
    assert.equal((await bridge.serverGet('plugin', 'scope:a:key:atomic-preflight')).exists, false);
    await assert.rejects(() => bridge.setMode('server_only'), /memory_suite_scope_sync_incomplete|memory_suite_sync_incomplete/);
    assert.equal(await bridge.getMode(), 'plugin_only');
    assert.deepEqual(legacy.map.get('scope:a:key:scope-delete'), { protectedLocalCopy: true });
    assert.equal((await bridge.serverGet('plugin', 'scope:a:key:atomic-preflight')).exists, false,
      'a late conflict must be found by the read-only preflight before any earlier/nonconflicting server write');

    // In an established mirror, a server tombstone is authoritative. Manual sync
    // applies it locally and must never resurrect the deleted server record.
    await legacy.removeItem('scope:a:key:scope-delete');
    await require('./helpers/legacy_mirror_fixture.cjs').seedLegacyMirrorFixture(bridge,legacy);
    await proxy.setItem('scope:a:key:manual-tombstone', { mustBeDeleted: true });
    const tombstoneTarget = await bridge.serverGet('plugin', 'scope:a:key:manual-tombstone');
    const manualRemove = await fetch(`${baseUrl}/v1/kv/remove`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${conn.token}`,
        'X-Memory-Suite-Plugin': 'libra',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        namespace: 'libra', space: 'plugin', key: 'scope:a:key:manual-tombstone',
        operationId: `libra_manual_tombstone_${Date.now()}`, expectedRevision: tombstoneTarget.revision
      })
    });
    assert.equal(manualRemove.ok, true);
    const manualSync = await bridge.synchronizeNow();
    assert.equal(manualSync.removedByTombstone, 1);
    assert.equal(legacy.map.has('scope:a:key:manual-tombstone'), false);
    const afterManualSync = await bridge.serverGet('plugin', 'scope:a:key:manual-tombstone');
    assert.equal(afterManualSync.exists, false);
    assert.equal(afterManualSync.tombstone, true, 'manual sync must preserve the server tombstone');

    process.stdout.write('storage_modes_test: PASS\n');
  } finally {
    if (previous === undefined) delete globalThis.risuai; else globalThis.risuai = previous;
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { process.stderr.write(`storage_modes_test: FAIL\n${error.stack || error}\n`); process.exitCode = 1; });
