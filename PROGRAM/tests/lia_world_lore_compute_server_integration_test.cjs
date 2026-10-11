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
function storageSnapshot(app) {
  return Object.fromEntries(Object.entries(app.repositories).map(([name, repository]) => {
    const exists = fs.existsSync(repository.filePath);
    if (!exists) {
      assert.ok(['lia', 'retrace'].includes(name), 'only retired inventory may be ephemeral');
      assert.equal(repository.ephemeral, true);
      assert.equal(repository.legacyReadOnly, true);
    }
    return [name, {
      exists, sha256: exists ? fileDigest(repository.filePath) : null,
      wal: fs.existsSync(repository.filePath+'-wal') ? fileDigest(repository.filePath+'-wal') : null,
      kv: repository.database.prepare('SELECT * FROM kv ORDER BY space,key').all(),
      operations: repository.database.prepare('SELECT * FROM operations ORDER BY operation_id').all(),
      metadata: repository.database.prepare('SELECT * FROM metadata ORDER BY key').all()
    }];
  }));
}

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
  let activeBridge = null;
  let liaValidationCalls = 0;
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
      validateBinding: binding => { liaValidationCalls += 1; return binding.revision === revision; }
    });
    const before = storageSnapshot(app);
    const direct = await bridge.execute(request());
    assert.equal(direct.source, 'local');
    assert.equal(direct.fallbackReason, 'COMPUTE_OWNER_PLUGIN_REQUIRED', 'retired LIA cannot obtain a server compute capability');
    assert.deepEqual(direct.result, executeOperation(definition.operation, input), 'denied remote compute still returns the complete deterministic LIA result');
    assert.deepEqual(direct.result.selected.map(row => row.loreId), ['rule','academy'], 'local fallback retains protected rule and relevant world lore');
    assert.deepEqual(direct.result.rejected.map(row => row.loreId), ['daily']);
    assert.equal(direct.result.selected[0].protectionTier, 'hard');
    assert.equal(localCalls, 1, 'retired remote authority falls back exactly once');
    const staleRequest = request();
    revision = 2;
    const stale = await bridge.execute(staleRequest);
    assert.equal(stale.source, 'local', 'a request made before revision change still completes through the local owner; no remote result is admitted');
    assert.equal(localCalls, 2);
    assert.deepEqual(stale.result, direct.result);
    assert.equal(liaValidationCalls, 0, 'identity refusal happens before any remote binding validation');
    assert.ok(networkRoutes.includes('/v1/compute/bootstrap'));
    assert.equal(networkRoutes.includes('/v1/compute/execute'), false, 'denied identity never dispatches a worker');
    // LIA no longer owns server compute. Keep the shared remote result/freshness
    // obligation on an actual supported owner operation, without impersonating LIA.
    const activeDefinition = DEFINITIONS['flashback.hash-embedding-batch.v1'];
    const activeInput = { texts:['world rule academy', 'preserved memory'], dimensions:64 };
    let activeRevision = 1, activeLocalCalls = 0;
    const validationHits = [];
    activeBridge = createMemorySuiteComputeBridge({ namespace:'flashback', pluginId:'flashback_memory',
      pluginVersion:'test', api, backgroundProbe:false,
      operations:{ [activeDefinition.operation]:{algorithmFingerprint:activeDefinition.fingerprint,
        local:input=>{activeLocalCalls += 1;return executeOperation(activeDefinition.operation,input);} } } });
    const activeRequest = () => ({ operation:activeDefinition.operation,input:activeInput,mode:'prefer_server',
      binding:{revision:activeRevision},deadlineMs:3000,
      validateBinding:binding=>{validationHits.push({request:binding.revision,current:activeRevision});return binding.revision===activeRevision;} });
    const current = await activeBridge.execute(activeRequest());
    assert.equal(current.source,'server',current.fallbackReason);
    assert.deepEqual(current.result,executeOperation(activeDefinition.operation,activeInput));
    assert.equal(activeLocalCalls,0);
    assert.deepEqual(validationHits,[{request:1,current:1}], 'the real remote result reaches binding admission');
    const obsolete = activeRequest();activeRevision = 2;
    const rejected = await activeBridge.execute(obsolete);
    assert.equal(rejected.source,'local');
    assert.equal(rejected.fallbackReason,'MEMORY_SUITE_COMPUTE_BINDING_STALE');
    assert.deepEqual(validationHits,[{request:1,current:1},{request:1,current:2}]);
    assert.equal(activeLocalCalls,1,'rejected remote result triggers exactly one local computation');
    assert.deepEqual(rejected.result,current.result);
    assert.ok(networkRoutes.includes('/v1/compute/execute'), 'active owner performs real worker dispatch');
    const after = storageSnapshot(app);
    assert.deepEqual(after, before, 'compute preserves canonical and ephemeral legacy inventory, including absent retired files');
    assert.equal(networkRoutes.includes('/bootstrap'), false, 'Compute does not call Storage bootstrap');
    process.stdout.write('lia_world_lore_compute_server_integration_test: PASS\n');
  } finally {
    try { await bridge?.dispose?.(); } catch (_) {}
    try { await activeBridge?.dispose?.(); } catch (_) {}
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
