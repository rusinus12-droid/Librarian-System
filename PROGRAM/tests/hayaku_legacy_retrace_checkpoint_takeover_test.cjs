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

const normalizedBody = (runtime, kind, candidate, chunk, context = {}) => (
  runtime.hayaku._test.normalizeNativeAnalysisPacket(candidate, kind, chunk, context).body
);

(async () => {
  // Legacy RE:TRACE Cold Start checkpoint: HAYAKU must import and adopt it with
  // zero new Other Ax calls.
  const coldRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      user('u1', 'I enter the archive.'),
      assistant('a1', 'Alice entered the archive and closed the iron door.')
    ]
  });
  try {
    const status = await coldRuntime.hayaku.recovery.status();
    const scopeKey = status.scopeKey;
    const evidence = coldRuntime.hayaku._test.collectNativeColdStartEvidence({ key: scopeKey, chatMessages: coldRuntime.chat.message });
    const unit = evidence.units[0];
    const promptContractHash = coldRuntime.hayaku._test.nativePacketAuthoringPrompt('cold_start').contractHash;
    const body = normalizedBody(coldRuntime, 'cold_start', createValidPacket({ turn: 1, subject: 'Alice', scene: 'archive', summary: 'Alice entered the archive and closed the iron door.' }), {
      ...unit, kind: unit.kind, startTurn: 1, endTurn: 1, targetPairIndex: 1, messageIndexes: unit.indexes
    }, { scopeKey, sourceEvidenceHash: unit.chunkHash });
    const hash = stableHash64(body);
    const legacyRun = {
      schema: 'memory-session-bridge-hayaku-cold-start-run-v1',
      runId: 'legacy-cold-run',
      scopeKey,
      sourceHash: evidence.sourceHash,
      contractHash: promptContractHash,
      state: 'failed',
      chunks: [{ ordinal: 1, startTurn: 1, endTurn: 1, targetPairIndex: 1, status: 'verified', attempts: 1, body, packetHash: hash, chunkHash: unit.chunkHash, sourceEvidenceHash: unit.chunkHash, promptContractHash }]
    };
    assert.equal(coldRuntime.hayaku._test.legacyColdStartReusableChunkForUnit({ ...legacyRun, sourceHash: 'stale-source' }, unit, scopeKey, promptContractHash, evidence.sourceHash), null, 'legacy Cold Start source mismatch must fail closed');
    assert.equal(coldRuntime.hayaku._test.legacyColdStartReusableChunkForUnit({ ...legacyRun, contractHash: 'stale-contract' }, unit, scopeKey, promptContractHash, evidence.sourceHash), null, 'legacy Cold Start prompt contract mismatch must fail closed');
    assert.equal(coldRuntime.hayaku._test.legacyColdStartReusableChunkForUnit({ ...legacyRun, chunks: [{ ...legacyRun.chunks[0], chunkHash: 'stale-chunk' }] }, unit, scopeKey, promptContractHash, evidence.sourceHash), null, 'legacy Cold Start chunk mismatch must fail closed');
    await coldRuntime.pluginStorage.setItem(`memory_session_bridge:hayaku_cold_start_run:${scopeKey}`, JSON.stringify(legacyRun));

    const result = await coldRuntime.hayaku.recovery.coldStart({ resume: true });
    assert.equal(result.ok, true);
    assert.equal(result.legacyImportedChunks, 1);
    assert.equal(result.reusedChunks, 1);
    assert.equal(coldRuntime.llmCalls.length, 0, 'verified legacy Cold Start checkpoint must not be reanalyzed');

    const ledger = await coldRuntime.hayaku.ledger.inspect({ includeRecords: true });
    assert.ok(ledger.records.some(record => record.captureSource === 'bridge_cold_start' && record.recordState === 'historical'));
  } finally {
    await coldRuntime.dispose();
  }

  // Legacy RE:TRACE incremental checkpoint: scan/materialize the missing debt,
  // then HAYAKU must adopt the verified checkpoint before making a new LLM call.
  const incrementalRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      user('u1', 'I enter the archive.'),
      assistant('a1', hiddenPacketMessage('Alice entered the archive.', createValidPacket({ turn: 1, subject: 'Alice', scene: 'archive', summary: 'Alice entered the archive.' }))),
      user('u2', 'I turn the bronze dial.'),
      assistant('a2', 'Alice turned the bronze dial and the west wall opened.')
    ]
  });
  try {
    const status = await incrementalRuntime.hayaku.recovery.status();
    const scopeKey = status.scopeKey;
    await incrementalRuntime.hayaku._test.scanCurrentChatForNativeRecoveryDebts({ reason: 'legacy_exact_fixture' });
    const debtState = await incrementalRuntime.hayaku._test.inspectRecoveryDebtsForNativeRepair({ includeEvidence: true, limit: 8 });
    const debt = Array.from(debtState.debts || []).find(row => Number(row.pairIndex || 0) === 2);
    assert.ok(debt, 'current exact turn-2 debt must exist before legacy takeover');
    const repairTarget = incrementalRuntime.hayaku._test.nativeRepairTargetFromDebt(debt);
    const evidence = incrementalRuntime.hayaku._test.collectNativeColdStartEvidence({ key: scopeKey, chatMessages: incrementalRuntime.chat.message });
    const unit = evidence.units.find(row => Number(row.turn || 0) === 2);
    const contextOnly = evidence.units.filter(row => Number(row.turn || 0) < 2).slice(-2).map(row => String(row.text || '')).filter(Boolean).join('\n\n---\n\n').slice(-6000);
    const targetText = `[Turn 2]\n[User attempt]\n${debt.evidence.user}\n\n[Assistant outcome]\n${debt.evidence.assistant}`;
    const chunkHash = stableHash64([repairTarget.sourceEvidenceHash, targetText, contextOnly].join('\u0001'));
    const promptContractHash = incrementalRuntime.hayaku._test.nativePacketAuthoringPrompt('incremental_recovery').contractHash;
    const body = normalizedBody(incrementalRuntime, 'incremental_recovery', createValidPacket({ turn: 2, subject: 'Alice', scene: 'archive', summary: 'Alice turned the bronze dial and the west wall opened.' }), {
      kind: 'completed_turn', turn: 2, startTurn: 2, endTurn: 2, targetPairIndex: 2, messageIndexes: unit.indexes, text: targetText, chunkHash
    }, { scopeKey, sourceEvidenceHash: repairTarget.sourceEvidenceHash, repairTarget });
    const hash = stableHash64(body);
    const legacyRun = {
      schema: 'memory-session-bridge-hayaku-incremental-recovery-run-v1',
      runId: 'legacy-incremental-run',
      scopeKey,
      sourceHash: stableHash64(repairTarget.sourceEvidenceHash),
      contractHash: promptContractHash,
      state: 'failed',
      replacementRecordIds: [],
      chunks: [{ ordinal: 1, startTurn: 2, endTurn: 2, targetPairIndex: 2, status: 'verified', attempts: 1, body, packetHash: hash, chunkHash, sourceEvidenceHash: repairTarget.sourceEvidenceHash, promptContractHash, repairTarget }]
    };
    await incrementalRuntime.pluginStorage.setItem(`memory_session_bridge:hayaku_incremental_recovery_run:${scopeKey}`, JSON.stringify({ ...legacyRun, sourceHash: 'stale-source' }));
    const staleSource = await incrementalRuntime.hayaku._test.adoptLegacyRetraceIncrementalCheckpoint({ key: scopeKey, chatMessages: incrementalRuntime.chat.message });
    assert.equal(staleSource.adopted, false, 'legacy incremental source mismatch must not be adopted');
    assert.equal(staleSource.reason, 'legacy_incremental_source_hash_mismatch');
    const stalePacket = JSON.parse(body);
    stalePacket.meta.repair_target.variantId = 'stale-variant';
    const staleBody = JSON.stringify(stalePacket);
    await incrementalRuntime.pluginStorage.setItem(`memory_session_bridge:hayaku_incremental_recovery_run:${scopeKey}`, JSON.stringify({
      ...legacyRun,
      chunks: [{ ...legacyRun.chunks[0], body: staleBody, packetHash: stableHash64(staleBody) }]
    }));
    const staleTarget = await incrementalRuntime.hayaku._test.adoptLegacyRetraceIncrementalCheckpoint({ key: scopeKey, chatMessages: incrementalRuntime.chat.message });
    assert.equal(staleTarget.adopted, false, 'legacy packet embedded target mismatch must not be rebound to current debt');
    assert.equal(staleTarget.reason, 'legacy_verified_chunks_evidence_mismatch');
    await incrementalRuntime.pluginStorage.setItem(`memory_session_bridge:hayaku_incremental_recovery_run:${scopeKey}`, JSON.stringify(legacyRun));

    const result = await incrementalRuntime.hayaku.recovery.repairNow({ reason: 'legacy_incremental_takeover' });
    assert.equal(result.ok, true);
    assert.equal(incrementalRuntime.llmCalls.length, 0, 'verified legacy incremental checkpoint must discharge debt without Other Ax');
    assert.equal(result.legacyTakeover?.adopted, true);

    const ledger = await incrementalRuntime.hayaku.ledger.inspect({ includeRecords: true });
    assert.ok(ledger.records.some(record => record.packetType === 'recovery_snapshot' && record.recordState === 'active' && Number(record.targetPairIndex || 0) === 2));
    const debts = await incrementalRuntime.hayaku._test.inspectRecoveryDebtsForNativeRepair({ includeEvidence: true, limit: 8 });
    assert.equal(Array.from(debts.debts || []).length, 0);
  } finally {
    await incrementalRuntime.dispose();
  }

  // A verified legacy automatic-repair capsule/run is also HAYAKU-owned on
  // upgrade; it must be adopted before a duplicate paid Other Ax call.
  const autoRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      user('u1', 'I enter the archive.'),
      assistant('a1', hiddenPacketMessage('Alice entered the archive.', createValidPacket({ turn: 1, subject: 'Alice', scene: 'archive', summary: 'Alice entered the archive.' }))),
      user('u2', 'I pull the red lever.'),
      assistant('a2', 'Alice pulled the red lever and a hidden staircase descended.')
    ]
  });
  try {
    await autoRuntime.hayaku._test.scanCurrentChatForNativeRecoveryDebts({ reason: 'legacy_auto_fixture' });
    const debtState = await autoRuntime.hayaku._test.inspectRecoveryDebtsForNativeRepair({ includeEvidence: true, limit: 8 });
    const debt = Array.from(debtState.debts || [])[0];
    assert.ok(debt);
    const scopeKey = debt.scopeKey;
    const debtId = debt.debtId;
    const repairTarget = autoRuntime.hayaku._test.nativeRepairTargetFromDebt(debt);
    const promptContractHash = autoRuntime.hayaku._test.nativePacketAuthoringPrompt('incremental_recovery').contractHash;
    const body = normalizedBody(autoRuntime, 'incremental_recovery', createValidPacket({ turn: 2, subject: 'Alice', scene: 'archive', summary: 'Alice pulled the red lever and a hidden staircase descended.' }), {
      kind: 'completed_turn', turn: 2, startTurn: 2, endTurn: 2, targetPairIndex: 2, messageIndexes: [], text: 'legacy auto repair', chunkHash: 'legacy-auto-chunk'
    }, { scopeKey, sourceEvidenceHash: repairTarget.sourceEvidenceHash, repairTarget });
    const packetHash = stableHash64(body);
    const legacyHash = stableHash64(`${scopeKey}\u0001${debtId}`);
    const capsule = {
      schema: 'memory-session-bridge-hayaku-incremental-recovery-v1',
      automaticRepair: true,
      repairMode: 'retrace_auto',
      recoveryId: 'legacy-auto-recovery',
      runId: 'legacy-auto-run',
      scopeKey,
      sourceHash: repairTarget.sourceEvidenceHash,
      promptContractHash,
      packetCount: 1,
      createdAt: Date.now(),
      replacementRecordIds: [],
      packets: [{ ordinal: 1, startTurn: 2, endTurn: 2, targetPairIndex: 2, chunkHash: 'legacy-auto-chunk', packetHash, promptContractHash, repairTarget, body }]
    };
    await autoRuntime.pluginStorage.setItem(`memory_session_bridge:hayaku_auto_repair_capsule:${legacyHash}`, JSON.stringify(capsule));

    const result = await autoRuntime.hayaku.recovery.repairNow({ reason: 'legacy_auto_takeover' });
    assert.equal(result.ok, true);
    assert.equal(result.legacyCheckpointImported, true);
    assert.equal(result.legacyCheckpointSource, 'capsule');
    assert.equal(autoRuntime.llmCalls.length, 0, 'verified legacy automatic-repair capsule must not cause a duplicate Other Ax call');

    console.log('PASS hayaku_legacy_retrace_checkpoint_takeover_test');
  } finally {
    await autoRuntime.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
