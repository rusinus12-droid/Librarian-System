'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createMemorySuiteServer } = require('../server/server.cjs');

const expectedServerVersion = fs.readFileSync(path.join(__dirname, '..', 'VERSION.txt'), 'utf8').trim();

const pluginHeaders = (token, plugin = 'flashback_memory', version = '0.11.23', scopeId = 'diag-scope-a', mode = 'mirror') => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'X-Memory-Suite-Plugin': plugin,
  'X-Memory-Suite-Plugin-Version': version,
  'X-Memory-Suite-Scope-Id': encodeURIComponent(scopeId),
  'X-Memory-Suite-Storage-Mode': mode
});

async function json(url, init = {}) {
  const response = await fetch(url, init);
  const payload = await response.json();
  return { response, payload };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-diagnostics-'));
  const dataDir = path.join(root, 'DATA');
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    path.join(logsDir, 'startup-error.log'),
    [
      'startup phase failed once',
      'Authorization: Bearer TOPSECRET_DIAGNOSTIC_TOKEN_1234567890',
      'api_key=PRIVATE_API_KEY_SHOULD_NOT_LEAK',
      'ordinary safe line'
    ].join('\n'),
    'utf8'
  );
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const bootstrap = await json(`${baseUrl}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': 'flashback_memory', 'X-Memory-Suite-Plugin-Version': '0.11.23' } });
    assert.equal(bootstrap.payload.ok, true);
    assert.equal(bootstrap.payload.version, expectedServerVersion);
    assert.equal(bootstrap.payload.protocol.minor, 9);
    assert.equal(bootstrap.payload.capabilities['server-diagnostics.v1'], true);
    assert.equal(bootstrap.payload.capabilities['manager-diagnostics.v1'], true);
    const token = bootstrap.payload.token;
    const headers = pluginHeaders(token);
    const rawKey = 'vector_rag_memory:scope:private-scope:records:shard:0001';
    const rawValue = { secretMarker: 'PRIVATE_RP_BODY_MUST_NOT_LEAK', text: 'user-authored private scene text' };
    const set = await json(`${baseUrl}/v1/kv/set`, {
      method: 'POST', headers,
      body: JSON.stringify({ namespace: 'flashback', space: 'plugin', key: rawKey, value: rawValue, operationId: 'diagnostic_test_operation_0001', expectedRevision: 0 })
    });
    assert.equal(set.payload.ok, true, JSON.stringify(set.payload));
    const get = await json(`${baseUrl}/v1/kv/get?namespace=flashback&space=plugin&key=${encodeURIComponent(rawKey)}`, { headers });
    assert.equal(get.payload.result.exists, true);

    const diagnostics = await json(`${baseUrl}/v1/diagnostics?namespace=flashback&scopeId=${encodeURIComponent('diag-scope-a')}&limit=100&includeTextLogs=1`, { headers });
    assert.equal(diagnostics.payload.ok, true);
    const result = diagnostics.payload.result;
    assert.equal(result.schema, 'memory-suite.server-diagnostics.v1');
    assert.equal(result.reachable, true);
    assert.equal(result.integrity.ok, true);
    assert.ok(result.events.some(event => event.operation === 'kv.set' && event.ok === true));
    assert.ok(result.events.some(event => event.operation === 'kv.get' && event.ok === true));
    assert.ok(result.events.every(event => !Object.hasOwn(event, 'key')));
    const serialized = JSON.stringify(result);
    for (const forbidden of [rawKey, rawValue.secretMarker, rawValue.text, token, 'Authorization: Bearer']) {
      assert.equal(serialized.includes(forbidden), false, `diagnostics leaked ${forbidden}`);
    }
    assert.match(serialized, /keyHash/);
    assert.match(serialized, /scopeIdHash/);
    assert.equal(result.log.file, 'DATA/logs/server-debug.jsonl');
    assert.ok(fs.existsSync(path.join(dataDir, 'logs', 'server-debug.jsonl')));
    assert.deepEqual(result.textLogs, [], 'ordinary owner diagnostics must not expose suite-global process text logs');
    assert.equal(result.textLogsManagerOnly, true);

    const forbiddenNamespace = await json(`${baseUrl}/v1/diagnostics?namespace=libra&limit=10`, { headers });
    assert.equal(forbiddenNamespace.response.status, 403);

    const managerBootstrap = await json(`${baseUrl}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': 'flashback_hayaku_bridge', 'X-Memory-Suite-Plugin-Version': '1.9.45' } });
    assert.equal(managerBootstrap.response.status, 200);
    const managerHeaders = pluginHeaders(managerBootstrap.payload.token, 'flashback_hayaku_bridge', '1.9.45', 'diag-scope-a', 'plugin_only');
    managerHeaders['X-Memory-Suite-Manager'] = 'retrace';
    const manager = await json(`${baseUrl}/v1/manager/diagnostics?limit=100&includeTextLogs=1`, { headers: managerHeaders });
    assert.equal(manager.payload.ok, true);
    assert.equal(manager.payload.result.schema, 'memory-suite.manager-server-diagnostics.v1');
    assert.deepEqual(Object.keys(manager.payload.result.integrity).sort(), ['flashback', 'hayaku', 'lia', 'libra', 'retrace']);
    const startupErrorTail = manager.payload.result.textLogs.find(item => item.file === 'startup-error.log');
    assert.ok(startupErrorTail, 'manager startup-error.log tail missing');
    assert.match(startupErrorTail.tail, /ordinary safe line/);
    assert.match(startupErrorTail.tail, /\[REDACTED\]/);
    for (const forbidden of ['TOPSECRET_DIAGNOSTIC_TOKEN_1234567890', 'PRIVATE_API_KEY_SHOULD_NOT_LEAK']) {
      assert.equal(JSON.stringify(manager.payload.result.textLogs).includes(forbidden), false, `manager text log tail leaked ${forbidden}`);
    }

    const sdkText = fs.readFileSync(path.join(__dirname, '..', 'sdk', 'MemorySuiteStorageClient.source.js'), 'utf8');
    const createBridge = new Function(`${sdkText}\nreturn createMemorySuiteStorageBridge;`)();
    const previousRisuai = globalThis.risuai;
    const args = { memory_suite_server_mode: 'plugin_only', memory_suite_server_url: baseUrl };
    try {
      const routeStoreMap = new Map();
      globalThis.risuai = {
        pluginStorage: {
          async getItem(key) { return routeStoreMap.has(String(key)) ? routeStoreMap.get(String(key)) : null; },
          async setItem(key, value) { routeStoreMap.set(String(key), value); return true; },
          async removeItem(key) { routeStoreMap.delete(String(key)); return true; },
          async keys() { return Array.from(routeStoreMap.keys()); }
        },
        async getArgument(name) { return args[name] || ''; },
        async setArgument(name, value) { args[name] = String(value); return true; },
        async nativeFetch(url, init) { return await fetch(url, init); }
      };
      const bridge = createBridge({
        namespace: 'flashback', pluginId: 'flashback_memory', pluginVersion: '0.11.23', managementButton: false,
        currentScopeProvider: async () => ({ scopeId: 'diag-scope-a', scopeKey: 'diag-scope-a', label: 'Diagnostic Scope' })
      });
      const exported = await bridge.getDiagnostics({ force: true, probeServer: true, limit: 100 });
      assert.equal(exported.reachable, true);
      assert.equal(exported.schema, 'memory-suite.plugin-server-diagnostics.v1');
      assert.ok(Array.isArray(exported.events));
      assert.deepEqual(exported.textLogs, []);
      assert.equal(exported.textLogsManagerOnly, true);
      assert.equal(bridge.getCachedDiagnostics().reachable, true);

      const managerBridge = createBridge({
        namespace: 'retrace', pluginId: 'flashback_hayaku_bridge', pluginVersion: '1.9.45', managementButton: false,
        currentScopeProvider: async () => ({ scopeId: 'diag-scope-a', scopeKey: 'diag-scope-a', label: 'Diagnostic Scope' })
      });
      const all = await managerBridge.managerGetDiagnostics({ limit: 100 });
      assert.equal(all.reachable, true);
      assert.equal(all.schema, 'memory-suite.manager-server-diagnostics.v1');
      assert.equal(Object.keys(all.integrity).length, 5);
      assert.ok(all.textLogs.some(item => item.file === 'startup-error.log'));

      // Diagnostics are optional capabilities. A core-compatible older server must
      // remain usable and report supported=false instead of failing the whole bridge.
      const legacyServer = http.createServer((request, response) => {
        const legacyAddress = legacyServer.address();
        const legacyBase = `http://127.0.0.1:${legacyAddress.port}`;
        if (request.url === '/bootstrap') {
          const body = JSON.stringify({
            ok: true,
            schema: 'memory-suite.storage.bootstrap.v1',
            version: '0.2.7',
            url: legacyBase,
            token: 'legacy-core-token',
            protocol: { major: 1, minor: 4 },
            namespaces: ['flashback', 'hayaku', 'libra', 'lia', 'retrace'],
            capabilities: Object.fromEntries(['kv.v1','keys.v1','revision.v1','digest.v1','idempotency.v1','tombstone.v1','readback.v1','namespace-integrity.v1'].map(item => [item, true]))
          });
          response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
          response.end(body);
          return;
        }
        const body = JSON.stringify({ ok: false, error: 'unexpected_route' });
        response.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        response.end(body);
      });
      await new Promise((resolve, reject) => legacyServer.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
      try {
        const legacyAddress = legacyServer.address();
        args.memory_suite_server_url = `http://127.0.0.1:${legacyAddress.port}`;
        const legacyBridge = createBridge({
          namespace: 'flashback', pluginId: 'flashback_memory', pluginVersion: '0.11.20', managementButton: false,
          currentScopeProvider: async () => ({ scopeId: 'diag-scope-a', scopeKey: 'diag-scope-a', label: 'Diagnostic Scope' })
        });
        const legacyDiagnostics = await legacyBridge.getDiagnostics({ force: true, probeServer: true });
        assert.equal(legacyDiagnostics.reachable, true);
        assert.equal(legacyDiagnostics.supported, false);
        assert.equal(legacyDiagnostics.reason, 'server_diagnostics_unsupported');
        const legacyManagerBridge = createBridge({
          namespace: 'retrace', pluginId: 'flashback_hayaku_bridge', pluginVersion: '1.9.41', managementButton: false,
          currentScopeProvider: async () => ({ scopeId: 'diag-scope-a', scopeKey: 'diag-scope-a', label: 'Diagnostic Scope' })
        });
        const legacyManager = await legacyManagerBridge.managerGetDiagnostics();
        assert.equal(legacyManager.reachable, true);
        assert.equal(legacyManager.supported, false);
        assert.equal(legacyManager.reason, 'manager_server_diagnostics_unsupported');
      } finally {
        await new Promise(resolve => legacyServer.close(() => resolve()));
        args.memory_suite_server_url = baseUrl;
      }

      await app.close();
      const offline = await bridge.refreshDiagnostics({ probeServer: true, limit: 10 });
      assert.equal(offline.reachable, false);
      assert.ok(offline.error);
    } finally {
      if (previousRisuai === undefined) delete globalThis.risuai; else globalThis.risuai = previousRisuai;
    }
    process.stdout.write('server_diagnostics_export_test: PASS\n');
  } finally {
    try { await app.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`server_diagnostics_export_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
