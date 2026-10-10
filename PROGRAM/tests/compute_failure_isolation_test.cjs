'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer, parseArgs } = require('../server/server.cjs');

const COMPUTE_SIGNING_KEY = 'failure-isolation-signing-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const raw = await response.text();
  return { response, payload: raw ? JSON.parse(raw) : {}, raw };
}

async function assertStorageRoundTrip(base, suffix) {
  const bootstrap = await jsonFetch(`${base}/bootstrap`, {
    headers: { 'X-Memory-Suite-Plugin': 'libra' }
  });
  assert.equal(bootstrap.response.status, 200, bootstrap.raw);
  assert.equal(bootstrap.payload.capabilities['compute.v1'], undefined,
    'storage bootstrap must not advertise an unavailable compute plane');
  const headers = {
    Authorization: `Bearer ${bootstrap.payload.token}`,
    'X-Memory-Suite-Plugin': 'libra',
    'Content-Type': 'application/json'
  };
  const key = `libra:compute-failure-isolation:${suffix}`;
  const set = await jsonFetch(`${base}/v1/kv/set`, {
    method: 'POST', headers,
    body: JSON.stringify({
      namespace: 'libra', space: 'plugin', key,
      operationId: `compute_failure_storage_${suffix}_0001`,
      value: { storageAlive: true }, expectedRevision: 0
    })
  });
  assert.equal(set.response.status, 200, set.raw);
  const get = await jsonFetch(`${base}/v1/kv/get?namespace=libra&space=plugin&key=${encodeURIComponent(key)}`, { headers });
  assert.equal(get.response.status, 200, get.raw);
  assert.deepEqual(get.payload.result.value, { storageAlive: true });
}

async function withApp(options, callback) {
  const app = createMemorySuiteServer(options);
  const address = await app.listen();
  try { await callback(app, `http://127.0.0.1:${address.port}`); }
  finally { await app.close(); }
}

async function main() {
  assert.equal(parseArgs(['serve']).computeWorkers, 0, 'omitted worker flag keeps automatic sizing');
  assert.equal(parseArgs(['serve', '--compute-workers', '1']).computeWorkers, 1);
  assert.equal(parseArgs(['serve', '--compute-workers', '16']).computeWorkers, 16);
  for (const invalid of [[], [''], ['abc'], ['0'], ['1.5'], ['-1'], ['17']]) {
    assert.throws(
      () => parseArgs(['serve', '--compute-workers', ...invalid]),
      /invalid_compute_workers/,
      `explicit invalid worker count must fail closed: ${JSON.stringify(invalid)}`
    );
  }

  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-compute-legacy-pairing-'));
  const legacyKeyPath = path.join(legacyDir, 'config', 'compute-pairing-key.txt');
  const migratedKeyPath = path.join(legacyDir, 'config', 'compute-signing-key.txt');
  fs.mkdirSync(path.dirname(legacyKeyPath), { recursive: true });
  fs.writeFileSync(legacyKeyPath, `${COMPUTE_SIGNING_KEY}\n`, { mode: 0o600 });
  try {
    await withApp({ host: '127.0.0.1', port: 0, dataDir: legacyDir, autoBackup: false, computeWorkers: 1 }, async (app, base) => {
      assert.equal(path.resolve(app.computeSigningKeyPath), path.resolve(migratedKeyPath));
      assert.equal(fs.readFileSync(migratedKeyPath, 'utf8').trim(), COMPUTE_SIGNING_KEY, 'legacy secret migrates to the server-only signing key');
      assert.equal(fs.readFileSync(legacyKeyPath, 'utf8').trim(), COMPUTE_SIGNING_KEY, 'legacy evidence remains untouched');
      const compute = await jsonFetch(`${base}/v1/compute/bootstrap`, {
        method: 'POST', headers: { 'X-Memory-Suite-Plugin': 'libra' },
        body: JSON.stringify({ namespace: 'libra' })
      });
      assert.equal(compute.response.status, 200, compute.raw);
      assert.ok(String(compute.payload.token || '').startsWith('mscompute1.'));
    });
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }

  const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-compute-corrupt-signing-'));
  const corruptKeyPath = path.join(corruptDir, 'config', 'compute-signing-key.txt');
  fs.mkdirSync(path.dirname(corruptKeyPath), { recursive: true });
  fs.writeFileSync(corruptKeyPath, 'short-invalid-key\n', { mode: 0o600 });
  try {
    await withApp({ host: '127.0.0.1', port: 0, dataDir: corruptDir, autoBackup: false }, async (app, base) => {
      assert.equal(path.resolve(app.computeSigningKeyPath), path.resolve(corruptKeyPath));
      assert.equal(fs.readFileSync(corruptKeyPath, 'utf8'), 'short-invalid-key\n', 'invalid key must not be overwritten');
      const health = await jsonFetch(`${base}/health`);
      assert.equal(health.response.status, 200);
      assert.equal(health.payload.compute.configured, true);
      assert.equal(health.payload.compute.ready, false);
      assert.equal(health.payload.compute.unavailableReason, 'compute_signing_key_invalid');
      await assertStorageRoundTrip(base, 'corrupt_signing');
      const compute = await jsonFetch(`${base}/v1/compute/bootstrap`, {
        method: 'POST',
        headers: { 'X-Memory-Suite-Plugin': 'libra' }
      });
      assert.equal(compute.response.status, 503, compute.raw);
      assert.equal(compute.payload.code, 'COMPUTE_SIGNING_UNAVAILABLE');
      assert.equal(compute.payload.fallback?.recommended, 'local');
    });
  } finally {
    fs.rmSync(corruptDir, { recursive: true, force: true });
  }

  const workerFailureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-compute-worker-failure-'));
  try {
    const missingWorkerPath = path.join(workerFailureDir, 'missing-compute-worker.cjs');
    await withApp({
      host: '127.0.0.1', port: 0, dataDir: workerFailureDir, autoBackup: false,
      computeSigningKey: COMPUTE_SIGNING_KEY, computeWorkers: 1, computeWorkerPath: missingWorkerPath
    }, async (app, base) => {
      const health = await jsonFetch(`${base}/health`);
      assert.equal(health.response.status, 200);
      assert.equal(health.payload.compute.configured, true);
      assert.equal(health.payload.compute.enabled, true);
      assert.equal(health.payload.compute.ready, false);
      assert.equal(health.payload.compute.unavailableReason, 'compute_worker_pool_unavailable');
      await assertStorageRoundTrip(base, 'worker_start');
      const compute = await jsonFetch(`${base}/v1/compute/bootstrap`, {
        method: 'POST',
        headers: { 'X-Memory-Suite-Plugin': 'libra' }
      });
      assert.equal(compute.response.status, 503, compute.raw);
      assert.equal(compute.payload.code, 'COMPUTE_UNAVAILABLE');
      assert.equal(compute.payload.fallback?.recommended, 'local');
      assert.equal(JSON.stringify(health.payload).includes(missingWorkerPath), false,
        'health must not expose a local worker path');
    });
  } finally {
    fs.rmSync(workerFailureDir, { recursive: true, force: true });
  }

  process.stdout.write('compute_failure_isolation_test: PASS\n');
}

main().catch(error => {
  process.stderr.write(`compute_failure_isolation_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
