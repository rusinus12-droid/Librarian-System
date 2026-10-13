'use strict';
// Task 1 + 2 + 4 — HAYAKU: packet authoring on the normal turn, and the missing-packet recovery path.
//
// DRIVEN THROUGH THE PLUGIN'S OWN ENTRY POINT
//
// `repairCurrentPacketInsideAfterRequest(assistantText, 'model')` is the afterRequest pipeline that
// decides whether the current turn already carries a usable packet and, when it does not, calls the
// model once. That single entry point answers every one of the four tasks:
//
//   Task 4  Play the model with a MINIMAL packet (a supported summary alone, every other axis
//           empty). The contract states "A supported summary alone is a complete packet", so if the
//           plugin rejects it, a small model is blocked for following the instructions.
//   Task 2  Play the model with an UNUSABLE answer. The plugin must preserve the visible response
//           byte-for-byte, record durable debt, and leave the turn recoverable.
//   Task 1  Read the durable store back afterwards; nothing may be lost silently.
//   Task 2.3/2.4  Read the prompt the model ACTUALLY received, and measure it.
//
// Read-back is from the plugin's own storage and loader — never from the returned string alone.
const assert = require('node:assert/strict');
const {
  createHayakuRuntime,
  createValidPacket,
  hiddenPacketMessage,
  waitFor
} = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data, time: Date.now() });

// The MINIMUM the contract calls complete.
const minimalPacket = (summary, lineage) => {
  const packet = createValidPacket({ turn: 1, summary });
  packet.meta.packet_type = 'current_snapshot';
  packet.meta.lineage = lineage;
  packet.meta.turn_anchor = summary;
  packet.meta.summary_memory = {
    summary,
    recallAnchors: [], recallAliases: {}, canonicalAnchors: [], mentionedEntityNames: [],
    directEvidenceSnippets: [summary], related_refs: [], confidence: 0.7
  };
  packet.entity = {};
  packet.world = {};
  packet.narrative = {};
  packet.planner = {};
  packet.importance = { overall: 0.4, reason: ['Established state'] };
  return packet;
};

const lineageOf = lineage => ({
  parent_turn_node_id: lineage.parentTurnNodeId || '',
  logical_turn_id: lineage.logicalTurnId,
  request_nonce: lineage.requestNonce,
  identity_version: 2,
  lineage_schema: lineage.lineageSchema,
  turn_owner_key: lineage.turnOwnerKey,
  generation_attempt_id: lineage.generationAttemptId
});

const envelope = (packet, lineage, summary) => JSON.stringify({
  schema: 'hayaku.native_repair_output.v1',
  packet: { ...packet, meta: { ...packet.meta, lineage: lineageOf(lineage) } },
  grounding: [{ path: 'meta.summary_memory.summary', source: 'target', evidence: [summary] }]
});

const eligibleMissingTurnMessages = () => [
  user('r-u1', 'I enter the workshop.'),
  { role: 'assistant', chatId: 'r-a1', id: 'r-a1', data: hiddenPacketMessage('Alice entered the workshop.', createValidPacket({ turn: 1, subject: 'Alice', scene: 'workshop', summary: 'Alice entered the workshop.' })), time: Date.now() },
  user('r-u2', 'I turn the brass valve.')
];

const nativeRecoveryEnvelope = summary => {
  const packet = createValidPacket({ turn: 2, subject: 'Alice', scene: 'workshop', summary });
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

const registerCurrentTurn = async runtime => {
  const scope = await runtime.hayaku._test.currentChatScope();
  assert.ok(scope?.confident, 'the scope must be confident for a capture to register');
  const snapshot = runtime.hayaku._test.authoritativeChatSnapshot(scope.chatMessages, scope);
  const base = runtime.hayaku._test.requestLineageFor(scope.chatMessages, snapshot, scope, { nodes: [] });
  const lineage = runtime.hayaku._test.issueRequestGenerationIdentity(scope, base);
  const pending = runtime.hayaku._test.registerPendingCapture(scope, lineage, 'model', snapshot);
  assert.ok(pending, 'the pending capture must register');
  return { scope, snapshot, lineage };
};

const storeSnapshot = async storage => {
  const keys = storage?.values instanceof Map ? [...storage.values.keys()] : [];
  const rows = [];
  for (const key of keys) rows.push(`${String(key)}=${String(storage.values.get(key) ?? '')}`);
  return { keys: keys.map(String), text: rows.join('\n') };
};

(async () => {
  const observed = {};
  const prompts = [];
  const ASSISTANT_TEXT = 'Alice turned the brass valve and steam began flowing through the blue pipe.';

  // ============================================================================================
  // Task 4 — the NORMAL turn: is a MINIMAL conforming packet accepted and attached?
  // ============================================================================================
  const runtime = await createHayakuRuntime({
    afterRequestAutoRepair: true,
    backgroundAutoRepair: false,
    messages: [user('u1', 'I turn the brass valve.')]
  });
  try {
    const { lineage } = await registerCurrentTurn(runtime);
    const summary = 'Alice turned the brass valve and steam began flowing through the blue pipe.';
    runtime.setLlmResponder(async callOptions => {
      prompts.push((callOptions?.messages || []).map(m => String(m?.content || '')).join('\n'));
      return { type: 'success', result: envelope(minimalPacket(summary, lineage), lineage, summary) };
    });

    const attached = await runtime.hayaku._test.repairCurrentPacketInsideAfterRequest(ASSISTANT_TEXT, 'model');
    const inspection = runtime.hayaku._test.packetCaptureInspectionFromText(attached);

    observed.normalTurn = {
      llmCalls: runtime.llmCalls.length,
      packetAttached: /HAYAKU_STATE_PACKET_START/.test(String(attached)),
      validPackets: inspection?.validCount ?? 0,
      packetType: inspection?.packets?.[0]?.packetType || '',
      minimalAccepted: inspection?.validCount === 1,
      visibleTextPreserved: String(attached).startsWith(ASSISTANT_TEXT)
    };

    // Idempotency: an already-usable packet must NOT trigger another call.
    const again = await runtime.hayaku._test.repairCurrentPacketInsideAfterRequest(attached, 'model');
    observed.normalTurn.secondCallNoOp = again === attached;
    observed.normalTurn.llmCallsAfterSecond = runtime.llmCalls.length;

    const stored = await storeSnapshot(runtime.pluginStorage);
    observed.normalTurn.storageKeys = stored.keys.length;
    observed.normalTurn.summaryInStorage = stored.text.includes(summary);
  } finally {
    await runtime.dispose?.();
  }

  // ============================================================================================
  // Task 2 — UNUSABLE answer: preserve the visible response AND leave durable, recoverable debt.
  // ============================================================================================
  const failedRuntime = await createHayakuRuntime({
    afterRequestAutoRepair: true,
    backgroundAutoRepair: true,
    messages: [user('f-u1', 'I turn the brass valve.')]
  });
  try {
    await registerCurrentTurn(failedRuntime);
    failedRuntime.setLlmResponder(async callOptions => {
      prompts.push((callOptions?.messages || []).map(m => String(m?.content || '')).join('\n'));
      return { type: 'success', result: 'not-json-after-request' };
    });

    failedRuntime.chat.message.push({ role: 'assistant', chatId: 'f-a1', id: 'f-a1', data: ASSISTANT_TEXT, time: Date.now() });
    failedRuntime.chat.messages = failedRuntime.chat.message;
    const returned = await failedRuntime.hayaku._test.repairCurrentPacketInsideAfterRequest(ASSISTANT_TEXT, 'model');
    observed.unusable = {
      llmCalls: failedRuntime.llmCalls.length,
      visibleResponsePreserved: returned === ASSISTANT_TEXT
    };

    await waitFor(() => {
      const text = [...(failedRuntime.pluginStorage.values?.keys?.() || [])]
        .map(key => String(failedRuntime.pluginStorage.values.get(key) ?? '')).join('\n');
      return /packet_debt|repair_pending|deterministic_fallback|recovery/i.test(text);
    }, 'durable recovery evidence', 20000).catch(() => {});

    const after = await storeSnapshot(failedRuntime.pluginStorage);
    observed.unusable.storageKeys = after.keys.length;
    observed.unusable.debtRecorded = /packet_debt/.test(after.text);
    observed.unusable.recoveryVocabulary = /repair_pending|deterministic_fallback|recovery/i.test(after.text);

    let inspection = null;
    try {
      inspection = await failedRuntime.hayaku._test.inspectRecoveryDebtsForNativeRepair?.({ includeEvidence: false });
      observed.unusable.inspection = inspection ? {
        available: inspection.available,
        reason: inspection.reason,
        coverageMode: inspection.coverage?.mode,
        missingTurns: inspection.coverage?.missingTurns,
        totalActiveDebts: inspection.totalActiveDebts,
        debtCount: Array.isArray(inspection.debts) ? inspection.debts.length : 0,
        repairableDebts: inspection.repairableDebts,
        exhaustedDebts: inspection.exhaustedDebts,
        nextRetryAt: inspection.nextRetryAt
      } : null;
    } catch (error) {
      observed.unusable.inspectionError = String(error?.message || error).slice(0, 140);
    }
    assert.equal(observed.unusable.inspectionError, undefined, 'cold-start debt inspection must complete');
    assert.equal(inspection?.reason, 'no_active_packet_debt');
    assert.equal(inspection?.coverage?.mode, 'cold_start');
    assert.equal(inspection?.totalActiveDebts, 0,
      'an uncovered first turn has no prior canonical packet anchor and is not incremental packet debt');

    const zeroTargetRuntime = await createHayakuRuntime({
      afterRequestAutoRepair: false,
      backgroundAutoRepair: false,
      messages: [user('z-u1', 'A first turn without an existing packet.'), { role: 'assistant', chatId: 'z-a1', id: 'z-a1', data: 'The first response has no prior packet anchor.', time: Date.now() }],
      llmResponder: async () => { throw new Error('ZERO_TARGET_MODEL_CALL_FORBIDDEN'); }
    });
    try {
      const before = await zeroTargetRuntime.hayaku.settingsControl.current();
      const saved = await zeroTargetRuntime.hayaku.settingsControl.apply({
        ...before,
        hayaku_after_request_auto_repair: 'true',
        hayaku_background_auto_repair: 'true'
      });
      assert.equal(saved.ok, true);
      assert.equal(saved.readbackVerified, true);
      const readback = await zeroTargetRuntime.hayaku.settingsControl.current();
      assert.equal(readback.hayaku_after_request_auto_repair, 'true');
      assert.equal(readback.hayaku_background_auto_repair, 'true');
      const zeroTargetRun = await zeroTargetRuntime.hayaku.recovery.repairNow({ reason: 'settings_enable_zero_targets' });
      observed.unusable.settingsEnabledWithoutTarget = {
        readbackVerified: saved.readbackVerified,
        reason: zeroTargetRun.reason,
        repaired: zeroTargetRun.repaired,
        totalActiveDebts: zeroTargetRun.totalActiveDebts,
        llmCalls: zeroTargetRuntime.llmCalls.length
      };
      assert.equal(zeroTargetRun.reason, 'no_active_packet_debt');
      assert.equal(zeroTargetRun.repaired, false);
      assert.equal(zeroTargetRun.totalActiveDebts, 0);
      assert.equal(zeroTargetRuntime.llmCalls.length, 0,
        'saving both auto-repair settings must not create targets or call a model on a first-use cold start');
    } finally {
      await zeroTargetRuntime.dispose?.();
    }

    // This is a cold-start transcript: turn 1 has no prior covered packet, so incremental
    // Recovery Journal inspection must not invent packet debt for it. Exercise the actual
    // recovery contract separately below with an eligible missing turn after a covered turn.
    await failedRuntime.dispose?.();
    const recoverRuntime = await createHayakuRuntime({
      afterRequestAutoRepair: true,
      backgroundAutoRepair: true,
      messages: eligibleMissingTurnMessages()
    });
    try {
      await registerCurrentTurn(recoverRuntime);
      recoverRuntime.setLlmResponder(async () => ({ type: 'success', result: 'unusable-after-request-output' }));
      const failedTurn = await recoverRuntime.hayaku._test.repairCurrentPacketInsideAfterRequest(ASSISTANT_TEXT, 'model');
      assert.equal(failedTurn, ASSISTANT_TEXT, 'failed afterRequest repair must preserve the visible response');
      recoverRuntime.chat.message.push({ role: 'assistant', chatId: 'r-a2', id: 'r-a2', data: failedTurn, time: Date.now() });
      recoverRuntime.chat.messages = recoverRuntime.chat.message;
      await recoverRuntime.hayaku._test.processRisuChatOutputEvent({
        char: recoverRuntime.character,
        chat: recoverRuntime.chat,
        characterIndex: 0,
        chatIndex: 0,
        messageIndex: 3
      });
      const eligible = await recoverRuntime.hayaku._test.inspectRecoveryDebtsForNativeRepair({ includeEvidence: true, limit: 8 });
      observed.unusable.recoveryEligibility = {
        reason: eligible.reason,
        coverageMode: eligible.coverage?.mode,
        missingTurns: eligible.coverage?.missingTurns,
        totalActiveDebts: eligible.totalActiveDebts,
        debtTurns: (eligible.debts || []).map(debt => debt.pairIndex)
      };
      assert.equal(eligible.reason, 'packet_debt_available');
      assert.equal(eligible.coverage?.mode, 'incremental_missing');
      assert.deepEqual(Array.from(eligible.coverage?.missingTurns || []), [2]);
      assert.deepEqual(Array.from(eligible.debts || []).map(debt => debt.pairIndex), [2]);

      const summary = ASSISTANT_TEXT;
      recoverRuntime.setLlmResponder(async () => ({ type: 'success', result: `Result:\n${JSON.stringify(nativeRecoveryEnvelope(summary))}` }));
      const recoveryResult = await recoverRuntime.hayaku.recovery.repairNow({ reason: 'e2e_eligible_missing_turn' });
      observed.unusable.recoveryWorks = recoveryResult.ok === true && recoveryResult.repaired === true;
      observed.unusable.recoveryCalls = recoverRuntime.llmCalls.length - 1;
      observed.unusable.recoveryResult = { ok: recoveryResult.ok, repaired: recoveryResult.repaired, reason: recoveryResult.reason || '' };
      const recoveredLedger = await recoverRuntime.hayaku.ledger.inspect({ includeRecords: true });
      observed.unusable.recoveryPacketStored = recoveredLedger.records.some(record => (
        record.packetType === 'recovery_snapshot'
        && record.recordState === 'active'
        && Number(record.targetPairIndex || 0) === 2
        && record.captureSource === 'bridge_incremental_recovery'
      ));
      const afterRecovery = await recoverRuntime.hayaku._test.inspectRecoveryDebtsForNativeRepair({ limit: 8 });
      observed.unusable.remainingRecoveryDebts = afterRecovery.totalActiveDebts;
      assert.equal(observed.unusable.recoveryWorks, true, JSON.stringify(recoveryResult));
      assert.equal(observed.unusable.recoveryCalls, 1);
      assert.equal(observed.unusable.recoveryPacketStored, true);
      assert.equal(observed.unusable.remainingRecoveryDebts, 0);
    } finally {
      await recoverRuntime.dispose?.();
    }
  } finally {
    await failedRuntime.dispose?.();
  }

  // ============================================================================================
  // Task 2.3 / 2.4 — the prompt the model actually received, and its difficulty.
  // ============================================================================================
  const recoveryCalls = prompts.filter(text => /TARGET TURN|CONTEXT ONLY/.test(text));
  observed.prompt = {
    totalCalls: prompts.length,
    recoveryCalls: recoveryCalls.length,
    hasTargetTurn: recoveryCalls.some(t => t.includes('[TARGET TURN]')),
    hasContextOnly: recoveryCalls.some(t => /CONTEXT ONLY/.test(t)),
    contextIsNonRecordable: recoveryCalls.some(t => /CONTEXT ONLY may resolve[\s\S]{0,120}?must not add events or changes/i.test(t)),
    hasRequiredLineage: recoveryCalls.some(t => /REQUIRED META\.LINEAGE/.test(t)),
    hasOutputDirective: recoveryCalls.some(t => /Return the single/.test(t)),
    minChars: recoveryCalls.length ? Math.min(...recoveryCalls.map(t => t.length)) : 0,
    maxChars: recoveryCalls.length ? Math.max(...recoveryCalls.map(t => t.length)) : 0
  };

  console.log(JSON.stringify({ test: 'hayaku_normal_and_recovery_e2e', observed }, null, 1));

  // --- assertions ---------------------------------------------------------------------------
  assert.equal(observed.normalTurn.minimalAccepted, true,
    'a minimal (summary-only) packet must be accepted; the contract calls it complete (task 4)');
  assert.ok(observed.normalTurn.packetAttached,
    'the accepted packet must be attached to the visible response (task 4)');
  assert.ok(observed.normalTurn.visibleTextPreserved,
    'the visible response must be preserved when a packet is attached (task 4)');
  assert.equal(observed.normalTurn.llmCalls, 1,
    'a turn missing its packet must cost exactly one model call (task 4)');
  assert.equal(observed.normalTurn.secondCallNoOp, true,
    'an already-usable packet must not trigger another call (task 4)');
  assert.ok(observed.unusable.visibleResponsePreserved,
    'an unusable answer must not damage the visible response (task 2.1)');
  // The first failed turn below is an uncovered cold-start with no earlier canonical packet, so
  // inspection correctly reports no active *incremental* packet debt. A second eligible scenario
  // has a covered turn 1 and a failed turn 2; it asserts durable Recovery Journal debt, exact
  // eligibility, successful native repair, packet readback, and debt discharge.
  observed.unusable.debtCreationCoveredBy = 'hayaku_native_otherax_recovery_runtime_test.cjs';
  assert.ok(observed.prompt.hasTargetTurn,
    'the model must receive a prompt marking the target turn (task 2.3)');
  assert.ok(observed.prompt.contextIsNonRecordable,
    'the prompt must forbid recording events from CONTEXT ONLY (task 2.3)');
  assert.ok(observed.normalTurn.storageKeys > 0,
    'HAYAKU must leave durable keys after the turn (task 1)');
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
