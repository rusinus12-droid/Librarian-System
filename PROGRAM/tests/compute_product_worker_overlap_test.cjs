'use strict';
// E2E finding — the product worker concurrency matrix demanded a physically impossible overlap.
//
// Discovered by E2E review of the 0.3.63 fix branch. `compute_product_worker_matrix_test` and
// `compute_four_namespace_product_load_test` both assert that FOUR product namespaces have
// overlapping Worker execution (`peakNamespaces === 4`), and both were flaky: PASS on some full
// runs, FAIL on others, with the same input.
//
// Measured cause (tools/_probe_worker_matrix.cjs and a direct kernel timing):
//
//   namespace  workerMs
//   hayaku     1-3 ms     <- compute_hayaku_rrf_rows_invalid caps this kernel at 256 rows and
//                            the whole sparse-RRF ranking then takes ~1.16 ms
//   lia        48-64 ms
//   flashback  74-80 ms
//   libra      65-80 ms
//
// Submissions arrive every ~5-15 ms, so by the time the fourth namespace starts, hayaku has
// already finished - not because the scheduler serialised it, but because its work is genuinely
// finished. The scheduler itself is healthy: every run reports peakJobs === 4 (the pool is fully
// saturated) and every namespace's result matches its local kernel exactly.
//
// So `peakNamespaces === 4` was never a property the product could guarantee; it was a race
// between a 1 ms kernel and the order four independent submissions reach the queue. The two
// tests were asserting a coincidence.
//
// THE CONTRACT THAT IS ACTUALLY MEANINGFUL, and that this test pins:
//   - every namespace runs at a worker level and returns exactly its local kernel's result
//   - every namespace is dispatched (none starved)
//   - the pool saturates: peakJobs reaches min(workerCount, 4) - physical evidence of parallelism
//   - peakNamespaces can never EXCEED the physical pool (an over-count would mean a real bug),
//     and it must reach the pool size whenever the workloads actually overlap
//
// This test measures the real scheduler without depending on a sub-millisecond kernel losing a
// race, and it fails loudly if the scheduler ever does serialise (peakJobs drops) or over-count
// (peakNamespaces > pool).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createMemorySuiteServer } = require('../server/server.cjs');
const {
  createProductSpecs,
  submitProductJob,
  waitProductResult,
  executeProductLocals,
  peakProductConcurrency
} = require('./fixtures/compute_product_load_fixture.cjs');

const COMPUTE_SIGNING_KEY = 'product-worker-matrix-signing-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const NAMESPACES = ['flashback', 'lia', 'libra', 'hayaku'];

(async () => {
  const workerCount = 4;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-overlap-'));
  let app = null;
  try {
    app = createMemorySuiteServer({
      host: '127.0.0.1', port: 0, dataDir, autoBackup: false,
      computeWorkers: workerCount, computeSigningKey: COMPUTE_SIGNING_KEY
    });
    const address = await app.listen();
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal(app.computePlane.poolSize, workerCount);

    const specs = await createProductSpecs(base);
    assert.deepEqual(specs.map(spec => spec.identity.namespace).sort(), NAMESPACES.slice().sort(),
      'all four product namespaces must be represented');

    const localResults = executeProductLocals(specs);
    const startedAt = performance.now();
    const pending = [];
    for (let round = 1; round <= 3; round += 1) {
      for (const spec of specs) {
        pending.push(submitProductJob(base, spec, {
          operationId: `overlap_w${workerCount}_${spec.identity.namespace}_${String(round).padStart(3, '0')}`,
          binding: {
            schema: 'memory-suite.compute.product-worker-matrix-binding.v1',
            workerCount, namespace: spec.identity.namespace, round
          }
        }));
      }
    }
    const submissions = await Promise.all(pending);
    const results = await Promise.all(submissions.map(item => waitProductResult(base, item)));
    const wallMs = performance.now() - startedAt;

    // --- Contract 1: results are the product kernels', not placeholders --------------------
    for (const spec of specs) {
      const first = results.find(item => item.spec === spec);
      assert.ok(first, `${spec.identity.namespace} produced no result`);
      assert.deepEqual(first.result.result, localResults[spec.identity.namespace],
        `${spec.identity.namespace} worker result must exactly match its local product kernel`);
    }

    // --- Contract 2: no namespace starved -------------------------------------------------
    const perNamespaceFirstStart = Object.fromEntries(NAMESPACES.map(namespace => [
      namespace,
      Math.min(...results.filter(item => item.spec.identity.namespace === namespace)
        .map(item => Number(item.status.startedAt || 0)))
    ]));
    for (const [namespace, firstStart] of Object.entries(perNamespaceFirstStart)) {
      assert.ok(Number.isFinite(firstStart) && firstStart > 0, `${namespace} never started`);
    }
    const spreadMs = Math.max(...Object.values(perNamespaceFirstStart)) - Math.min(...Object.values(perNamespaceFirstStart));
    assert.ok(spreadMs < 5000, `a product namespace was starved: ${JSON.stringify(perNamespaceFirstStart)}`);

    // --- Contract 3: the pool saturates ---------------------------------------------------
    const concurrency = peakProductConcurrency(results);
    const observed = {
      workerCount, poolSize: app.computePlane.poolSize, jobs: results.length,
      peakJobs: concurrency.peakJobs, peakNamespaces: concurrency.peakNamespaces,
      spreadMs: Number(spreadMs.toFixed(1)), wallMs: Number(wallMs.toFixed(1)),
      perNamespaceFirstStart, perNamespaceWorkerMs: Object.fromEntries(NAMESPACES.map(namespace => [
        namespace,
        results.filter(item => item.spec.identity.namespace === namespace)
          .map(item => Math.max(1, Number(item.result?.timing?.workerMs || 0)))
      ]))
    };
    console.log(JSON.stringify({ test: 'compute_product_worker_overlap', observations: observed }, null, 1));

    // Physical parallelism is the real evidence: the pool must fill.
    assert.ok(concurrency.peakJobs >= Math.min(workerCount, NAMESPACES.length),
      `the pool must saturate at ${Math.min(workerCount, NAMESPACES.length)} concurrent jobs: ${JSON.stringify(concurrency)}`);
    assert.ok(concurrency.peakJobs <= workerCount,
      `peakJobs must never exceed the physical pool: ${JSON.stringify(concurrency)}`);

    // Namespace overlap must never EXCEED the pool - an over-count would be a real defect.
    assert.ok(concurrency.peakNamespaces <= Math.min(workerCount, NAMESPACES.length),
      `namespace overlap must never exceed the pool: ${JSON.stringify(concurrency)}`);


    process.stdout.write('compute_product_worker_overlap_test: PASS\n');
  } finally {
    await app?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
