'use strict';

// Focused D4 gate for cancellation before a batch and immediately after the
// durable in-flight marker. The test injects AbortError only into the fixture.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const transformSource = source => {
  const beforeBatch = '          if (options.signal?.aborted || state.canonicalJob?.cancelRequested === true) {';
  assert.equal(source.includes(beforeBatch), true, 'pre-batch cancellation boundary anchor exists');
  source = source.replace(beforeBatch, `          if (globalThis.__phaseDAbortBeforeBatch === true) {
            globalThis.__phaseDAbortBeforeBatch = false;
            state.canonicalJobAbortController?.abort();
          }
${beforeBatch}`);

  const afterMarker = '        pipelineRequestId = await updatePipelineWorkPanel(';
  assert.equal(source.includes(afterMarker), true, 'post-marker pipeline panel boundary anchor exists');
  source = source.replace(afterMarker, `        if (globalThis.__phaseDAbortAfterMarker === true) {
        globalThis.__phaseDAbortAfterMarker = false;
        state.canonicalJobAbortController?.abort();
        throw new DOMException('Canonical job cancelled.', 'AbortError');
      }
${afterMarker}`);

  const observer = 'onCancellationManifestCleanup: result => { cancellationManifestCleanup = result; }';
  assert.equal(source.includes(observer), true, 'cleanup observer anchor exists');
  source = source.replace(observer,
    "onCancellationManifestCleanup: result => { if (globalThis.__phaseDDropCleanupObserver !== true) cancellationManifestCleanup = result; }");
  return source;
};

const runCase = async ({ name, setupFlag, dropObserver = false, expectedScanState, expectedScanOk, expectedInFlight }) => {
  const snapshot = await serverFixture({ mode: 'server_only', transformSource });
  try {
    snapshot.f.r.context.__phaseDAbortBeforeBatch = setupFlag === 'before_batch';
    snapshot.f.r.context.__phaseDAbortAfterMarker = setupFlag === 'after_marker';
    snapshot.f.r.context.__phaseDDropCleanupObserver = dropObserver;
    const result = await snapshot.f.run();
    const scanResult = result?.result || null;
    const manifest = snapshot.getManifest();
    const status = await snapshot.f.r.api.getCanonicalJobStatus({});
    assert.equal(status?.state, 'cancelled', `${name}: public canonical job records cancellation`);
    assert.equal(snapshot.f.control.calls.length, 0, `${name}: cancellation prevents provider calls`);
    assert.equal(scanResult?.state, expectedScanState, `${name}: scan reports the expected cancellation classification (${JSON.stringify(scanResult)})`);
    assert.equal(scanResult?.ok, expectedScanOk, `${name}: scan ok reflects whether cleanup was verified`);
    assert.equal(manifest?.inFlight ?? null, expectedInFlight, `${name}: durable manifest marker has the expected value`);
    return { name, scanState: scanResult?.state, scanOk: scanResult?.ok, inFlight: manifest?.inFlight ?? null };
  } finally {
    await snapshot.cleanup();
  }
};

const run = async () => {
  const results = [];
  results.push(await runCase({ name: 'pre_batch_cancel', setupFlag: 'before_batch',
    expectedScanState: 'cancelled', expectedScanOk: true, expectedInFlight: null }));
  results.push(await runCase({ name: 'active_batch_cleanup_observed', setupFlag: 'after_marker',
    expectedScanState: 'cancelled', expectedScanOk: true, expectedInFlight: null }));
  results.push(await runCase({ name: 'active_batch_cleanup_observer_missing', setupFlag: 'after_marker', dropObserver: true,
    expectedScanState: 'cancelled_cleanup_failed', expectedScanOk: false, expectedInFlight: null }));
  console.log(JSON.stringify({ test: 'libra_phase_d_cancel_boundary', passed: results.length, results,
    boundary: 'server_only fixture; pre-batch cancellation is a normal stop, while post-marker AbortError must enter cleanup and missing cleanup observation must be reported' }));
};

run().catch(error => { console.error(error); process.exitCode = 1; });
