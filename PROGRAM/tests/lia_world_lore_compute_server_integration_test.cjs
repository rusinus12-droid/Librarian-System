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
const fileDigest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function main() {
  const tempRoot = path.resolve(os.tmpdir());
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'memory-suite-lia-compute-'));
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
  const definition = DEFINITIONS['lia.world-lore-rerank.v2'];
  let bridge = null;
  let localCalls = 0;
  let revision = 1;
  try {
    bridge = createMemorySuiteComputeBridge({
      namespace: 'lia',
      pluginId: 'lia_persona_linker',
      pluginVersion: '0.26.66-test',
      api,
      backgroundProbe: false,
      defaultDeadlineMs: 3000,
      localReserveMs: 350,
      jobPollIntervalMs: 25,
      operations: {
        [definition.operation]: {
          algorithmFingerprint: definition.fingerprint,
          local: input => { localCalls += 1; return executeOperation(definition.operation, input); }
        }
      }
    });
    const input = {
      version: 'lia_lore_reranker_v2',
      purpose: 'world',
      topK: 3,
      query: 'world rule academy culture 세계관 규칙 학교',
      entries: [
        { position: 0, loreId: 'rule', key: 'World Rule', secondkey: '', comment: 'Canon', content: 'Magic does not exist.', mode: 'constant', alwaysActive: true, insertorder: 100, source: 'character_lore', score: 180 },
        { position: 1, loreId: 'academy', key: 'Academy', secondkey: 'school', comment: 'Institution', content: 'Central academy and culture.', mode: 'normal', alwaysActive: false, insertorder: 20, source: 'module_lore', score: 70 },
        { position: 2, loreId: 'daily', key: 'Breakfast', secondkey: '', comment: 'Routine', content: 'Tea each morning.', mode: 'normal', alwaysActive: false, insertorder: 0, source: 'chat_lore', score: 2 }
      ]
    };
    const request = () => ({
      operation: definition.operation,
      input,
      binding: { schema: 'memory-suite.lia.world-lore-binding.v1', revision },
      lane: 'interactive',
      mode: 'prefer_server',
      deadlineMs: 3000,
      localReserveMs: 350,
      validateBinding: binding => binding.revision === revision
    });
    const before = Object.fromEntries(Object.entries(app.repositories).map(([name, repository]) => [name, fileDigest(repository.filePath)]));
    const direct = await bridge.execute(request());
    assert.equal(direct.source, 'server');
    assert.deepEqual(direct.result, executeOperation(definition.operation, input), 'actual LIA Worker result exactly matches the local kernel');
    assert.equal(localCalls, 0, 'prefer-server delegates the current LIA request instead of duplicating local work');
    const staleRequest = request();
    revision = 2;
    const stale = await bridge.execute(staleRequest);
    assert.equal(stale.source, 'local', 'changed owner binding falls back to the local kernel');
    assert.equal(localCalls, 1);
    const after = Object.fromEntries(Object.entries(app.repositories).map(([name, repository]) => [name, fileDigest(repository.filePath)]));
    assert.deepEqual(after, before, 'LIA Compute never mutates canonical namespace databases');
    assert.ok(networkRoutes.includes('/v1/compute/bootstrap'));
    assert.ok(networkRoutes.includes('/v1/compute/execute'));
    assert.equal(networkRoutes.includes('/bootstrap'), false, 'LIA Compute does not call Storage bootstrap');
    process.stdout.write('lia_world_lore_compute_server_integration_test: PASS\n');
  } finally {
    try { await bridge?.dispose?.(); } catch (_) {}
    await app.close();
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), tempRoot);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`lia_world_lore_compute_server_integration_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
