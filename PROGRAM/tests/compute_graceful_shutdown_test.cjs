'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const raw = await response.text();
  return { response, payload: raw ? JSON.parse(raw) : {} };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-compute-shutdown-'));
  const app = createMemorySuiteServer({
    host: '127.0.0.1', port: 0, dataDir, autoBackup: true,
    computeWorkers: 1, allowComputeTestOperations: true,
    computeLimits: { shutdownGraceMs: 25 }
  });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.ok(app.computeSigningKeyPath);
    assert.equal(path.resolve(app.computeSigningKeyPath), path.resolve(dataDir, 'config', 'compute-signing-key.txt'));
    const signingKey = fs.readFileSync(app.computeSigningKeyPath, 'utf8').trim();
    assert.ok(signingKey.length >= 32);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(app.computeSigningKeyPath).mode & 0o777, 0o600);
    }

    const storageBootstrap = await jsonFetch(`${base}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': 'libra' } });
    assert.equal(storageBootstrap.response.status, 200);
    const set = await jsonFetch(`${base}/v1/kv/set`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${storageBootstrap.payload.token}`,
        'X-Memory-Suite-Plugin': 'libra',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        namespace: 'libra', space: 'plugin', key: 'libra:compute-shutdown:test',
        operationId: 'compute_shutdown_storage_0001', value: { durable: true }, expectedRevision: 0
      })
    });
    assert.equal(set.response.status, 200, JSON.stringify(set.payload));

    const computeBootstrap = await jsonFetch(`${base}/v1/compute/bootstrap`, {
      method: 'POST',
      headers: {
        'X-Memory-Suite-Plugin': 'libra',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ namespace: 'libra' })
    });
    assert.equal(computeBootstrap.response.status, 200, JSON.stringify(computeBootstrap.payload));
    assert.equal(JSON.stringify(computeBootstrap.payload).includes(signingKey), false);
    const spin = computeBootstrap.payload.operations.find(item => item.operation === 'memory-suite.test.spin.v1');
    const computeHeaders = {
      Authorization: `Bearer ${computeBootstrap.payload.token}`,
      'X-Memory-Suite-Plugin': 'libra',
      'Content-Type': 'application/json'
    };
    const job = await jsonFetch(`${base}/v1/compute/jobs`, {
      method: 'POST', headers: computeHeaders,
      body: JSON.stringify({
        namespace: 'libra', operation: spin.operation, operationId: 'compute_shutdown_spin_00001',
        algorithmFingerprint: spin.algorithmFingerprint, input: { durationMs: 1000 },
        lane: 'maintenance', deadlineMs: 2000
      })
    });
    assert.equal(job.response.status, 202, JSON.stringify(job.payload));

    const closeStartedAt = Date.now();
    await app.close();
    const closeElapsedMs = Date.now() - closeStartedAt;
    assert.ok(closeElapsedMs < 5000, `graceful close must be bounded, actual=${closeElapsedMs}`);
    assert.equal(app.computePlane.stats().pool.active, 0);
    assert.equal(app.computePlane.stats().pool.ready, 0);
    assert.ok(['cancelled', 'failed', 'expired', 'succeeded'].includes(app.computePlane.jobs.get(job.payload.result.jobId)?.state));

    const autoRoot = path.join(dataDir, 'backups', 'auto');
    const backupNames = fs.readdirSync(autoRoot);
    assert.ok(backupNames.length >= 1, 'dirty storage must still receive shutdown backup');
    const manifests = backupNames.map(name => JSON.parse(fs.readFileSync(path.join(autoRoot, name, 'manifest.json'), 'utf8')));
    const shutdownBackup = manifests.find(manifest => manifest.label === 'shutdown');
    assert.ok(shutdownBackup);
    assert.ok(shutdownBackup.stores.libra.sha256);

    process.stdout.write('compute_graceful_shutdown_test: PASS\n');
  } finally {
    try { await app.close(); } catch (_) {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`compute_graceful_shutdown_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
