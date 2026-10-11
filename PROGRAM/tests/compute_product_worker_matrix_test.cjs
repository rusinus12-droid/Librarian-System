'use strict';
// 2026-10-09 current-owner fixture: three active kernels, four rounds (12 jobs);
// historical four-owner assertions are retired, LIA denial is checked by the fixture.
// Worker widths, physical occupancy floor and original RSS limits remain unchanged.
// Bounded setup coordinates real worker entries. Native timings include gate wait;
// this is controlled physical occupancy, not unguarded CPU overlap or throughput.

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
const { workerPath, createProductGate } = require('./fixtures/compute_product_gate_coordinator.cjs');

async function runMatrixCell(workerCount) {
  const tempRoot = path.resolve(os.tmpdir());
  const dataDir = fs.mkdtempSync(path.join(tempRoot, `memory-suite-product-matrix-${workerCount}-`));
  assert.equal(path.dirname(dataDir), tempRoot);
  const rssBaseline = process.memoryUsage().rss;
  let rssPeak = rssBaseline;
  let sampler = null;
  let app = null, gate = null;
  try {
    sampler = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 5);
    app = createMemorySuiteServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      autoBackup: false,
      computeWorkers: workerCount,
      computeWorkerPath: workerPath,
      computeSigningKey: COMPUTE_SIGNING_KEY
    });
    const address = await app.listen();
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal(app.computePlane.poolSize, workerCount);
    gate = await createProductGate(app, workerCount);
    const specs = await createProductSpecs(base);
    const localStartedAt = performance.now();
    const localResults = executeProductLocals(specs);
    const localSerialMs = performance.now() - localStartedAt;
    const canonicalBefore = Object.fromEntries(Object.entries(app.repositories)
      .map(([namespace, repository]) => [namespace, repositoryDigest(repository.filePath)]));
    const startedAt = performance.now();
    gate.arm();
    const pending = [];
    for (let round = 1; round <= 4; round += 1) {
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
    const submissions = await gate.withinSetup(Promise.all(pending));
    await gate.waitForEntries(Math.min(4, workerCount), submissions);
    gate.release();
    const results = await Promise.all(submissions.map(item => waitProductResult(base, item)));
    assert.equal(results.length, 12);
    for (const item of results) assert.deepEqual(item.result.result, localResults[item.spec.identity.namespace],
      'every actual product job matches its unchanged local kernel');
    for (const spec of specs) assert.equal(results.filter(item => item.spec === spec).length, 4, 'four actual jobs per surviving owner');
    const gateReport = await gate.report();
    assert.ok(gateReport.gatePeak >= Math.min(4, workerCount), 'distinct actual worker entry floor');
    assert.ok(gateReport.gatePeak <= workerCount, 'held physical workers respect pool width');
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
    // These genuine native job intervals include the explicitly reported gate
    // wait. The separate thread-entry proof establishes controlled slot occupancy.
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
      coordinatedOccupancy: gateReport,
      localSerialMs: Number(localSerialMs.toFixed(2)),
      serialEquivalentMs: Number((localSerialMs * 4).toFixed(2)),
      wallMs: Number(wallMs.toFixed(2)),
      controlledWallRatioNotThroughput: Number(((localSerialMs * 4) / wallMs).toFixed(3)),
      rssBaselineMiB: Number((rssBaseline / MIB).toFixed(2)),
      rssPeakMiB: Number((rssPeak / MIB).toFixed(2)),
      rssPeakDeltaMiB: Number((rssPeakDeltaBytes / MIB).toFixed(2)),
      namespaces: summarizeProductResults(results)
    };
  } finally {
    if (sampler) clearInterval(sampler);
    gate?.close();
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
  // Preserve the original physical floor using bounded controlled entries of
  // actual product jobs. No claim of unguarded kernel CPU overlap or throughput.
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
