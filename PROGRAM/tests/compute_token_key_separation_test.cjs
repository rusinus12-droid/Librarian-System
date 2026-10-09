'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');

const COMPUTE_SIGNING_KEY = 'separate-compute-signing-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const STORAGE_TOKEN_A = 'storage-runtime-token-A-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const STORAGE_TOKEN_B = 'storage-runtime-token-B-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const raw = await response.text();
  return { response, payload: raw ? JSON.parse(raw) : {}, raw };
}

const pluginHeaders = token => ({
  Authorization: `Bearer ${token}`,
  'X-Memory-Suite-Plugin': 'flashback_memory',
  'Content-Type': 'application/json'
});

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-compute-key-separation-'));
  let app = null;
  try {
    app = createMemorySuiteServer({
      host: '127.0.0.1', port: 0, dataDir, autoBackup: false,
      token: STORAGE_TOKEN_A, computeWorkers: 1, computeSigningKey: COMPUTE_SIGNING_KEY
    });
    let address = await app.listen();
    let base = `http://127.0.0.1:${address.port}`;

    const storageBootstrapA = await jsonFetch(`${base}/bootstrap`, {
      headers: { 'X-Memory-Suite-Plugin': 'flashback_memory' }
    });
    assert.equal(storageBootstrapA.response.status, 200);
    const computeBootstrap = await jsonFetch(`${base}/v1/compute/bootstrap`, {
      method: 'POST',
      headers: {
        'X-Memory-Suite-Plugin': 'flashback_memory',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ namespace: 'flashback' })
    });
    assert.equal(computeBootstrap.response.status, 200, computeBootstrap.raw);
    const computeToken = computeBootstrap.payload.token;
    const storageCapabilityTokenA = storageBootstrapA.payload.token;
    assert.ok(String(computeToken).startsWith('mscompute1.'));
    assert.ok(String(storageCapabilityTokenA).startsWith('mscap1.'));
    assert.equal(computeBootstrap.raw.includes(COMPUTE_SIGNING_KEY), false);

    await app.close();
    app = createMemorySuiteServer({
      host: '127.0.0.1', port: 0, dataDir, autoBackup: false,
      token: STORAGE_TOKEN_B, computeWorkers: 1, computeSigningKey: COMPUTE_SIGNING_KEY
    });
    address = await app.listen();
    base = `http://127.0.0.1:${address.port}`;

    const oldComputeAfterStorageRotation = await jsonFetch(`${base}/v1/compute/capabilities`, {
      headers: pluginHeaders(computeToken)
    });
    assert.equal(oldComputeAfterStorageRotation.response.status, 200, oldComputeAfterStorageRotation.raw);

    const oldStorageAfterRotation = await jsonFetch(`${base}/v1/kv/get?namespace=flashback&space=plugin&key=flashback%3Aseparation`, {
      headers: pluginHeaders(storageCapabilityTokenA)
    });
    assert.equal(oldStorageAfterRotation.response.status, 403, 'storage capability must rotate with its runtime token');

    const rawStorageRuntimeDenied = await jsonFetch(`${base}/v1/compute/capabilities`, {
      headers: pluginHeaders(STORAGE_TOKEN_B)
    });
    assert.equal(rawStorageRuntimeDenied.response.status, 403, 'raw storage runtime token must not authorize compute');

    const computeStorageDenied = await jsonFetch(`${base}/v1/kv/get?namespace=flashback&space=plugin&key=flashback%3Aseparation`, {
      headers: pluginHeaders(computeToken)
    });
    assert.equal(computeStorageDenied.response.status, 403, 'compute capability must not authorize storage');

    const health = await jsonFetch(`${base}/health`);
    assert.equal(health.raw.includes(COMPUTE_SIGNING_KEY), false);
    await app.close();
    app = null;

    for (const filePath of fs.readdirSync(dataDir, { recursive: true })
      .map(name => path.join(dataDir, String(name)))
      .filter(name => fs.existsSync(name) && fs.statSync(name).isFile())) {
      assert.equal(fs.readFileSync(filePath).includes(Buffer.from(COMPUTE_SIGNING_KEY, 'utf8')), false,
        `raw injected signing secret must not be persisted or journaled: ${filePath}`);
    }

    process.stdout.write('compute_token_key_separation_test: PASS\n');
  } finally {
    try { await app?.close(); } catch (_) {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`compute_token_key_separation_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
