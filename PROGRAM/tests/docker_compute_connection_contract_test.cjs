'use strict';
// Docker compute connection URL contract (fix P0-2).
// After bootstrap, the compute bridge must KEEP the requested transport URL
// (host.docker.internal) and expose the server-advertised loopback only as
// diagnostics. bootstrap, execute and job requests must all target the
// requested URL, never the advertised 127.0.0.1.
// This is a post-fix contract gate: it asserts the corrected behaviour.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const program = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(program, 'sdk', 'MemorySuiteComputeClient.source.js'), 'utf8');

const context = {
  console: { warn() {}, log() {}, error() {} },
  URL, AbortController, TextEncoder, Uint8Array, Uint32Array,
  setTimeout, clearTimeout, Promise, Map, Set, WeakMap,
  Object, Array, JSON, Date, Math, String, Number, Boolean
};
context.globalThis = context;
vm.runInNewContext(`${source}\n;globalThis.__factory = createMemorySuiteComputeBridge;`, context, { timeout: 5000 });
const createBridge = context.__factory;

const canonicalize = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
};
const digest = v => crypto.createHash('sha256').update(canonicalize(v)).digest('hex');
const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) });

const REQUESTED = 'http://host.docker.internal:47630';
const ADVERTISED = 'http://127.0.0.1:47630';
const operation = 'test.rank.v1';
const fingerprint = 'test-kernel-v1';

const bootstrapPayload = {
  ok: true,
  schema: 'memory-suite.compute.bootstrap.v1',
  name: 'Librarian System Compute',
  version: '0.3.6-test',
  url: ADVERTISED, // server advertises its own loopback
  token: 'compute-token',
  authorization: { schema: 'memory-suite.compute-authorization.v1', pluginId: 'test_plugin', namespace: 'test', roles: ['compute'] },
  capabilities: { 'compute.v1': true, 'compute-jobs.v1': true },
  limits: { maxDeadlineMs: 5000 },
  operations: [{ operation, algorithmFingerprint: fingerprint, maxDeadlineMs: 5000 }]
};

(async () => {
  const seenUrls = [];
  const bridge = createBridge({
    namespace: 'test',
    pluginId: 'test_plugin',
    pluginVersion: '1.0.0',
    urlProvider: async () => REQUESTED, // user-configured Docker host
    operations: { [operation]: { algorithmFingerprint: fingerprint, local: async input => ({ ranked: [...input.values].sort((a, b) => b - a) }) } },
    fetch: async (url, init = {}) => {
      seenUrls.push(String(url));
      if (String(url).endsWith('/v1/compute/bootstrap')) return response(bootstrapPayload);
      if (String(url).endsWith('/v1/compute/execute')) {
        const body = JSON.parse(init.body);
        const result = { ranked: [...body.input.values].sort((a, b) => b - a) };
        return response({
          ok: true, schema: 'memory-suite.compute.execute-response.v1',
          result: {
            schema: 'memory-suite.compute.result.v1', jobId: 'job-1', operationId: body.operationId,
            namespace: body.namespace, operation: body.operation, algorithmFingerprint: body.algorithmFingerprint,
            inputDigest: body.inputDigest, binding: body.binding, result, resultDigest: digest(result), timing: { workerMs: 1 }
          }
        });
      }
      throw new Error(`unexpected_url:${url}`);
    },
    modeProvider: async () => 'prefer_server',
    modeSetter: async () => true,
    backgroundProbe: false,
    defaultDeadlineMs: 400,
    probeTimeoutMs: 200
  });

  // probe: connection URL must stay on the requested Docker host, not the advertised loopback
  const probed = await bridge.probe({ force: true });
  assert.equal(probed.ok, true, 'probe succeeds against the requested Docker host');
  assert.equal(probed.url, REQUESTED, 'connection.url keeps the requested host.docker.internal, not the advertised loopback');

  // every request so far must have targeted the requested host
  for (const u of seenUrls) {
    assert.ok(u.startsWith(REQUESTED), `request must target the requested host, got: ${u}`);
    assert.ok(!u.startsWith(ADVERTISED), `request must NOT target the advertised loopback, got: ${u}`);
  }
  assert.ok(seenUrls.some(u => u.endsWith('/v1/compute/bootstrap')), 'bootstrap was called');

  // execute must also target the requested host
  const out = await bridge.execute({ operation, input: { values: [3, 1, 2] }, binding: { revision: 1 } });
  assert.deepEqual(out.result.ranked, [3, 2, 1], 'execute returned the server result');
  const execUrls = seenUrls.filter(u => u.endsWith('/v1/compute/execute'));
  assert.ok(execUrls.length >= 1, 'execute issued a request');
  for (const u of execUrls) assert.equal(u, `${REQUESTED}/v1/compute/execute`, 'execute targets the requested Docker host');

  bridge.dispose();
  console.log(JSON.stringify({ test: 'docker_compute_connection_contract', result: 'pass', connectionUrl: probed.url, requests: seenUrls.length }));
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
