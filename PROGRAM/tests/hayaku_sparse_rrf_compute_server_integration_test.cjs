'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { DEFINITIONS, executeOperation } = require('../server/compute/registry.cjs');

const program = path.resolve(__dirname, '..');
const computeSource = fs.readFileSync(path.join(program, 'sdk', 'MemorySuiteComputeClient.source.js'), 'utf8');
const { createMemorySuiteComputeBridge } = new Function(`${computeSource}\nreturn { createMemorySuiteComputeBridge };`)();
// Exact file/WAL presence and bytes are preserved, including absent retired stores.
const { repositoryDigest: fileDigest } = require('./fixtures/compute_product_load_fixture.cjs');

async function main() {
  const tempRoot = path.resolve(os.tmpdir());
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'memory-suite-hayaku-rrf-'));
  assert.equal(path.dirname(dataDir), tempRoot);
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false, computeWorkers: 2 });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const args = new Map([
    ['memory_suite_server_mode', 'plugin_only'],
    ['memory_suite_server_url', baseUrl]
  ]);
  const routes = [];
  const api = {
    async getArgument(name) { return args.get(String(name)) || ''; },
    async setArgument(name, value) { args.set(String(name), String(value)); return true; },
    async nativeFetch(url, init = {}) { routes.push(new URL(String(url)).pathname); return await fetch(url, init); }
  };
  const definition = DEFINITIONS['hayaku.sparse-rrf-fusion.v1'];
  let bridge = null;
  let localCalls = 0;
  let revision = 1;
  try {
    bridge = createMemorySuiteComputeBridge({
      namespace: 'hayaku',
      pluginId: 'hayaku_locator_continuity',
      pluginVersion: '3.0.23-test',
      api,
      backgroundProbe: false,
      defaultDeadlineMs: 3000,
      localReserveMs: 200,
      jobPollIntervalMs: 25,
      operations: {
        [definition.operation]: {
          algorithmFingerprint: definition.fingerprint,
          local: input => { localCalls += 1; return executeOperation(definition.operation, input); }
        }
      }
    });
    const input = {
      schema: 'hayaku.sparse-rrf-fusion.input.v1',
      k: 60,
      blend: 0.12,
      epsilon: 0.001,
      rows: [
        { position: 0, id: '0:alice', score: 0.42, signals: { bm25fSignal: 0.84, identitySignal: 0.75, canonicalExactSignal: 0.31, associationSignal: 0.2, charNgramSignal: 0.5, lexicalCoverageSignal: 0.65, sparsePhraseSignal: 0.4, bm25Signal: 0, entitySignal: 0, canonicalSignal: 0, frameSignal: 0, locatorSignal: 0, phraseSignal: 0 } },
        { position: 1, id: '1:magic', score: 0.5, signals: { bm25fSignal: 0.92, identitySignal: 0.12, canonicalExactSignal: 0.86, associationSignal: 0.3, charNgramSignal: 0.28, lexicalCoverageSignal: 0.71, sparsePhraseSignal: 0.69, bm25Signal: 0, entitySignal: 0, canonicalSignal: 0, frameSignal: 0, locatorSignal: 0, phraseSignal: 0 } }
      ]
    };
    const request = () => ({
      operation: definition.operation,
      input,
      binding: { schema: 'memory-suite.hayaku.sparse-rrf-binding.v1', revision },
      lane: 'interactive',
      mode: 'prefer_server',
      deadlineMs: 3000,
      localReserveMs: 200,
      validateBinding: binding => binding.revision === revision
    });
    for (const name of ['lia','retrace']) for (const suffix of ['', '-wal']) assert.equal(fs.existsSync(app.repositories[name].filePath + suffix), false, 'retired live store must remain absent');
    const before = Object.fromEntries(Object.entries(app.repositories).map(([name, repository]) => [name, fileDigest(repository.filePath)]));
    const direct = await bridge.execute(request());
    assert.equal(direct.source, 'server');
    assert.deepEqual(direct.result, executeOperation(definition.operation, input), 'actual HAYAKU Worker result exactly matches the local kernel');
    assert.equal(localCalls, 0, 'prefer-server delegates the current HAYAKU request instead of duplicating local work');
    const staleRequest = request();
    revision = 2;
    const stale = await bridge.execute(staleRequest);
    assert.equal(stale.source, 'local', 'changed HAYAKU owner binding falls back to the local kernel');
    assert.equal(localCalls, 1);
    for (const name of ['lia','retrace']) for (const suffix of ['', '-wal']) assert.equal(fs.existsSync(app.repositories[name].filePath + suffix), false, 'Compute must not create a retired store');
    const after = Object.fromEntries(Object.entries(app.repositories).map(([name, repository]) => [name, fileDigest(repository.filePath)]));
    assert.deepEqual(after, before, 'HAYAKU RRF Compute never mutates canonical namespace databases');
    assert.ok(routes.includes('/v1/compute/bootstrap'));
    assert.ok(routes.includes('/v1/compute/execute'));
    assert.equal(routes.includes('/bootstrap'), false, 'HAYAKU Compute does not call Storage bootstrap');
    process.stdout.write('hayaku_sparse_rrf_compute_server_integration_test: PASS\n');
  } finally {
    try { await bridge?.dispose?.(); } catch (_) {}
    await app.close();
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), tempRoot);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`hayaku_sparse_rrf_compute_server_integration_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
