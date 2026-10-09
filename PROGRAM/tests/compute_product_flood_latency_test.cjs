'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createMemorySuiteServer } = require('../server/server.cjs');
const {
  repositoryDigest,
  submitProductJob,
  waitProductResult,
  waitForProductLoad,
  createProductSpecs,
  executeProductLocals,
  peakProductConcurrency
} = require('./fixtures/compute_product_load_fixture.cjs');

const COMPUTE_SIGNING_KEY = 'product-flood-latency-signing-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MIB = 1024 * 1024;

async function main() {
  const tempRoot = path.resolve(os.tmpdir());
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'memory-suite-product-flood-'));
  assert.equal(path.dirname(dataDir), tempRoot);
  const app = createMemorySuiteServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    autoBackup: false,
    computeWorkers: 2,
    computeSigningKey: COMPUTE_SIGNING_KEY
  });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  let sampler = null;
  try {
    const specs = await createProductSpecs(base);
    const byNamespace = Object.fromEntries(specs.map(spec => [spec.identity.namespace, spec]));
    const localResults = executeProductLocals(specs);
    const canonicalBefore = Object.fromEntries(Object.entries(app.repositories)
      .map(([namespace, repository]) => [namespace, repositoryDigest(repository.filePath)]));
    const rssBaseline = process.memoryUsage().rss;
    let rssPeak = rssBaseline;
    sampler = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 5);

    const floodPending = Array.from({ length: 8 }, (_, index) => submitProductJob(base, byNamespace.flashback, {
      operationId: `product_flood_flashback_${String(index + 1).padStart(4, '0')}`,
      lane: 'background',
      binding: {
        schema: 'memory-suite.compute.product-flood-binding.v1',
        namespace: 'flashback',
        index: index + 1
      }
    }));
    const floodSubmissions = await Promise.all(floodPending);
    const activeStates = await waitForProductLoad(base, floodSubmissions, {
      minRunning: 2,
      requireQueued: true
    });
    const initiallyRunning = new Set(activeStates.filter(item => item.state === 'running').map(item => item.jobId));
    assert.equal(initiallyRunning.size, 2, 'both workers must be occupied by the Flashback flood before interactive submit');
    assert.ok(activeStates.filter(item => item.state === 'queued').length >= 1,
      'the flood must leave at least one queued background job to test lane priority');

    const interactiveSubmittedAt = performance.now();
    const interactiveSubmission = await submitProductJob(base, byNamespace.hayaku, {
      operationId: 'product_flood_hayaku_interactive_0001',
      lane: 'interactive',
      deadlineMs: 3000,
      binding: {
        schema: 'memory-suite.compute.product-flood-interactive-binding.v1',
        namespace: 'hayaku',
        flood: 'flashback'
      }
    });
    const interactive = await waitProductResult(base, interactiveSubmission, 5000);
    const interactiveWallMs = performance.now() - interactiveSubmittedAt;
    assert.deepEqual(interactive.result.result, localResults.hayaku,
      'interactive HAYAKU result must exactly match the local kernel');
    assert.ok(interactive.result.timing.queueMs < 1000,
      `interactive queue exceeded the bounded flood gate: ${interactive.result.timing.queueMs}ms`);

    const floodResults = await Promise.all(floodSubmissions.map(item => waitProductResult(base, item)));
    const queuedBackgroundStarts = floodResults
      .filter(item => !initiallyRunning.has(item.job.jobId))
      .filter(item => Number(item.status.startedAt) >= Number(interactive.job.createdAt))
      .map(item => Number(item.status.startedAt))
      .sort((left, right) => left - right);
    assert.ok(queuedBackgroundStarts.length > 0, 'no queued background comparison remained after interactive submit');
    assert.ok(Number(interactive.status.startedAt) <= queuedBackgroundStarts[0],
      `interactive did not receive the next available lane slot: interactive=${interactive.status.startedAt} background=${queuedBackgroundStarts[0]}`);
    assert.ok(Number(interactive.status.completedAt) < Math.max(...floodResults.map(item => Number(item.status.completedAt))),
      'interactive work must finish before the background flood drains');

    const soakStartedAt = performance.now();
    const soakPending = [];
    for (let wave = 1; wave <= 6; wave += 1) {
      for (const spec of specs) {
        soakPending.push(submitProductJob(base, spec, {
          operationId: `product_soak_${spec.identity.namespace}_${String(wave).padStart(4, '0')}`,
          lane: 'background',
          binding: {
            schema: 'memory-suite.compute.product-soak-binding.v1',
            namespace: spec.identity.namespace,
            wave
          }
        }));
      }
    }
    const soakSubmissions = await Promise.all(soakPending);
    const soakResults = await Promise.all(soakSubmissions.map(item => waitProductResult(base, item)));
    const soakWallMs = performance.now() - soakStartedAt;
    assert.equal(soakResults.length, 24);
    for (const spec of specs) {
      const first = soakResults.find(item => item.spec === spec);
      assert.ok(first);
      assert.deepEqual(first.result.result, localResults[spec.identity.namespace],
        `${spec.identity.namespace} bounded soak result differs from local`);
    }
    const soakConcurrency = peakProductConcurrency(soakResults);
    assert.equal(soakConcurrency.peakJobs, 2);
    assert.equal(soakConcurrency.peakNamespaces, 2);

    clearInterval(sampler);
    sampler = null;
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    const rssPeakDeltaBytes = Math.max(0, rssPeak - rssBaseline);
    assert.ok(rssPeakDeltaBytes < 512 * MIB,
      `flood/soak RSS delta exceeded the bounded test budget: ${rssPeakDeltaBytes}`);
    const canonicalAfter = Object.fromEntries(Object.entries(app.repositories)
      .map(([namespace, repository]) => [namespace, repositoryDigest(repository.filePath)]));
    assert.deepEqual(canonicalAfter, canonicalBefore, 'flood/soak Compute mutated canonical SQLite/WAL');

    process.stdout.write(`compute_product_flood_latency_test: PASS ${JSON.stringify({
      schema: 'memory-suite.compute.product-flood-latency-report.v1',
      workers: 2,
      floodNamespace: 'flashback',
      floodJobs: floodResults.length,
      interactiveNamespace: 'hayaku',
      interactiveQueueMs: interactive.result.timing.queueMs,
      interactiveWorkerMs: interactive.result.timing.workerMs,
      interactiveTotalMs: interactive.result.timing.totalMs,
      interactiveWallMs: Number(interactiveWallMs.toFixed(2)),
      interactiveLeadMs: queuedBackgroundStarts[0] - Number(interactive.status.startedAt),
      boundedSoakWaves: 6,
      boundedSoakJobs: soakResults.length,
      soakWallMs: Number(soakWallMs.toFixed(2)),
      soakConcurrency,
      rssBaselineMiB: Number((rssBaseline / MIB).toFixed(2)),
      rssPeakMiB: Number((rssPeak / MIB).toFixed(2)),
      rssPeakDeltaMiB: Number((rssPeakDeltaBytes / MIB).toFixed(2))
    })}\n`);
  } finally {
    if (sampler) clearInterval(sampler);
    await app.close();
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), tempRoot);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`compute_product_flood_latency_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
