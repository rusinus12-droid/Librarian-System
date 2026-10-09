'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { DEFINITIONS, executeOperation } = require('../server/compute/registry.cjs');
const { digestJson } = require('../server/compute/contracts.cjs');

const program = path.resolve(__dirname, '..');
const computeSource = fs.readFileSync(path.join(program, 'sdk', 'MemorySuiteComputeClient.source.js'), 'utf8');
const factories = new Function(`${computeSource}\nreturn { createMemorySuiteComputeBridge };`)();

const memoryStore = () => {
  const values = new Map();
  return {
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() { return [...values.keys()]; }
  };
};
const fileDigest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function main() {
  const tempRoot = path.resolve(os.tmpdir());
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'memory-suite-bridge-server-'));
  assert.equal(path.dirname(dataDir), tempRoot, 'temporary DATA must stay directly inside the OS temp directory');
  const app = createMemorySuiteServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    autoBackup: false,
    computeWorkers: 2
  });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const args = new Map([
    ['memory_suite_server_mode', 'plugin_only'],
    ['memory_suite_server_url', baseUrl]
  ]);
  const api = {
    pluginStorage: memoryStore(),
    async getArgument(name) { return args.get(String(name)) || ''; },
    async setArgument(name, value) { args.set(String(name), String(value)); return true; },
    async nativeFetch(url, init = {}) { return await fetch(url, init); }
  };
  const previousRisuai = globalThis.risuai;
  globalThis.risuai = api;
  let computeBridge = null;
  let localCalls = 0;
  try {
    const definition = DEFINITIONS['flashback.hash-embedding-batch.v1'];
    const binding = { scopeId: 'scope-a', branchId: 'branch-a', revision: 7, sourceDigest: 'source-a' };
    computeBridge = factories.createMemorySuiteComputeBridge({
      namespace: 'flashback',
      pluginId: 'flashback_memory',
      pluginVersion: 'integration-test',
      api,
      operations: {
        [definition.operation]: {
          algorithmFingerprint: definition.fingerprint,
          local: async input => {
            localCalls += 1;
            return executeOperation(definition.operation, input);
          }
        }
      },
      bindingProvider: async () => binding,
      backgroundProbe: false,
      defaultDeadlineMs: 3000,
      localReserveMs: 500,
      probeTimeoutMs: 1200
    });

    const before = Object.fromEntries(Object.entries(app.repositories).map(([name, repository]) => [name, fileDigest(repository.filePath)]));
    const input = { texts: ['hello memory', '기억 회상'], dimensions: 64 };
    const result = await computeBridge.execute({ operation: definition.operation, input, mode: 'prefer_server' });
    assert.equal(result.source, 'server');
    assert.equal(result.algorithmFingerprint, definition.fingerprint);
    assert.equal(result.inputDigest, digestJson(input));
    assert.equal(result.resultDigest, digestJson(result.result));
    assert.equal(result.bindingValidation, 'provider_readback');
    assert.equal(args.get('memory_suite_server_mode'), 'plugin_only', 'Compute succeeds without changing or bootstrapping Storage');
    assert.equal(result.result.vectors.length, 2);
    assert.equal(result.result.vectors[0].length, 64);
    assert.equal(localCalls, 0, 'verified prefer-server result does not run the local kernel');

    const parallel = await Promise.all([0, 1, 2, 3].map(index => computeBridge.execute({
      operation: definition.operation,
      input: { texts: [`parallel-${index}`], dimensions: 64 },
      binding,
      mode: 'prefer_server'
    })));
    assert.ok(parallel.every(item => item.source === 'server'), `parallel bridge calls all complete through the worker pool: ${JSON.stringify(parallel.map(item => ({ source: item.source, fallbackReason: item.fallbackReason || '' })))}`);

    assert.equal(await computeBridge.setMode('shadow'), 'local', 'retired shadow values normalize to local');
    const local = await computeBridge.execute({ operation: definition.operation, input, binding, mode: 'local' });
    assert.equal(local.source, 'local', 'explicit local mode keeps the plugin-local result authoritative');
    assert.equal(localCalls, 1, 'local mode executes the local kernel exactly once');

    const backgroundInput = { texts: ['background-cache'], dimensions: 64 };
    const localBeforeBackground = localCalls;
    const coldBackground = await computeBridge.executeCachedOrLocal({
      operation: definition.operation,
      input: backgroundInput,
      binding,
      lane: 'background',
      mode: 'prefer_server',
      deadlineMs: 3000,
      localReserveMs: 0
    });
    assert.equal(coldBackground.source, 'local', 'cold background cache returns the owner-local result immediately');
    await computeBridge.whenIdle();
    const warmBackground = await computeBridge.executeCachedOrLocal({
      operation: definition.operation,
      input: backgroundInput,
      binding,
      lane: 'background',
      mode: 'prefer_server',
      deadlineMs: 3000,
      localReserveMs: 0
    });
    assert.equal(warmBackground.source, 'server_cache', 'verified async job result is adopted on the matching subsequent snapshot');
    assert.equal(localCalls, localBeforeBackground + 1, 'only the cold cache call uses local CPU');

    const after = Object.fromEntries(Object.entries(app.repositories).map(([name, repository]) => [name, fileDigest(repository.filePath)]));
    assert.deepEqual(after, before, 'bridge compute never mutates canonical namespace databases');
    process.stdout.write('compute_bridge_server_integration_test: PASS\n');
  } finally {
    try { await computeBridge?.dispose?.(); } catch (_) {}
    if (previousRisuai === undefined) delete globalThis.risuai; else globalThis.risuai = previousRisuai;
    await app.close();
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), tempRoot, 'recursive cleanup target remains inside the OS temp directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`compute_bridge_server_integration_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
