'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');

const root = path.resolve(__dirname, '..');
const sdkText = fs.readFileSync(path.join(root, 'sdk', 'MemorySuiteStorageClient.source.js'), 'utf8').trim();

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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-background-progress-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const previous = globalThis.risuai;
  const args = { memory_suite_server_mode: '', memory_suite_server_url: baseUrl };
  try {
    globalThis.risuai = {
      async getArgument(name) { return args[name] || ''; },
      async setArgument(name, value) { args[name] = String(value); return true; },
      async nativeFetch(url, init) { await delay(3); return await fetch(url, init); }
    };
    const createBridge = new Function(`${sdkText}\nreturn createMemorySuiteStorageBridge;`)();
    const entries = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [
      `progress:test:${String(index).padStart(3, '0')}`,
      { index, text: `row-${index}-` + 'x'.repeat(1800 + index * 11) }
    ]));
    const legacy = memoryStore(entries);
    const bridge = createBridge({
      namespace: 'libra', pluginId: 'libra', pluginVersion: '1.0.98',
      pluginPrefixes: ['progress:test:'], managementButton: false, migrationDelayMs: 100000,
      currentScopeProvider: async () => ({ scopeId: 'scope-progress', scopeKey: 'scope-progress', label: 'Progress Scope' })
    });
    bridge.createPluginStorageProxy(legacy);

    const events = [];
    const unsubscribe = bridge.subscribeSyncJob(job => { if (job) events.push(job); });
    const started = await bridge.startConnectionConfigurationJob({ mode: 'server_only', url: baseUrl });
    assert.equal(started.kind, 'connection_config');
    assert.equal(await bridge.getMode(), 'plugin_only', 'old mode remains authoritative while background seed is running');

    const completed = await bridge.waitForSyncJob(started.jobId, 120000);
    assert.equal(completed.status, 'completed');
    assert.equal(await bridge.getMode(), 'server_only');
    assert.ok(completed.totalItems >= 24, 'item total surfaced');
    assert.equal(completed.processedItems, completed.totalItems, 'completed item counter reaches total');
    assert.ok(completed.processedBytes > 0, 'processed byte counter surfaced');
    assert.ok(completed.transferredBytes > 0, 'transfer byte counter surfaced');
    assert.ok(completed.uploaded >= 24, 'initial data uploaded');
    assert.ok(events.some(job => job.phase === 'inventory' || job.phase === 'inventory_complete'), 'inventory phase observed');
    assert.ok(events.some(job => job.phase === 'sync_local'), 'sync phase observed');
    assert.ok(events.some(job => job.phase === 'integrity_after'), 'final integrity phase observed');
    assert.ok(events.some(job => job.status === 'completed'), 'terminal completion observed');

    // Historical mirror recovery still uses the same background progress contract.
    await require('./helpers/legacy_mirror_fixture.cjs').seedLegacyMirrorFixture(bridge,legacy);
    await legacy.setItem('progress:test:new', { text: 'new-local-only-' + 'y'.repeat(4096) });
    const manual = await bridge.startSynchronizationJob();
    const manualDone = await bridge.waitForSyncJob(manual.jobId, 120000);
    assert.equal(manualDone.status, 'completed');
    assert.ok(manualDone.uploaded >= 1, 'manual sync uploads local-ahead data');

    // Server-only restore shares the same job UI/progress path.
    await bridge.configureConnection({ mode: 'server_only', url: baseUrl });
    await legacy.removeItem('progress:test:000');
    const restore = await bridge.startRestoreJob();
    const restoreDone = await bridge.waitForSyncJob(restore.jobId, 120000);
    assert.equal(restoreDone.status, 'completed');
    assert.ok(restoreDone.restored >= 1, 'restore job recovers missing pluginStorage data');
    assert.ok(await legacy.getItem('progress:test:000'), 'restored value readback exists');

    const current = bridge.getSyncJob();
    assert.equal(current.jobId, restore.jobId, 'latest job remains inspectable after completion');
    unsubscribe();
    process.stdout.write('background_sync_progress_test: PASS\n');
  } finally {
    if (previous === undefined) delete globalThis.risuai; else globalThis.risuai = previous;
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`background_sync_progress_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
