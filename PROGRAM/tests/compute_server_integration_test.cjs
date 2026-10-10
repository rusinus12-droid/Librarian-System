'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { digestJson } = require('../server/compute/contracts.cjs');

const { repositoryDigest: fileDigest } = require('./fixtures/compute_product_load_fixture.cjs'); // Include exact missing retired SQLite/WAL state.

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch (_) { throw new Error(`invalid_json:${response.status}:${raw.slice(0, 200)}`); }
  return { response, payload };
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-compute-server-'));
  const app = createMemorySuiteServer({
    host: '127.0.0.1', port: 0, dataDir, autoBackup: false,
    computeWorkers: 1, allowComputeTestOperations: true
  });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(path.resolve(app.computeSigningKeyPath), path.resolve(dataDir, 'config', 'compute-signing-key.txt'));
    assert.ok(fs.readFileSync(app.computeSigningKeyPath, 'utf8').trim().length >= 32);

    const health = await jsonFetch(`${base}/health`);
    assert.equal(health.response.status, 200);
    assert.equal(health.payload.compute.ready, true);
    assert.equal(health.payload.compute.pool.size, 1);

    const preflight = await fetch(`${base}/v1/compute/bootstrap`, {
      method: 'OPTIONS',
      headers: { Origin: 'null', 'Access-Control-Request-Headers': 'X-Memory-Suite-Plugin' }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
    assert.doesNotMatch(preflight.headers.get('access-control-allow-headers') || '', /X-Memory-Suite-Compute-Pairing/i);
    const remotePreflight = await fetch(`${base}/v1/compute/bootstrap`, { method: 'OPTIONS', headers: { Origin: 'https://example.invalid' } });
    assert.equal(remotePreflight.headers.get('access-control-allow-origin'), null);

    const unofficialPlugin = await jsonFetch(`${base}/v1/compute/bootstrap`, {
      method: 'POST',
      headers: { 'X-Memory-Suite-Plugin': 'not_an_official_owner' }
    });
    assert.equal(unofficialPlugin.response.status, 403);
    assert.equal(unofficialPlugin.payload.code, 'COMPUTE_OWNER_PLUGIN_REQUIRED');

    const computeBootstrap = await jsonFetch(`${base}/v1/compute/bootstrap`, {
      method: 'POST',
      headers: { 'X-Memory-Suite-Plugin': 'flashback_memory', 'X-Memory-Suite-Plugin-Version': 'test' },
      body: JSON.stringify({ namespace: 'flashback' })
    });
    assert.equal(computeBootstrap.response.status, 200, JSON.stringify(computeBootstrap.payload));
    assert.equal(computeBootstrap.payload.schema, 'memory-suite.compute.bootstrap.v1');
    assert.equal(computeBootstrap.payload.authorization.namespace, 'flashback');
    assert.deepEqual(computeBootstrap.payload.authorization.roles, ['compute']);
    assert.notEqual(computeBootstrap.payload.token, app.token);
    assert.equal(computeBootstrap.payload.capabilities['compute.v1'], true);
    const hashCapability = computeBootstrap.payload.operations.find(item => item.operation === 'flashback.hash-embedding-batch.v1');
    const spinCapability = computeBootstrap.payload.operations.find(item => item.operation === 'memory-suite.test.spin.v1');
    assert.ok(hashCapability?.algorithmFingerprint);
    assert.ok(spinCapability?.algorithmFingerprint);

    const storageBootstrap = await jsonFetch(`${base}/bootstrap`, {
      headers: { 'X-Memory-Suite-Plugin': 'flashback_memory', 'X-Memory-Suite-Plugin-Version': 'test' }
    });
    assert.equal(storageBootstrap.response.status, 200);
    assert.equal(storageBootstrap.payload.capabilities['compute.v1'], true);
    assert.equal(storageBootstrap.payload.capabilities['compute-auto-bootstrap.v1'], true);

    const computeHeaders = {
      Authorization: `Bearer ${computeBootstrap.payload.token}`,
      'X-Memory-Suite-Plugin': 'flashback_memory',
      'X-Memory-Suite-Plugin-Version': 'test',
      'Content-Type': 'application/json'
    };
    const storageTokenDenied = await jsonFetch(`${base}/v1/compute/capabilities`, {
      headers: { Authorization: `Bearer ${storageBootstrap.payload.token}`, 'X-Memory-Suite-Plugin': 'flashback_memory' }
    });
    assert.equal(storageTokenDenied.response.status, 403, 'storage token must not authorize compute');

    const computeStorageReadDenied = await jsonFetch(`${base}/v1/kv/get?namespace=flashback&space=plugin&key=flashback%3Acompute%3Aisolation`, {
      headers: { Authorization: `Bearer ${computeBootstrap.payload.token}`, 'X-Memory-Suite-Plugin': 'flashback_memory' }
    });
    assert.equal(computeStorageReadDenied.response.status, 403, 'compute token must not authorize storage reads');
    const computeStorageWriteDenied = await jsonFetch(`${base}/v1/kv/set`, {
      method: 'POST', headers: computeHeaders,
      body: JSON.stringify({ namespace: 'flashback', space: 'plugin', key: 'flashback:compute:isolation', value: { forbidden: true } })
    });
    assert.equal(computeStorageWriteDenied.response.status, 403, 'compute token must not authorize storage writes');

    const capabilities = await jsonFetch(`${base}/v1/compute/capabilities`, { headers: computeHeaders });
    assert.equal(capabilities.response.status, 200);
    assert.equal(capabilities.payload.result.durability, 'memory_only');

    const canonicalBefore = Object.fromEntries(Object.entries(app.repositories).map(([namespace, repository]) => [namespace, fileDigest(repository.filePath)]));
    const input = { texts: ['hello memory', '기억 회상'], dimensions: 64 };
    const executeBody = {
      namespace: 'flashback',
      operation: 'flashback.hash-embedding-batch.v1',
      operationId: 'compute_hash_execute_000001',
      algorithmFingerprint: hashCapability.algorithmFingerprint,
      input,
      inputDigest: digestJson(input),
      binding: { scopeId: 'scope-a', branchId: 'branch-a', revision: 7, sourceDigest: 'source-a' },
      lane: 'interactive',
      deadlineMs: 5000
    };
    const execute = await jsonFetch(`${base}/v1/compute/execute`, { method: 'POST', headers: computeHeaders, body: JSON.stringify(executeBody) });
    assert.equal(execute.response.status, 200, JSON.stringify(execute.payload));
    assert.equal(execute.payload.schema, 'memory-suite.compute.execute-response.v1');
    assert.equal(execute.payload.result.inputDigest, digestJson(input));
    assert.deepEqual(execute.payload.result.binding, executeBody.binding);
    assert.equal(execute.payload.result.result.vectors.length, 2);
    assert.equal(execute.payload.result.result.vectors[0].length, 64);
    assert.equal(execute.payload.result.resultDigest, digestJson(execute.payload.result.result));

    const replay = await jsonFetch(`${base}/v1/compute/execute`, { method: 'POST', headers: computeHeaders, body: JSON.stringify(executeBody) });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.payload.result.jobId, execute.payload.result.jobId, 'same operation/input must reuse its receipt');
    const conflict = await jsonFetch(`${base}/v1/compute/execute`, {
      method: 'POST', headers: computeHeaders,
      body: JSON.stringify({ ...executeBody, input: { texts: ['changed'], dimensions: 64 }, inputDigest: undefined })
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.payload.code, 'COMPUTE_OPERATION_ID_PAYLOAD_CONFLICT');
    assert.equal(conflict.payload.fallback?.recommended, 'local');

    const crossNamespace = await jsonFetch(`${base}/v1/compute/execute`, {
      method: 'POST', headers: computeHeaders,
      body: JSON.stringify({ ...executeBody, namespace: 'libra', operationId: 'compute_cross_namespace_0001' })
    });
    assert.equal(crossNamespace.response.status, 403);

    const firstSpinBody = {
      namespace: 'flashback', operation: 'memory-suite.test.spin.v1', operationId: 'compute_spin_first_000001',
      algorithmFingerprint: spinCapability.algorithmFingerprint, input: { durationMs: 250 }, lane: 'background', deadlineMs: 2000
    };
    const secondSpinBody = { ...firstSpinBody, operationId: 'compute_spin_second_00001', input: { durationMs: 100 } };
    const firstSpin = await jsonFetch(`${base}/v1/compute/jobs`, { method: 'POST', headers: computeHeaders, body: JSON.stringify(firstSpinBody) });
    const secondSpin = await jsonFetch(`${base}/v1/compute/jobs`, { method: 'POST', headers: computeHeaders, body: JSON.stringify(secondSpinBody) });
    assert.equal(firstSpin.response.status, 202);
    assert.equal(secondSpin.response.status, 202);
    const cancel = await jsonFetch(`${base}/v1/compute/jobs/${secondSpin.payload.result.jobId}/cancel`, { method: 'POST', headers: computeHeaders });
    assert.equal(cancel.response.status, 200);
    assert.equal(cancel.payload.result.cancelAccepted, true);
    const cancelledStatus = await jsonFetch(`${base}/v1/compute/jobs/${secondSpin.payload.result.jobId}`, { headers: computeHeaders });
    assert.equal(cancelledStatus.payload.result.state, 'cancelled');

    const firstResult = await jsonFetch(`${base}/v1/compute/jobs/${firstSpin.payload.result.jobId}/result`, { headers: computeHeaders });
    if (firstResult.response.status === 425) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    const finalFirstResult = firstResult.response.status === 425
      ? await jsonFetch(`${base}/v1/compute/jobs/${firstSpin.payload.result.jobId}/result`, { headers: computeHeaders })
      : firstResult;
    assert.equal(finalFirstResult.response.status, 200, JSON.stringify(finalFirstResult.payload));
    assert.equal(finalFirstResult.payload.result.result.durationMs, 250);

    const abortController = new AbortController();
    const disconnectedOperationId = 'compute_disconnected_execute_001';
    const disconnected = fetch(`${base}/v1/compute/execute`, {
      method: 'POST', headers: computeHeaders, signal: abortController.signal,
      body: JSON.stringify({
        ...firstSpinBody,
        operationId: disconnectedOperationId,
        input: { durationMs: 1000 },
        lane: 'interactive'
      })
    }).catch(error => error);
    let disconnectedJob = null;
    const acceptDeadline = Date.now() + 1000;
    while (Date.now() < acceptDeadline && !disconnectedJob) {
      disconnectedJob = Array.from(app.computePlane.jobs.values()).find(job => job.operationId === disconnectedOperationId) || null;
      if (!disconnectedJob) await delay(10);
    }
    assert.ok(disconnectedJob, 'direct execute must be admitted before disconnect cancellation');
    abortController.abort();
    const disconnectedOutcome = await disconnected;
    assert.equal(disconnectedOutcome?.name, 'AbortError');
    const cancelDeadline = Date.now() + 1000;
    while (Date.now() < cancelDeadline && disconnectedJob.state === 'running') await delay(10);
    assert.equal(disconnectedJob.state, 'cancelled', 'client disconnect must cancel its running direct Compute job');

    const canonicalAfter = Object.fromEntries(Object.entries(app.repositories).map(([namespace, repository]) => [namespace, fileDigest(repository.filePath)]));
    assert.deepEqual(canonicalAfter, canonicalBefore, 'compute must not write any canonical namespace database');

    process.stdout.write('compute_server_integration_test: PASS\n');
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`compute_server_integration_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
