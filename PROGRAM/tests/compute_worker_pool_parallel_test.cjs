'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');

const COMPUTE_SIGNING_KEY = 'parallel-compute-signing-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const raw = await response.text();
  return { response, payload: raw ? JSON.parse(raw) : {} };
}

async function computeIdentity(base, pluginId) {
  const bootstrap = await jsonFetch(`${base}/v1/compute/bootstrap`, {
    method: 'POST',
    headers: { 'X-Memory-Suite-Plugin': pluginId }
  });
  assert.equal(bootstrap.response.status, 200, JSON.stringify(bootstrap.payload));
  const spin = bootstrap.payload.operations.find(item => item.operation === 'memory-suite.test.spin.v1');
  assert.ok(spin);
  return {
    namespace: bootstrap.payload.authorization.namespace,
    fingerprint: spin.algorithmFingerprint,
    headers: {
      Authorization: `Bearer ${bootstrap.payload.token}`,
      'X-Memory-Suite-Plugin': pluginId,
      'Content-Type': 'application/json'
    }
  };
}

async function submit(base, identity, operationId, durationMs, lane = 'interactive') {
  const result = await jsonFetch(`${base}/v1/compute/jobs`, {
    method: 'POST', headers: identity.headers,
    body: JSON.stringify({
      namespace: identity.namespace,
      operation: 'memory-suite.test.spin.v1',
      operationId,
      algorithmFingerprint: identity.fingerprint,
      input: { durationMs },
      lane,
      deadlineMs: 4000
    })
  });
  assert.equal(result.response.status, 202, JSON.stringify(result.payload));
  return result.payload.result.jobId;
}

async function waitResult(base, identity, jobId) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const status = await jsonFetch(`${base}/v1/compute/jobs/${jobId}`, { headers: identity.headers });
    assert.equal(status.response.status, 200, JSON.stringify(status.payload));
    if (status.payload.result.state === 'succeeded') {
      const result = await jsonFetch(`${base}/v1/compute/jobs/${jobId}/result`, { headers: identity.headers });
      assert.equal(result.response.status, 200, JSON.stringify(result.payload));
      return result.payload.result;
    }
    if (['failed', 'cancelled', 'expired'].includes(status.payload.result.state)) {
      throw new Error(`job_terminal_failure:${jobId}:${JSON.stringify(status.payload.result)}`);
    }
    await delay(15);
  }
  throw new Error(`job_timeout:${jobId}`);
}

async function waitState(base, identity, jobId, expectedState) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const status = await jsonFetch(`${base}/v1/compute/jobs/${jobId}`, { headers: identity.headers });
    assert.equal(status.response.status, 200, JSON.stringify(status.payload));
    if (status.payload.result.state === expectedState) return status.payload.result;
    await delay(10);
  }
  throw new Error(`job_state_timeout:${jobId}:${expectedState}`);
}

async function withServer(workerCount, callback, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `memory-suite-compute-parallel-${workerCount}-`));
  const app = createMemorySuiteServer({
    host: '127.0.0.1', port: 0, dataDir, autoBackup: false,
    computeWorkers: workerCount, computeSigningKey: COMPUTE_SIGNING_KEY, allowComputeTestOperations: true,
    ...options
  });
  const address = await app.listen();
  try { await callback(`http://127.0.0.1:${address.port}`, app); }
  finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  await withServer(4, async base => {
    const retired = await jsonFetch(`${base}/v1/compute/bootstrap`, {method:'POST',headers:{'X-Memory-Suite-Plugin':'lia_persona_linker'}});
    assert.equal(retired.response.status,403);assert.equal(retired.payload.code,'COMPUTE_OWNER_PLUGIN_REQUIRED');
    // Keep four simultaneous jobs while honoring the three current owner roles.
    const specs = [
      ['flashback_memory', 'parallel_flashback_000001'],
      ['hayaku_locator_continuity', 'parallel_hayaku_000000001'],
      ['libra', 'parallel_libra_0000000001'],
      ['flashback_memory', 'parallel_flashback_000002']
    ];
    const identities = await Promise.all(specs.map(([pluginId]) => computeIdentity(base, pluginId)));
    const storageBootstrap = await jsonFetch(`${base}/bootstrap`, {
      headers: { 'X-Memory-Suite-Plugin': 'flashback_memory' }
    });
    assert.equal(storageBootstrap.response.status, 200, JSON.stringify(storageBootstrap.payload));
    const storageHeaders = {
      Authorization: `Bearer ${storageBootstrap.payload.token}`,
      'X-Memory-Suite-Plugin': 'flashback_memory',
      'Content-Type': 'application/json'
    };
    const jobIds = await Promise.all(identities.map((identity, index) => submit(base, identity, specs[index][1], 700)));
    await Promise.all(identities.map((identity, index) => waitState(base, identity, jobIds[index], 'running')));

    const [health, storageSet] = await Promise.all([
      jsonFetch(`${base}/health`),
      jsonFetch(`${base}/v1/kv/set`, {
        method: 'POST', headers: storageHeaders,
        body: JSON.stringify({
          namespace: 'flashback', space: 'plugin', key: 'flashback:compute-saturation:storage-alive',
          operationId: 'compute_saturation_storage_0001', value: { alive: true }, expectedRevision: 0
        })
      })
    ]);
    assert.equal(health.response.status, 200);
    assert.equal(storageSet.response.status, 200, JSON.stringify(storageSet.payload));
    const storageGet = await jsonFetch(`${base}/v1/kv/get?namespace=flashback&space=plugin&key=flashback%3Acompute-saturation%3Astorage-alive`, {
      headers: storageHeaders
    });
    assert.equal(storageGet.response.status, 200, JSON.stringify(storageGet.payload));
    assert.deepEqual(storageGet.payload.result.value, { alive: true });
    const barrierStates = await Promise.all(identities.map((identity, index) => (
      jsonFetch(`${base}/v1/compute/jobs/${jobIds[index]}`, { headers: identity.headers })
    )));
    assert.ok(barrierStates.some(status => status.payload.result.state === 'running'),
      'health and KV roundtrip must finish while the worker pool is still saturated');

    const results = await Promise.all(identities.map((identity, index) => waitResult(base, identity, jobIds[index])));
    const intervals = results.map(result => result.result);
    assert.ok(Math.max(...intervals.map(item => item.startedAt)) < Math.min(...intervals.map(item => item.completedAt)),
      `four jobs across three current owners must overlap: ${JSON.stringify(intervals)}`);
    assert.equal(new Set(intervals.map(item => item.startedAt)).size > 1, true);
  });

  await withServer(2, async base => {
    const hayaku = await computeIdentity(base, 'hayaku_locator_continuity');
    const flashback = await computeIdentity(base, 'flashback_memory');
    const firstMaintenance = await submit(base, hayaku, 'fair_maintenance_first_0001', 300, 'maintenance');
    const secondMaintenance = await submit(base, hayaku, 'fair_maintenance_second_001', 100, 'maintenance');
    const interactive = await submit(base, flashback, 'fair_interactive_flash_0001', 60, 'interactive');
    const [first, second, foreground] = await Promise.all([
      waitResult(base, hayaku, firstMaintenance),
      waitResult(base, hayaku, secondMaintenance),
      waitResult(base, flashback, interactive)
    ]);
    assert.ok(foreground.result.startedAt < first.result.completedAt, 'interactive job must use the reserved worker while maintenance runs');
    assert.ok(second.result.startedAt >= first.result.completedAt, 'maintenance lane must not occupy the reserved worker');
  });

  await withServer(1, async base => {
    const flashback = await computeIdentity(base, 'flashback_memory');
    const active = await submit(base, flashback, 'priority_admission_active_0001', 700, 'maintenance');
    await waitState(base, flashback, active, 'running');
    const backlog = [];
    for (let index = 0; index < 24; index += 1) {
      backlog.push(await submit(base, flashback, `priority_admission_backlog_${String(index).padStart(4, '0')}`, 20, 'maintenance'));
    }
    const interactive = await jsonFetch(`${base}/v1/compute/jobs`, {
      method: 'POST', headers: flashback.headers,
      body: JSON.stringify({
        namespace: flashback.namespace,
        operation: 'memory-suite.test.spin.v1',
        operationId: 'priority_admission_interactive_001',
        algorithmFingerprint: flashback.fingerprint,
        input: { durationMs: 20 }, lane: 'interactive', deadlineMs: 900
      })
    });
    assert.equal(interactive.response.status, 202, JSON.stringify(interactive.payload));
    const foreground = await waitResult(base, flashback, interactive.payload.result.jobId);
    assert.ok(foreground.result.startedAt >= (await waitResult(base, flashback, active)).result.completedAt);
    const backlogResults = await Promise.all(backlog.map(jobId => waitResult(base, flashback, jobId)));
    assert.ok(foreground.result.startedAt <= Math.min(...backlogResults.map(result => result.result.startedAt)),
      'lower-priority backlog must not reject or start ahead of the admitted interactive job');
  });

  await withServer(1, async base => {
    const flashback = await computeIdentity(base, 'flashback_memory');
    const activeJobId = await submit(base, flashback, 'fallback_active_spin_000001', 600, 'background');
    await waitState(base, flashback, activeJobId, 'running');

    const deadline = await jsonFetch(`${base}/v1/compute/execute`, {
      method: 'POST', headers: flashback.headers,
      body: JSON.stringify({
        namespace: flashback.namespace,
        operation: 'memory-suite.test.spin.v1',
        operationId: 'fallback_deadline_spin_0001',
        algorithmFingerprint: flashback.fingerprint,
        input: { durationMs: 25 }, lane: 'interactive', deadlineMs: 25
      })
    });
    assert.equal(deadline.response.status, 429, JSON.stringify(deadline.payload));
    assert.equal(deadline.payload.code, 'COMPUTE_DEADLINE_WOULD_EXPIRE');
    assert.equal(deadline.payload.fallback?.recommended, 'local');

    const queuedJobId = await submit(base, flashback, 'fallback_queued_spin_000001', 100, 'background');
    await waitState(base, flashback, queuedJobId, 'queued');
    const overloaded = await jsonFetch(`${base}/v1/compute/jobs`, {
      method: 'POST', headers: flashback.headers,
      body: JSON.stringify({
        namespace: flashback.namespace,
        operation: 'memory-suite.test.spin.v1',
        operationId: 'fallback_overload_spin_001',
        algorithmFingerprint: flashback.fingerprint,
        input: { durationMs: 100 }, lane: 'background', deadlineMs: 4000
      })
    });
    assert.equal(overloaded.response.status, 429, JSON.stringify(overloaded.payload));
    assert.equal(overloaded.payload.code, 'COMPUTE_OVERLOADED');
    assert.equal(overloaded.payload.fallback?.recommended, 'local');

    const activeCancel = await jsonFetch(`${base}/v1/compute/jobs/${activeJobId}/cancel`, { method: 'POST', headers: flashback.headers });
    const queuedCancel = await jsonFetch(`${base}/v1/compute/jobs/${queuedJobId}/cancel`, { method: 'POST', headers: flashback.headers });
    assert.equal(activeCancel.payload.result.cancelAccepted, true);
    assert.equal(queuedCancel.payload.result.cancelAccepted, true);
  }, { computeLimits: { maxQueueJobs: 1 } });

  process.stdout.write('compute_worker_pool_parallel_test: PASS\n');
}

main().catch(error => {
  process.stderr.write(`compute_worker_pool_parallel_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
