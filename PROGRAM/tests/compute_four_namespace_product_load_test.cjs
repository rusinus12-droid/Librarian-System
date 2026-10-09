'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createMemorySuiteServer } = require('../server/server.cjs');
const {
  repositoryDigest,
  jsonFetch,
  submitProductJob,
  waitProductResult,
  createProductSpecs,
  executeProductLocals,
  peakProductConcurrency,
  summarizeProductResults
} = require('./fixtures/compute_product_load_fixture.cjs');

const COMPUTE_SIGNING_KEY = 'four-namespace-product-load-signing-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function waitForFirstWorkerStart(app, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      app.computePlane.pool.off('taskStarted', onStarted);
      if (error) reject(error);
      else resolve(value);
    };
    const onStarted = event => finish(null, { ...event, observedAt: Date.now() });
    const timer = setTimeout(() => finish(new Error('product_load_never_started_a_worker')), timeoutMs);
    app.computePlane.pool.on('taskStarted', onStarted);
  });
}

async function main() {
  const tempRoot = path.resolve(os.tmpdir());
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'memory-suite-four-namespace-load-'));
  assert.equal(path.dirname(dataDir), tempRoot);
  const app = createMemorySuiteServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    autoBackup: false,
    computeWorkers: 4,
    computeSigningKey: COMPUTE_SIGNING_KEY
  });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const specs = await createProductSpecs(base);
    assert.equal(specs.some(spec => spec.identity.operation.startsWith('memory-suite.test.')), false,
      'the fixture must execute only product operations');

    const localStartedAt = performance.now();
    const localResults = executeProductLocals(specs);
    const localSerialMs = performance.now() - localStartedAt;

    const storageBootstrap = await jsonFetch(`${base}/bootstrap`, {
      headers: { 'X-Memory-Suite-Plugin': 'flashback_memory' }
    });
    assert.equal(storageBootstrap.response.status, 200, JSON.stringify(storageBootstrap.payload));
    const storageHeaders = {
      Authorization: `Bearer ${storageBootstrap.payload.token}`,
      'X-Memory-Suite-Plugin': 'flashback_memory',
      'Content-Type': 'application/json'
    };
    const storageSet = await jsonFetch(`${base}/v1/kv/set`, {
      method: 'POST',
      headers: storageHeaders,
      body: JSON.stringify({
        namespace: 'flashback',
        space: 'plugin',
        key: 'flashback:four-namespace-load:storage-alive',
        operationId: 'four_namespace_storage_0001',
        value: { alive: true },
        expectedRevision: 0
      })
    });
    assert.equal(storageSet.response.status, 200, JSON.stringify(storageSet.payload));
    const canonicalBefore = Object.fromEntries(Object.entries(app.repositories)
      .map(([namespace, repository]) => [namespace, repositoryDigest(repository.filePath)]));

    const serverStartedAt = performance.now();
    // Start the storage probe from the Worker's synchronous taskStarted event.
    // A timer-only poll can miss the short active+queued window on very fast hosts
    // because large request JSON parsing and Worker completion messages share the
    // same event loop. The event proves that the probe was issued during real
    // product execution without weakening the later timestamp-concurrency checks.
    const firstWorkerStart = waitForFirstWorkerStart(app);
    const storageProbe = firstWorkerStart.then(async workerStart => {
      const startedEpochMs = Date.now();
      const startedAt = performance.now();
      const [health, storageGet] = await Promise.all([
        jsonFetch(`${base}/health`),
        jsonFetch(`${base}/v1/kv/get?namespace=flashback&space=plugin&key=flashback%3Afour-namespace-load%3Astorage-alive`, {
          headers: storageHeaders
        })
      ]);
      return {
        workerStart,
        startedEpochMs,
        completedEpochMs: Date.now(),
        roundtripMs: performance.now() - startedAt,
        health,
        storageGet
      };
    });

    const submissionPromises = [];
    for (let round = 1; round <= 3; round += 1) {
      for (const spec of specs) {
        submissionPromises.push(submitProductJob(base, spec, {
          operationId: `fourload_${spec.identity.namespace}_${String(round).padStart(4, '0')}`,
          binding: {
            schema: 'memory-suite.compute.four-namespace-load-binding.v1',
            namespace: spec.identity.namespace,
            round
          }
        }));
      }
    }
    const [submissions, storageObservation] = await Promise.all([
      Promise.all(submissionPromises),
      storageProbe
    ]);
    const { health, storageGet } = storageObservation;
    assert.equal(health.response.status, 200, JSON.stringify(health.payload));
    assert.equal(storageGet.response.status, 200, JSON.stringify(storageGet.payload));
    assert.deepEqual(storageGet.payload.result.value, { alive: true });
    const storageRoundtripMs = storageObservation.roundtripMs;
    assert.ok(storageRoundtripMs < 5000, `storage roundtrip stalled under product compute load: ${storageRoundtripMs}ms`);

    const results = await Promise.all(submissions.map(item => waitProductResult(base, item)));
    const storageOverlaps = results.filter(item => (
      Number(item.status.startedAt || 0) <= storageObservation.completedEpochMs
      && Number(item.status.completedAt || Number.POSITIVE_INFINITY) >= storageObservation.startedEpochMs
    ));
    assert.ok(storageOverlaps.length >= 1,
      `storage probe did not overlap a product Worker interval: ${JSON.stringify({ storageObservation, intervals: results.map(item => ({ namespace: item.spec.identity.namespace, startedAt: item.status.startedAt, completedAt: item.status.completedAt })) })}`);
    const serverWallMs = performance.now() - serverStartedAt;
    assert.equal(results.length, 12);
    assert.equal(new Set(results.map(item => item.spec.identity.namespace)).size, 4);
    for (const spec of specs) {
      const first = results.find(item => item.spec === spec);
      assert.ok(first);
      assert.deepEqual(first.result.result, localResults[spec.identity.namespace],
        `${spec.identity.namespace} Worker result must exactly match its local product kernel`);
    }

    const concurrency = peakProductConcurrency(results);
    // The physical proof of parallelism is peakJobs: the pool must fill. `peakNamespaces` is not
    // stable here for the same measured reason as compute_product_worker_matrix_test - the hayaku
    // kernel is a 256-row sparse-RRF ranking (the registry caps it at 256 by construction) that
    // finishes in ~1.16 ms, so it can complete before the fourth namespace is dispatched. Measured
    // over 10 runs: PASS 3 times, FAIL 7 times with the identical input. Asserting equality on
    // that was asserting a race between a 1 ms kernel and four independent submissions.
    assert.ok(concurrency.peakJobs >= 4, `four workers did not overlap: ${JSON.stringify(concurrency)}`);
    assert.ok(concurrency.peakNamespaces <= 4,
      `namespace overlap must never exceed the pool: ${JSON.stringify(concurrency)}`);
    assert.ok(concurrency.peakNamespaces >= 1,
      `no namespace overlap was observed at all: ${JSON.stringify(concurrency)}`);
    const firstStarts = specs.map(spec => Math.min(...results
      .filter(item => item.spec === spec)
      .map(item => item.status.startedAt)));
    assert.ok(Math.max(...firstStarts) - Math.min(...firstStarts) < 5000,
      `a product namespace was starved: ${JSON.stringify(firstStarts)}`);

    const canonicalAfter = Object.fromEntries(Object.entries(app.repositories)
      .map(([namespace, repository]) => [namespace, repositoryDigest(repository.filePath)]));
    assert.deepEqual(canonicalAfter, canonicalBefore, 'product Compute load must not mutate canonical namespace databases');

    const metrics = {
      schema: 'memory-suite.compute.four-namespace-load-report.v1',
      workers: 4,
      rounds: 3,
      jobs: results.length,
      ...concurrency,
      localSerialMs: Number(localSerialMs.toFixed(2)),
      serialEquivalentMs: Number((localSerialMs * 3).toFixed(2)),
      serverWallMs: Number(serverWallMs.toFixed(2)),
      observedThroughputFactor: Number(((localSerialMs * 3) / serverWallMs).toFixed(3)),
      storageRoundtripMs: Number(storageRoundtripMs.toFixed(2)),
      namespaces: summarizeProductResults(results)
    };
    process.stdout.write(`compute_four_namespace_product_load_test: PASS ${JSON.stringify(metrics)}\n`);
  } finally {
    await app.close();
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), tempRoot);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`compute_four_namespace_product_load_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
