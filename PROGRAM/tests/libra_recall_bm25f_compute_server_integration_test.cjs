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
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'memory-suite-libra-bm25f-'));
  assert.equal(path.dirname(dataDir), tempRoot);
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false, computeWorkers: 2 });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const args = new Map([
    ['memory_suite_server_mode', 'plugin_only'],
    ['memory_suite_server_url', baseUrl]
  ]);
  const networkRoutes = [];
  const api = {
    async getArgument(name) { return args.get(String(name)) || ''; },
    async setArgument(name, value) { args.set(String(name), String(value)); return true; },
    async nativeFetch(url, init = {}) { networkRoutes.push(new URL(String(url)).pathname); return await fetch(url, init); }
  };
  const definition = DEFINITIONS['libra.recall-bm25f.v1'];
  let bridge = null;
  let localCalls = 0;
  let revision = 1;
  try {
    bridge = createMemorySuiteComputeBridge({
      namespace: 'libra',
      pluginId: 'libra',
      pluginVersion: '2.3.30-test',
      api,
      backgroundProbe: false,
      defaultDeadlineMs: 3000,
      localReserveMs: 400,
      jobPollIntervalMs: 25,
      operations: {
        [definition.operation]: {
          algorithmFingerprint: definition.fingerprint,
          local: input => { localCalls += 1; return executeOperation(definition.operation, input); }
        }
      }
    });
    const input = {
      schema: 'libra.recall-bm25f.input.v1',
      queryText: '아카데미 마법 금지 규칙 academy magic law',
      documents: [
        { position: 0, id: 'memory-1:r1', fields: { summary: '아카데미 마법 금지', recall_keys: 'academy magic law', characters_relations: '', narrative_open_threads: '금지 규칙 조사', chronology: '첫째 날', world_scene: '왕립 아카데미', facts_uncertainty: '', full_text: 'Magic is forbidden.' } },
        { position: 1, id: 'memory-2:r1', fields: { summary: '아침 식사', recall_keys: 'tea bread', characters_relations: '', narrative_open_threads: '', chronology: '둘째 날', world_scene: '정원', facts_uncertainty: '', full_text: 'A quiet breakfast.' } }
      ]
    };
    const request = () => ({
      operation: definition.operation,
      input,
      binding: { schema: 'memory-suite.libra.recall-bm25f-binding.v1', revision },
      lane: 'interactive',
      mode: 'prefer_server',
      deadlineMs: 3000,
      localReserveMs: 400,
      validateBinding: binding => binding.revision === revision
    });
    for (const name of ['lia','retrace']) for (const suffix of ['', '-wal']) assert.equal(fs.existsSync(app.repositories[name].filePath + suffix), false, 'retired live store must remain absent');
    const before = Object.fromEntries(Object.entries(app.repositories).map(([name, repository]) => [name, fileDigest(repository.filePath)]));
    const direct = await bridge.execute(request());
    assert.equal(direct.source, 'server');
    assert.deepEqual(direct.result, executeOperation(definition.operation, input), 'actual LIBRA Worker result exactly matches the local kernel');
    assert.equal(localCalls, 0, 'prefer-server delegates the current LIBRA request instead of duplicating local work');
    const staleRequest = request();
    revision = 2;
    const stale = await bridge.execute(staleRequest);
    assert.equal(stale.source, 'local', 'changed LIBRA owner binding falls back to the local kernel');
    assert.equal(localCalls, 1);
    for (const name of ['lia','retrace']) for (const suffix of ['', '-wal']) assert.equal(fs.existsSync(app.repositories[name].filePath + suffix), false, 'Compute must not create a retired store');
    const after = Object.fromEntries(Object.entries(app.repositories).map(([name, repository]) => [name, fileDigest(repository.filePath)]));
    assert.deepEqual(after, before, 'LIBRA BM25F Compute never mutates canonical namespace databases');
    assert.ok(networkRoutes.includes('/v1/compute/bootstrap'));
    assert.ok(networkRoutes.includes('/v1/compute/execute'));
    assert.equal(networkRoutes.includes('/bootstrap'), false, 'LIBRA Compute does not call Storage bootstrap');
    process.stdout.write('libra_recall_bm25f_compute_server_integration_test: PASS\n');
  } finally {
    try { await bridge?.dispose?.(); } catch (_) {}
    await app.close();
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), tempRoot);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`libra_recall_bm25f_compute_server_integration_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
