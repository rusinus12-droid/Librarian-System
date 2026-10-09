'use strict';

const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket } = require('./fixtures/hayaku_runtime_harness.cjs');

(async () => {
  const runtime = await createHayakuRuntime({ autoRepair: false });
  try {
    const assess = runtime.hayaku._test.assessPacketCaptureSemantics;
    const blank = runtime.hayaku._test.minimalPacketSkeletonObject();

    const decisive = assess(blank, 'current_snapshot', '그는 방아쇠를 당겼다. 민수는 즉사했다.');
    assert.equal(decisive.coverage.shortHighSalience, true);
    assert.ok(decisive.coverage.shortHighSalienceSignals.includes('death_or_severe_harm'));
    assert.equal(decisive.ok, false, 'short decisive outcome cannot pass as a blank skeleton');
    assert.match(decisive.reason, /detectable_outcome/);

    const commitment = assess(blank, 'current_snapshot', '그녀는 내일 다시 만나겠다고 약속했다.');
    assert.equal(commitment.coverage.shortHighSalience, true);
    assert.ok(commitment.coverage.shortHighSalienceSignals.includes('commitment_or_decision'));
    assert.equal(commitment.ok, false);

    const trivial = assess(blank, 'current_snapshot', '그는 조용히 고개를 끄덕였다.');
    assert.equal(trivial.coverage.shortHighSalience, false);
    assert.equal(trivial.ok, true, 'short low-salience prose does not force semantic payload');

    process.stdout.write('hayaku_short_high_salience_semantic_gate_test: PASS\\n');
  } finally {
    await runtime.dispose();
  }
})().catch(error => {
  process.stderr.write(`hayaku_short_high_salience_semantic_gate_test: FAIL\\n${error.stack || error}\\n`);
  process.exitCode = 1;
});
