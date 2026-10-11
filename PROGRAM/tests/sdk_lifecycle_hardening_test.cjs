'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const program = path.resolve(__dirname, '..');
const sdkFiles = [
  'MemorySuiteStorageClient.source.js',
  'MemorySuiteStorageClient.libra.source.js'
];

for (const name of sdkFiles) {
  const source = fs.readFileSync(path.join(program, 'sdk', name), 'utf8');
  assert.ok(source.startsWith('/* LIBRARIAN SYSTEM STORAGE SDK v'+JSON.parse(fs.readFileSync(path.join(program,'program-manifest.json'),'utf8')).storageSdkVersion));
  assert.match(source, /const controller = typeof AbortController === 'function' \? new AbortController\(\) : null;/);
  // Current transport keeps physical fetch/body drain admitted independently
  // of the caller deadline; runtime disposal below verifies AbortSignal delivery.
  assert.match(source, /fetchApi\(url, requestInit\)/);
  assert.match(source, /withTimeout\(responseReady, label, timeoutMs, abort\)/);
  assert.match(source, /withTimeout\(physical, `\$\{label\} response`, timeoutMs, abort\)/);
  assert.match(source, /sharedBootstrapFailures\.set\(circuitUrl,/);
  assert.match(source, /responsePreview = compact\(raw, 200\)/);
  assert.match(source, /if \(state\.warned\.size >= 256\)/);
  assert.match(source, /const SYNC_JOB_MAX_RETRIES = 8;/);
  assert.match(source, /const SYNC_JOB_RESUME_TTL_MS = 2 \* 60 \* 60 \* 1000;/);
  assert.doesNotMatch(source, /retryCount \|\| 0\) < 120/);
  assert.match(source, /const dispose = async \(\) =>/);
  assert.match(source, /lifecycle\.abortControllers\.clear\(\)/);
  assert.match(source, /dispose,\n\s+openManagementDialog/);
  assert.match(source, /finally \{\n\s+if \(proofNeedsTransientServer\) state\.transientMode = '';\n\s+\}/);
}

const loadFactory = api => {
  const source = fs.readFileSync(path.join(program, 'sdk', 'MemorySuiteStorageClient.source.js'), 'utf8');
  const context = {
    risuai: api,
    console: { warn() {}, log() {}, error() {} },
    URL,
    AbortController,
    TextEncoder,
    setTimeout,
    clearTimeout,
    Promise,
    Map,
    Set,
    WeakMap,
    Object,
    Array,
    JSON,
    Date,
    Math,
    String,
    Number,
    Boolean,
    encodeURIComponent,
    decodeURIComponent
  };
  context.globalThis = context;
  vm.runInNewContext(`${source}\n;globalThis.__factory = createMemorySuiteStorageBridge;`, context, { timeout: 5000 });
  return context.__factory;
};

const bootstrapPayload = namespace => ({
  ok: true,
  schema: 'memory-suite.storage.bootstrap.v1',
  token: 'test-token',
  url: 'http://127.0.0.1:47630',
  version: '0.2.28',
  protocol: { major: 1, minor: 7 },
  capabilities: Object.fromEntries([
    'kv.v1', 'keys.v1', 'revision.v1', 'digest.v1', 'idempotency.v1',
    'tombstone.v1', 'readback.v1', 'namespace-integrity.v1'
  ].map(key => [key, true])),
  namespaces: [namespace]
});

const response = payload => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(payload)
});

const makeStorage = initial => {
  const values = new Map(Object.entries(initial || {}));
  return {
    getItem: async key => values.has(String(key)) ? values.get(String(key)) : null,
    setItem: async (key, value) => { values.set(String(key), value); return true; },
    removeItem: async key => { values.delete(String(key)); return true; },
    keys: async () => [...values.keys()]
  };
};

const createMirrorHarness = nativeFetch => {
  const argumentsStore = new Map([
    ['memory_suite_server_mode', 'plugin_only'],
    ['memory_suite_server_url', 'http://127.0.0.1:47630']
  ]);
  const storage = makeStorage({
    'test:key': 'local-value',
    '__memory_suite_internal_scope_routes_v1__:test': {
      schema: 'memory-suite.scope-routing.v1',
      version: 1,
      namespace: 'test',
      legacyGlobalModeImported: true,
      entries: {
        'scope:test': {
          scopeId: 'scope:test', scopeKey: 'scope:test', label: 'test', mode: 'mirror', updatedAt: Date.now()
        }
      }
    }
  });
  const api = {
    pluginStorage: storage,
    getArgument: async key => argumentsStore.get(String(key)),
    setArgument: async (key, value) => { argumentsStore.set(String(key), String(value)); return true; },
    nativeFetch
  };
  const factory = loadFactory(api);
  const bridge = factory({
    namespace: 'test',
    pluginId: 'test_plugin',
    pluginVersion: '1.0.0',
    pluginPrefixes: ['test:'],
    currentScopeProvider: async () => ({ scopeId: 'scope:test', scopeKey: 'scope:test', label: 'test' }),
    resolveKeyScope: async () => ({ kind: 'scope', scopeId: 'scope:test', scopeKey: 'scope:test', label: 'test' }),
    preResolveKeyScope: true,
    bootstrapRequestTimeoutMs: 750,
    requestTimeoutMs: 750,
    startupDiagnosticsDelayMs: 15000,
    migrationDelayMs: 10000
  });
  return { bridge, proxy: bridge.createPluginStorageProxy(storage) };
};

(async () => {
  let dataCalls = 0;
  const first = createMirrorHarness(async url => {
    if (String(url).endsWith('/bootstrap')) return response(bootstrapPayload('test'));
    dataCalls += 1;
    throw new TypeError('fetch failed');
  });
  assert.equal(await first.proxy.getItem('test:key'), 'local-value');
  assert.equal(dataCalls, 1, 'first failed data request reaches the server once');
  assert.equal(await first.proxy.getItem('test:key'), 'local-value');
  assert.equal(dataCalls, 1, 'shared offline circuit prevents a repeated dead-server request');
  await first.bridge.dispose();

  let aborted = false;
  const second = createMirrorHarness(async (url, init = {}) => {
    if (String(url).endsWith('/bootstrap')) return response(bootstrapPayload('test'));
    return await new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true;
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  });
  const pending = second.proxy.getItem('test:key');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(await second.bridge.dispose(), true);
  assert.equal(await pending, 'local-value');
  assert.equal(aborted, true, 'dispose aborts an in-flight server request');
  await assert.rejects(() => second.bridge.bootstrap(), error => error?.code === 'MEMORY_SUITE_BRIDGE_DISPOSED');

  process.stdout.write('sdk_lifecycle_hardening_test: PASS\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
