'use strict';
// Late RisuAI/PocketRisu API binding (fix P0-1).
// The compute bridge must re-resolve the host API on every request, so a
// risuai.nativeFetch that becomes available AFTER the bridge was created is
// still used — instead of a one-time captured snapshot falling back to global
// fetch (which, in Docker, hits the container's own 127.0.0.1 and fails).
// Post-fix gate: bridge created with no host API present, API injected later,
// then a probe must go through nativeFetch to the configured Docker host and
// never touch the global fetch.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const program = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(program, 'sdk', 'MemorySuiteComputeClient.source.js'), 'utf8');

const REQUESTED = 'http://host.docker.internal:47630';
const operation = 'test.rank.v1';
const fingerprint = 'test-kernel-v1';

const canonicalize = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
};
const digest = v => crypto.createHash('sha256').update(canonicalize(v)).digest('hex');
const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) });

const bootstrapPayload = {
  ok: true, schema: 'memory-suite.compute.bootstrap.v1', name: 'Librarian System Compute',
  version: '0.3.6-test', url: 'http://127.0.0.1:47630', token: 'compute-token',
  authorization: { schema: 'memory-suite.compute-authorization.v1', pluginId: 'test_plugin', namespace: 'test', roles: ['compute'] },
  capabilities: { 'compute.v1': true }, limits: { maxDeadlineMs: 5000 },
  operations: [{ operation, algorithmFingerprint: fingerprint, maxDeadlineMs: 5000 }]
};

let nativeFetchCalls = 0;
let globalFetchCalls = 0;
const nativeFetchUrls = [];

// nativeFetch that will be attached to a late-registered risuai host
const nativeFetch = async (url, init = {}) => {
  nativeFetchCalls += 1;
  nativeFetchUrls.push(String(url));
  if (String(url).endsWith('/v1/compute/bootstrap')) return response(bootstrapPayload);
  throw new Error(`unexpected_native_url:${url}`);
};

// global fetch inside the vm — must NEVER be used once a host API is present
const globalFetch = async (url) => { globalFetchCalls += 1; throw new Error(`global_fetch_used:${url}`); };

const context = {
  console: { warn() {}, log() {}, error() {} },
  URL, AbortController, TextEncoder, Uint8Array, Uint32Array,
  setTimeout, clearTimeout, Promise, Map, Set, WeakMap,
  Object, Array, JSON, Date, Math, String, Number, Boolean,
  fetch: globalFetch
};
context.globalThis = context; // risuai is intentionally ABSENT at bridge creation
vm.runInNewContext(`${source}\n;globalThis.__factory = createMemorySuiteComputeBridge;`, context, { timeout: 5000 });
const createBridge = context.__factory;

(async () => {
  // Create the bridge while NO host API and NO options.fetch is available.
  const bridge = createBridge({
    namespace: 'test',
    pluginId: 'test_plugin',
    pluginVersion: '1.0.0',
    urlProvider: async () => REQUESTED,
    operations: { [operation]: { algorithmFingerprint: fingerprint, local: async input => ({ ranked: [...input.values].sort((a, b) => b - a) }) } },
    // NO fetch option — force the bridge to resolve the host API itself
    modeProvider: async () => 'prefer_server',
    modeSetter: async () => true,
    backgroundProbe: false,
    defaultDeadlineMs: 400,
    probeTimeoutMs: 200
  });

  // NOW, after creation, PocketRisu attaches its API to the global.
  context.risuai = { nativeFetch };
  context.globalThis.risuai = context.risuai;

  const probed = await bridge.probe({ force: true });
  assert.equal(probed.ok, true, 'probe must succeed using the late-bound nativeFetch');
  assert.equal(probed.url, REQUESTED, 'probe must target the configured Docker host');
  assert.ok(nativeFetchCalls >= 1, 'the late-registered nativeFetch must be used');
  assert.ok(nativeFetchUrls.every(u => u.startsWith(REQUESTED)), 'nativeFetch requests target the Docker host');
  assert.equal(globalFetchCalls, 0, 'global fetch must never be used once a host nativeFetch is available');

  bridge.dispose();
  console.log(JSON.stringify({ test: 'compute_late_risu_api_binding', result: 'pass', nativeFetchCalls, globalFetchCalls }));
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
