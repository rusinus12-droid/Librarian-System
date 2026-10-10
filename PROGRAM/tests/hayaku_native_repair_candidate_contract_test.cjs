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
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return `h64${hash.toString(36)}`;
};
const groundedEnvelope = summary => {
  const packet = createValidPacket({ turn: 2, summary });
  packet.entity.characters = [{ name: 'Alice' }];
  packet.planner.continuity_locks = [summary];
  const grounding = [];
  const walk = (value, base) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item != null && (typeof item !== 'string' || item.trim())) grounding.push({ path: `${base}[${index}]`, source: 'target', evidence: [summary] });
      });
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, nested]) => walk(nested, base ? `${base}.${key}` : key));
  };
  for (const axis of ['entity', 'world', 'narrative', 'planner']) walk(packet[axis], axis);
  grounding.push({ path: 'meta.summary_memory.summary', source: 'target', evidence: [summary] });
  return { schema: 'hayaku.native_repair_output.v1', packet, grounding };
};

(async () => {
  const runtime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      user('u1', 'I enter the archive.'),
      assistant('a1', hiddenPacketMessage('Alice entered the archive.', createValidPacket({ turn: 1, summary: 'Alice entered the archive.' }))),
      user('u2', 'I open the cedar chest.'),
      assistant('a2', 'Alice opened the cedar chest and found a blue ribbon.')
    ]
  });
  try {
    await runtime.hayaku._test.scanCurrentChatForNativeRecoveryDebts({ reason: 'candidate_contract_fixture' });
    const debtState = await runtime.hayaku._test.inspectRecoveryDebtsForNativeRepair({ includeEvidence: true, limit: 8 });
    const debt = Array.from(debtState.debts || []).find(row => Number(row.pairIndex || 0) === 2);
    assert.ok(debt, 'turn-2 recovery debt must exist');
    const repairTarget = runtime.hayaku._test.nativeRepairTargetFromDebt(debt);
    const prompt = runtime.hayaku._test.nativePacketAuthoringPrompt('incremental_recovery');
    const packet = runtime.hayaku._test.normalizeNativeAnalysisPacket(
      createValidPacket({ turn: 2, summary: 'Alice opened the cedar chest and found a blue ribbon.' }),
      'incremental_recovery',
      { turn: 2, startTurn: 2, endTurn: 2, targetPairIndex: 2, messageIndexes: [], chunkHash: 'candidate-contract-chunk' },
      { scopeKey: debt.scopeKey, sourceEvidenceHash: repairTarget.sourceEvidenceHash, repairTarget }
    );
    const candidate = {
      schema: 'hayaku.native_repair_candidate.v1',
      version: prompt.workerVersion,
      scopeKey: debt.scopeKey,
      debtId: debt.debtId,
      runId: 'candidate-contract-run',
      recoveryId: 'candidate-contract-recovery',
      sourceHash: repairTarget.sourceEvidenceHash,
      chunkHash: 'candidate-contract-chunk',
      startTurn: 2,
      endTurn: 2,
      targetPairIndex: 2,
      repairTarget,
      targetFingerprint: runtime.hayaku._test.nativeRepairTargetFingerprint(repairTarget),
      replacementRecordIds: [],
      body: packet.body,
      packetHash: stableHash64(packet.body),
      promptContractHash: prompt.contractHash,
      analysisMode: 'primary',
      state: 'candidate_verified',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const storageKey = runtime.hayaku._test.nativeRepairCandidateKey(debt.scopeKey, debt.debtId);

    await runtime.pluginStorage.setItem(storageKey, JSON.stringify({ ...candidate, version: 'hayaku_native_otherax_repair_v1' }));
    let readback = await runtime.hayaku._test.readNativeRepairCandidate(debt.scopeKey, debt.debtId, repairTarget, prompt.contractHash);
    assert.equal(readback.available, false);
    assert.equal(readback.reason, 'candidate_worker_version_mismatch');

    await runtime.pluginStorage.setItem(storageKey, JSON.stringify({ ...candidate, state: 'failed' }));
    readback = await runtime.hayaku._test.readNativeRepairCandidate(debt.scopeKey, debt.debtId, repairTarget, prompt.contractHash);
    assert.equal(readback.available, false);
    assert.equal(readback.reason, 'candidate_state_not_verified');

    await runtime.pluginStorage.setItem(storageKey, JSON.stringify({ ...candidate, promptContractHash: 'stale-prompt-contract' }));
    readback = await runtime.hayaku._test.readNativeRepairCandidate(debt.scopeKey, debt.debtId, repairTarget, prompt.contractHash);
    assert.equal(readback.available, false);
    assert.equal(readback.reason, 'candidate_prompt_contract_mismatch');

    await runtime.pluginStorage.setItem(storageKey, JSON.stringify(candidate));
    readback = await runtime.hayaku._test.readNativeRepairCandidate(debt.scopeKey, debt.debtId, repairTarget, prompt.contractHash);
    assert.equal(readback.available, false);
    assert.equal(readback.reason, 'candidate_grounding_receipt_missing', 'automatic candidates require a bound grounding receipt');

    await runtime.pluginStorage.setItem(storageKey, JSON.stringify({ ...candidate, userApproved: true }));
    readback = await runtime.hayaku._test.readNativeRepairCandidate(debt.scopeKey, debt.debtId, repairTarget, prompt.contractHash);
    assert.equal(readback.available, true, 'an explicit Failed Recovery adoption remains a separate user-authorized boundary');
    await runtime.pluginStorage.setItem(storageKey, JSON.stringify({ ...candidate, promptContractHash: 'stale-prompt-contract' }));

    runtime.setLlmResponder(async () => ({
      type: 'success',
      result: JSON.stringify(groundedEnvelope('Alice opened the cedar chest and found a blue ribbon.'))
    }));
    const repaired = await runtime.hayaku.recovery.repairNow({ reason: 'candidate_contract_reanalysis' });
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.equal(repaired.cachedCandidate, false, 'stale-contract candidate must not be adopted');
    assert.equal(runtime.llmCalls.length, 1, 'stale-contract candidate must be reanalyzed exactly once');
    assert.equal(runtime.fetchCalls.length, 0);

    console.log('PASS hayaku_native_repair_candidate_contract_test');
  } finally {
    await runtime.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
