'use strict';

const assert = require('node:assert/strict');
const {
  createHayakuRuntime,
  createValidPacket,
  hiddenPacketMessage
} = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data });

const stableHash64 = value => {
  const input = String(value ?? '');
  let hash = 14695981039346656037n;
  const prime = 1099511628211n;
  const mask = 18446744073709551615n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return `h64${hash.toString(36)}`;
};
const groundedEnvelope = (packet, quote) => {
  const grounding = [];
  const walk = (value, base) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item != null && (typeof item !== 'string' || item.trim())) grounding.push({ path: `${base}[${index}]`, source: 'target', evidence: [quote] });
      });
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, nested]) => {
      if (base === 'planner' && /^(?:suggested_hooks|suggestedHooks|next_direction|nextDirection)$/.test(key)) return;
      walk(nested, base ? `${base}.${key}` : key);
    });
  };
  for (const axis of ['entity', 'world', 'narrative', 'planner']) walk(packet[axis], axis);
  grounding.push({ path: 'meta.summary_memory.summary', source: 'target', evidence: [quote] });
  return { schema: 'hayaku.native_repair_output.v1', packet, grounding };
};

const missingTurnMessages = suffix => [
  user(`${suffix}-u1`, 'I enter the archive.'),
  assistant(`${suffix}-a1`, hiddenPacketMessage(
    'Alice entered the archive.',
    createValidPacket({ turn: 1, summary: 'Alice entered the archive.' })
  )),
  user(`${suffix}-u2`, 'I open the cedar chest.'),
  assistant(`${suffix}-a2`, 'Alice opened the cedar chest and found a blue ribbon.')
];

const captureFailure = async operation => {
  try {
    const result = await operation();
    assert.equal(result?.awaitingUserReview, false, 'failure is retained without automatic manual-adoption UI');
    return { ...result, failedAnalysisId: result.failureId || Array.from(result.failedAnalysisIds || [])[0] || '' };
  } catch (error) {
    return error;
  }
};

const readDurableFailure = async (runtime, failureId) => {
  assert.ok(failureId, 'a durable failure id must be returned');
  const listed = await runtime.hayaku.recovery.failedAnalysis.list();
  assert.equal(listed.available, true);
  const summary = Array.from(listed.entries || []).find(entry => entry.failureId === failureId);
  assert.ok(summary, 'the failure must be indexed for the current chat');
  const detail = await runtime.hayaku.recovery.failedAnalysis.read(failureId);
  assert.equal(detail.available, true);
  assert.equal(detail.durable, true, 'public read must reconstruct the physical chunk set');
  assert.notEqual(detail.volatile, true, 'successful physical readback must not depend on the volatile fallback');
  assert.equal(detail.manifest.failureId, failureId);
  assert.equal(detail.payload.failureId, failureId);
  assert.equal(detail.manifest.payloadHash, detail.payloadHash);
  return { listed, summary, detail };
};

(async () => {
  // A response larger than the former 96,000-character transport slice must be
  // retained byte-for-character after both parse attempts fail. The sentinel is
  // deliberately at the suffix so a hidden prefix truncation cannot pass.
  const hugeRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: missingTurnMessages('huge')
  });
  try {
    const primarySentinel = 'PRIMARY_FULL_RAW_SUFFIX_SENTINEL';
    const primaryRaw = `primary-not-json:${'P'.repeat(100321)}:${primarySentinel}`;
    assert.ok(primaryRaw.length > 96000);

    hugeRuntime.setLlmResponder(async () => ({
      type: 'success',
      result: primaryRaw
    }));
    const error = await captureFailure(() => hugeRuntime.hayaku.recovery.repairNow({ reason: 'failed_analysis_full_raw_test' }));
    assert.equal(hugeRuntime.llmCalls.length, 1, 'one approved background action gets one physical request');
    assert.equal(error.failedAnalysisDurable, true);

    const { summary, detail } = await readDurableFailure(hugeRuntime, error.failedAnalysisId);
    assert.equal(summary.state, 'pending_review');
    assert.equal(detail.manifest.state, 'pending_review');
    assert.ok(Array.from(detail.manifest.chunks || []).length >= 1, 'large payload must use physically hashed chunk storage');
    assert.equal(detail.payload.attempts.length, 1);

    const [primaryAttempt] = detail.payload.attempts;
    assert.equal(primaryAttempt.mode, 'primary');
    assert.equal(primaryAttempt.rawResponse, primaryRaw);
    assert.equal(primaryAttempt.rawChars, primaryRaw.length);
    assert.equal(primaryAttempt.rawHash, stableHash64(primaryRaw));
    assert.ok(primaryAttempt.rawResponse.endsWith(primarySentinel), 'primary suffix must survive durable readback');
    assert.deepEqual(Array.from(primaryAttempt.requestMessages || []), [], 'fixed system/request prompts are not duplicated into durable failure storage');
    assert.equal(summary.rawChars, primaryRaw.length);
  } finally {
    await hugeRuntime.dispose();
  }

  // Canonicalization that would remove or cap data must become a pending review
  // artifact. The raw candidate remains intact, while the separate preview is
  // explicit and adoptable only through the user-resolution boundary.
  const lossRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: missingTurnMessages('loss')
  });
  try {
    const lossCandidate = createValidPacket({
      turn: 2,
      summary: 'Alice opened the cedar chest and found a blue ribbon.'
    });
    lossCandidate.entity.characters = [{ name: 'Alice' }];
    lossCandidate.planner.continuity_locks = ['Alice opened the cedar chest and found a blue ribbon.'];
    lossCandidate.importance.reason = Array.from({ length: 33 }, (_, index) => `reason-${index + 1}`);
    lossCandidate.planner.suggested_hooks = ['This unsupported field must remain visible in the raw failure.'];
    const lossRaw=JSON.stringify(groundedEnvelope(lossCandidate, 'Alice opened the cedar chest and found a blue ribbon.'));
    lossRuntime.setLlmResponder(async () => ({ type: 'success', result: lossRaw }));

    const result=await lossRuntime.hayaku.recovery.repairNow({reason:'normalization_without_false_failure'});
    assert.equal(result.outcome,'completed');assert.equal(result.adoption.durable,true);assert.equal(lossRuntime.llmCalls.length,1);
    const ledger=await lossRuntime.hayaku.ledger.inspect({includeRecords:true});const saved=ledger.records.find(row=>row.hash===result.packetHash);assert(saved);
    const body=JSON.parse(saved.raw);assert.equal(body.importance.reason.length,32);assert.equal(body.planner.suggested_hooks,undefined);
    assert.equal(lossCandidate.importance.reason.length,33,'input fixture is not mutated');assert(lossRaw.includes('suggested_hooks'));
  } finally {
    await lossRuntime.dispose();
  }

  // Cold Start no longer throws away the flow on analysis failure. It returns a
  // review receipt that points to the same durable Failed Recovery artifact.
  const coldRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      user('cold-u1', 'I light the brass lamp.'),
      assistant('cold-a1', 'Alice lit the brass lamp and revealed a hidden map.')
    ],
    llmResponder: async () => ({ type: 'success', result: 'cold-start-invalid-json' })
  });
  try {
    const result = await coldRuntime.hayaku.recovery.coldStart({ resume: true });
    assert.equal(result.ok, false);
    assert.equal(result.completed, false);
    assert.equal(result.awaitingUserReview, false, 'Cold Start failure must return review state instead of throwing');
    assert.equal(result.reason, 'cold_start_no_verified_packets');
    assert.equal(result.failedChunks, 1);
    assert.equal(Array.from(result.failedAnalysisIds || []).length, 1);
    assert.equal(coldRuntime.llmCalls.length, 1);

    const { summary, detail } = await readDurableFailure(coldRuntime, result.failedAnalysisIds[0]);
    assert.equal(summary.kind, 'cold_start');
    assert.equal(summary.state, 'pending_review');
    assert.equal(detail.payload.attempts.length, 1);
    assert.ok(detail.payload.attempts.every(attempt => attempt.rawResponse === 'cold-start-invalid-json'));
    const status = await coldRuntime.hayaku.recovery.status();
    assert.equal(status.coldStartRun.run.state, 'failed');
  } finally {
    await coldRuntime.dispose();
  }

  console.log('PASS hayaku_failed_analysis_vault_runtime_test');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
