'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createMemorySuiteServer } = require('../server/server.cjs');
const {
  repositoryDigest,
  submitProductJob,
  waitProductResult,
  createProductSpecs,
  executeProductLocals,
  peakProductConcurrency,
  summarizeProductResults
} = require('./fixtures/compute_product_load_fixture.cjs');

const COMPUTE_SIGNING_KEY = 'product-worker-matrix-signing-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MIB = 1024 * 1024;

async function runMatrixCell(workerCount) {
  const tempRoot = path.resolve(os.tmpdir());
  const dataDir = fs.mkdtempSync(path.join(tempRoot, `memory-suite-product-matrix-${workerCount}-`));
  assert.equal(path.dirname(dataDir), tempRoot);
  const rssBaseline = process.memoryUsage().rss;
  let rssPeak = rssBaseline;
  let sampler = null;
  let app = null;
  try {
    sampler = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 5);
    app = createMemorySuiteServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      autoBackup: false,
      computeWorkers: workerCount,
      computeSigningKey: COMPUTE_SIGNING_KEY
    });
    const address = await app.listen();
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal(app.computePlane.poolSize, workerCount);
    const specs = await createProductSpecs(base);
    const localStartedAt = performance.now();
    const localResults = executeProductLocals(specs);
    const localSerialMs = performance.now() - localStartedAt;
    const canonicalBefore = Object.fromEntries(Object.entries(app.repositories)
      .map(([namespace, repository]) => [namespace, repositoryDigest(repository.filePath)]));
    const startedAt = performance.now();
    const pending = [];
    for (let round = 1; round <= 3; round += 1) {
      for (const spec of specs) {
        pending.push(submitProductJob(base, spec, {
          operationId: `matrix_w${workerCount}_${spec.identity.namespace}_${String(round).padStart(3, '0')}`,
          binding: {
            schema: 'memory-suite.compute.product-worker-matrix-binding.v1',
            workerCount,
            namespace: spec.identity.namespace,
            round
          }
        }));
      }
    }
    const submissions = await Promise.all(pending);
    const results = await Promise.all(submissions.map(item => waitProductResult(base, item)));
    const wallMs = performance.now() - startedAt;
    clearInterval(sampler);
    sampler = null;
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);

    for (const spec of specs) {
      const first = results.find(item => item.spec === spec);
      assert.ok(first);
      assert.deepEqual(first.result.result, localResults[spec.identity.namespace],
        `${spec.identity.namespace} worker=${workerCount} result differs from local`);
    }
    const concurrency = peakProductConcurrency(results);
    // The pool must fill (peakJobs) - that is the physical proof of parallelism and it is stable
    // across runs. `peakNamespaces` is NOT stable: the hayaku kernel is a 256-row sparse-RRF
    // ranking that the registry itself caps at 256 rows (compute_hayaku_rrf_rows_invalid) and it
    // completes in ~1.16 ms, so it can finish before the fourth namespace is even dispatched.
    // Measured over 10 runs at worker=4: peakJobs=4 every time, peakNamespaces 3 (7 times) or
    // 4 (3 times). Asserting equality there asserted a race, not a product property.
    assert.ok(concurrency.peakJobs >= Math.min(4, workerCount),
      `worker=${workerCount} did not reach the expected physical overlap: ${JSON.stringify(concurrency)}`);
    assert.ok(concurrency.peakJobs <= workerCount,
      `worker=${workerCount} exceeded the configured physical pool: ${JSON.stringify(concurrency)}`);
    assert.ok(concurrency.peakNamespaces <= Math.min(4, workerCount),
      `worker=${workerCount} reported more concurrent namespaces than the pool can hold: ${JSON.stringify(concurrency)}`);

    const canonicalAfter = Object.fromEntries(Object.entries(app.repositories)
      .map(([namespace, repository]) => [namespace, repositoryDigest(repository.filePath)]));
    assert.deepEqual(canonicalAfter, canonicalBefore, `worker=${workerCount} mutated canonical SQLite/WAL`);
    const rssPeakDeltaBytes = Math.max(0, rssPeak - rssBaseline);
    assert.ok(rssPeakDeltaBytes < 512 * MIB,
      `worker=${workerCount} RSS delta exceeded the bounded test budget: ${rssPeakDeltaBytes}`);

    return {
      workers: workerCount,
      jobs: results.length,
      ...concurrency,
      localSerialMs: Number(localSerialMs.toFixed(2)),
      serialEquivalentMs: Number((localSerialMs * 3).toFixed(2)),
      wallMs: Number(wallMs.toFixed(2)),
      observedThroughputFactor: Number(((localSerialMs * 3) / wallMs).toFixed(3)),
      rssBaselineMiB: Number((rssBaseline / MIB).toFixed(2)),
      rssPeakMiB: Number((rssPeak / MIB).toFixed(2)),
      rssPeakDeltaMiB: Number((rssPeakDeltaBytes / MIB).toFixed(2)),
      namespaces: summarizeProductResults(results)
    };
  } finally {
    if (sampler) clearInterval(sampler);
    await app?.close();
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), tempRoot);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv[2] === '--cell') {
    const workerCount = Number(process.argv[3]);
    if (![1, 2, 4, 8].includes(workerCount)) throw new Error(`invalid_matrix_worker_count:${process.argv[3]}`);
    const cell = await runMatrixCell(workerCount);
    process.stdout.write(`compute_product_worker_matrix_cell: ${JSON.stringify(cell)}\n`);
    return;
  }
  const matrix = [];
  for (const workerCount of [1, 2, 4, 8]) {
    const output = execFileSync(process.execPath, [__filename, '--cell', String(workerCount)], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024
    });
    const line = String(output).split(/\r?\n/).find(item => item.startsWith('compute_product_worker_matrix_cell: '));
    if (!line) throw new Error(`matrix_cell_output_missing:${workerCount}`);
    matrix.push(JSON.parse(line.slice('compute_product_worker_matrix_cell: '.length)));
  }
  // peakJobs is the stable, meaningful column (see the per-cell note above). Measured over 6 runs
  // per cell: workers=1 -> 1, workers=2 -> 2, workers=4 -> 4, workers=8 -> 6-7 (only 12 jobs are
  // submitted, and they do not all reach the queue inside one window, so an 8-wide pool is not
  // fully used by this fixture). What the product must guarantee - and what is asserted - is that
  // the pool reaches the namespace count it can serve and never exceeds its configured width.
  const expectedPeakJobs = { 1: 1, 2: 2, 4: 4 };
  for (const item of matrix) {
    const floor = expectedPeakJobs[item.workers] ?? Math.min(4, item.workers);
    assert.ok(item.peakJobs >= floor,
      `worker=${item.workers} must reach at least ${floor} concurrent jobs: ${JSON.stringify(matrix.map(row => ({ workers: row.workers, peakJobs: row.peakJobs })))}`);
    assert.ok(item.peakJobs <= item.workers,
      `worker=${item.workers} exceeded its configured physical pool: ${JSON.stringify(item)}`);
  }
  for (const item of matrix) {
    assert.ok(item.peakJobs <= item.workers,
      `worker=${item.workers} exceeded its configured physical pool: ${JSON.stringify(item)}`);
    assert.ok(item.peakNamespaces >= 1 && item.peakNamespaces <= Math.min(4, item.workers),
      `worker=${item.workers} namespace overlap out of range: ${JSON.stringify(item)}`);
  }
  process.stdout.write(`compute_product_worker_matrix_test: PASS ${JSON.stringify({
    schema: 'memory-suite.compute.product-worker-matrix-report.v1',
    matrix
  })}\n`);
}

main().catch(error => {
  process.stderr.write(`compute_product_worker_matrix_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
