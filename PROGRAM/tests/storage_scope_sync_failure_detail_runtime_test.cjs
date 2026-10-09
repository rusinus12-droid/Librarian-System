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
    async keys() { return [...map.keys()]; }
  };
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-scope-sync-diagnostics-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const previous = globalThis.risuai;
  const args = { memory_suite_server_mode: '', memory_suite_server_url: baseUrl };
  let failWrites = false;
  const legacy = memoryStore({ 'diag:test:seed': { n: 1, text: 'seed' } });

  try {
    globalThis.risuai = {
      async getArgument(name) { return args[name] || ''; },
      async setArgument(name, value) { args[name] = String(value); return true; },
      async nativeFetch(url, init) {
        if (failWrites && String(init?.method || 'GET').toUpperCase() === 'POST' && String(url).endsWith('/v1/kv/set')) {
          let body = {};
          try { body = JSON.parse(init?.body || '{}'); } catch (_) {}
          if (String(body.key || '').includes('diag:test:seed')) {
            const error = new Error('injected_scope_sync_write_failure');
            error.code = 'INJECTED_WRITE_FAILURE';
            error.retryable = false;
            throw error;
          }
        }
        return await fetch(url, init);
      }
    };
    const createBridge = new Function(`${sdkText}\nreturn createMemorySuiteStorageBridge;`)();
    const bridge = createBridge({
      namespace: 'libra', pluginId: 'libra', pluginVersion: '1.0.98',
      pluginPrefixes: ['diag:test:'], managementButton: false, migrationDelayMs: 100000,
      currentScopeProvider: async () => ({ scopeId: 'diag-scope', scopeKey: 'diag-scope', label: 'Diagnostics Scope' })
    });
    const proxy = bridge.createPluginStorageProxy(legacy);

    failWrites = true;
    let transitionError = null;
    try {
      await bridge.configureConnection({ mode: 'server_only', url: baseUrl });
    } catch (error) {
      transitionError = error;
    }
    assert.ok(transitionError, 'failed seed transition must reject');
    assert.equal(transitionError.code, 'MEMORY_SUITE_SCOPE_SYNC_INCOMPLETE');
    assert.equal(transitionError.modeTransition.requestedMode, 'server_only');
    assert.equal(transitionError.modeTransition.effectiveMode, 'plugin_only');
    assert.equal(await bridge.getMode(), 'plugin_only', 'failed transition retains persisted mode');
    const transitionFailure = transitionError.result.failures.find(row => row.key === 'diag:test:seed');
    assert.ok(transitionFailure, JSON.stringify(transitionError.result));

    for (const field of ['key', 'stage', 'errorCode', 'message', 'operation', 'localBytes', 'remoteBytes', 'retryable']) {
      assert.ok(Object.prototype.hasOwnProperty.call(transitionFailure, field), `transition failure field ${field}`);
    }
    assert.equal(transitionFailure.errorCode, 'INJECTED_WRITE_FAILURE');
    assert.equal(transitionFailure.retryable, false);
    assert.ok(transitionError.result.metrics.remoteReadCount > 0);
    assert.ok(transitionError.result.metrics.remoteReadBytes >= 0);
    assert.ok(transitionError.result.diagnostics.failures.length > 0);

    failWrites = false;
    const configured = await bridge.configureConnection({ mode: 'server_only', url: baseUrl });
    assert.equal(configured.requestedMode, 'server_only');
    assert.equal(configured.effectiveMode, 'server_only');
    assert.equal(configured.to.requestedMode, 'server_only');
    assert.equal(configured.to.effectiveMode, 'server_only');
    assert.equal(await bridge.getMode(), 'server_only');

    await require('./helpers/legacy_mirror_fixture.cjs').seedLegacyMirrorFixture(bridge,legacy);
    // Bypass the mirror proxy so the next background sync reaches the injected write failure.
    await legacy.setItem('diag:test:seed', { n: 3, text: 'local-ahead' });
    failWrites = true;
    const started = await bridge.startSynchronizationJob();
    assert.equal(started.requestedMode, 'mirror');
    assert.equal(started.effectiveMode, 'mirror');
    const failedJob = await bridge.waitForSyncJob(started.jobId, 30000);
    assert.equal(failedJob.status, 'failed', JSON.stringify(failedJob));
    assert.equal(failedJob.requestedMode, 'mirror');
    assert.equal(failedJob.effectiveMode, 'mirror', 'failed manual sync retains current effective mode');
    assert.equal(await bridge.getMode(), 'mirror');
    const jobFailure = failedJob.result.failures.find(row => row.key === 'diag:test:seed');
    assert.ok(jobFailure, JSON.stringify(failedJob.result));
    assert.equal(jobFailure.errorCode, 'INJECTED_WRITE_FAILURE');
    assert.equal(jobFailure.operation, 'remote_write');
    assert.equal(jobFailure.retryable, false);
    assert.ok(failedJob.result.metrics.remoteReadCount > 0);
    assert.ok(failedJob.result.metrics.remoteWriteCount > 0);
    assert.ok(failedJob.result.diagnostics.failures.length > 0);

    await bridge.dispose();
    process.stdout.write(JSON.stringify({
      test: 'storage_scope_sync_failure_detail_runtime',
      result: 'passed',
      transition: { requestedMode: transitionError.modeTransition.requestedMode, effectiveMode: transitionError.modeTransition.effectiveMode },
      failedJob: { requestedMode: failedJob.requestedMode, effectiveMode: failedJob.effectiveMode, failure: jobFailure },
      modeAfterFailure: await bridge.getMode().catch(() => 'disposed')
    }) + '\n');
  } finally {
    if (previous === undefined) delete globalThis.risuai; else globalThis.risuai = previous;
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
