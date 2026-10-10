'use strict';

const assert = require('node:assert/strict');
const {
  createHayakuRuntime,
  createValidPacket,
  waitFor
} = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data, time: Date.now() });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data, time: Date.now() });

const registerCurrentTurn = async runtime => {
  const scope = await runtime.hayaku._test.currentChatScope();
  const snapshot = runtime.hayaku._test.authoritativeChatSnapshot(scope.chatMessages, scope);
  const base = runtime.hayaku._test.requestLineageFor(scope.chatMessages, snapshot, scope, { nodes: [] });
  const lineage = runtime.hayaku._test.issueRequestGenerationIdentity(scope, base);
  assert.ok(lineage?.requestNonce && lineage?.logicalTurnId);
  const pending = runtime.hayaku._test.registerPendingCapture(scope, lineage, 'model', snapshot);
  assert.ok(pending);
  return { scope, snapshot, lineage, pending };
};

const currentEnvelope = (assistantText, lineage) => {
  const packet = createValidPacket({ turn: 1, summary: assistantText });
  packet.meta.packet_type = 'current_snapshot';
  packet.meta.lineage = lineage;
  packet.meta.turn_anchor = assistantText;
  packet.meta.summary_memory = {
    summary: assistantText,
    recallAnchors: [], recallAliases: {}, canonicalAnchors: [], mentionedEntityNames: [],
    directEvidenceSnippets: [assistantText], related_refs: [], confidence: 0.82
  };
  packet.entity = { characters: [], relations: [], pov_memories: [], secrets: [] };
  packet.world = { location: '', time: '', scene: '', weather: '', active_events: [], historical_events: [], world_rules: [], offscreen_threads: [], factions: [], regions: [] };
  packet.narrative = { scene_phase: '', current_arc: '', pacing: '', conflict_traces: [], scene_deltas: [], theme_motifs: [], critical_dialogue: [] };
  packet.planner = { continuity_locks: [], do_not_resolve_yet: [], consequence_ledger: [], payoff_tracker: [], open_invitations: [] };
  packet.importance = { overall: 0.72, reason: [assistantText] };
  return {
    schema: 'hayaku.native_repair_output.v1',
    packet,
    grounding: [{ path: 'meta.summary_memory.summary', source: 'target', evidence: [assistantText] }]
  };
};
const historicalEnvelope = assistantText => {
  const envelope = currentEnvelope(assistantText, {});
  envelope.packet.meta.packet_type = 'recovery_snapshot';
  delete envelope.packet.meta.lineage;
  return envelope;
};

(async () => {
  const assistantText = 'Alice turned the brass valve and steam began flowing through the blue pipe.';
  const runtime = await createHayakuRuntime({
    afterRequestAutoRepair: true,
    backgroundAutoRepair: false,
    messages: [user('after-u1', 'I turn the brass valve.')]
  });
  try {
    const { lineage } = await registerCurrentTurn(runtime);
    runtime.setLlmResponder(async () => ({ type: 'success', result: JSON.stringify(currentEnvelope(assistantText, {
      parent_turn_node_id: lineage.parentTurnNodeId || '',
      logical_turn_id: lineage.logicalTurnId,
      request_nonce: lineage.requestNonce,
      identity_version: 2,
      lineage_schema: lineage.lineageSchema,
      turn_owner_key: lineage.turnOwnerKey,
      generation_attempt_id: lineage.generationAttemptId
    })) }));
    const repaired = await runtime.hayaku._test.repairCurrentPacketInsideAfterRequest(assistantText, 'model');
    assert.match(repaired, /HAYAKU_STATE_PACKET_START/);
    const inspection = runtime.hayaku._test.packetCaptureInspectionFromText(repaired);
    assert.equal(inspection.validCount, 1);
    assert.equal(inspection.packets[0].packetType, 'current_snapshot');
    assert.equal(inspection.packets[0].requestNonce, lineage.requestNonce);
    assert.equal(runtime.llmCalls.length, 1);
    const unchanged = await runtime.hayaku._test.repairCurrentPacketInsideAfterRequest(repaired, 'model');
    assert.equal(unchanged, repaired, 'an already usable exact-lineage packet must not be called again');
    assert.equal(runtime.llmCalls.length, 1);
  } finally {
    await runtime.dispose();
  }

  const failedRuntime = await createHayakuRuntime({
    afterRequestAutoRepair: true,
    backgroundAutoRepair: true,
    messages: [user('failed-u1', 'I turn the brass valve.')],
    llmResponder: async () => ({ type: 'success', result: 'not-json-after-request' })
  });
  try {
    await registerCurrentTurn(failedRuntime);
    const returned = await failedRuntime.hayaku._test.repairCurrentPacketInsideAfterRequest(assistantText, 'model');
    assert.equal(returned, assistantText, 'a failed repair must preserve the visible assistant response byte-for-byte');
    assert.equal(failedRuntime.llmCalls.length, 1);
    failedRuntime.chat.message.push(assistant('failed-a1', returned));
    failedRuntime.chat.messages = failedRuntime.chat.message;
    await failedRuntime.hayaku._test.processRisuChatOutputEvent({
      char: failedRuntime.character,
      chat: failedRuntime.chat,
      characterIndex: 0,
      chatIndex: 0,
      messageIndex: 1
    });
    const scope = await failedRuntime.hayaku._test.currentChatScope();
    const vault = await failedRuntime.hayaku._test.loadRecoveryVault(scope.key, { force: true });
    assert.equal(vault.records.length, 1);
    const journal = vault.records[0];
    assert.equal(journal.user.text, 'I turn the brass valve.');
    assert.equal(journal.assistant.text, assistantText);
    assert.equal(journal.afterRequestRepair.outcome, 'failed_journal_required');
    assert.ok(journal.failedAnalysisId);
    const failure = await failedRuntime.hayaku._test.readFailedAnalysisArtifact(scope.key, journal.failedAnalysisId);
    assert.equal(failure.durable, true);
    assert.equal(failure.payload.attempts.length, 1);
    assert.equal(failure.payload.attempts[0].rawResponse, 'not-json-after-request');
    assert.deepEqual(Array.from(failure.payload.attempts[0].requestMessages || []), []);
    await waitFor(() => ['failed', 'idle'].includes(failedRuntime.hayaku.recovery.jobStatus()?.state || 'idle'), 'headless Recovery Journal confirmation refusal');
    assert.equal(failedRuntime.llmCalls.length, 1, 'journal creation must not start a background call without a visible confirmation UI');
    const absent = await failedRuntime.hayaku._test.resolveRecoveryJournalBackgroundConfirmation(true);
    assert.equal(absent.ok, false);
    assert.equal(absent.reason, 'recovery_confirmation_absent');
    assert.equal(failedRuntime.llmCalls.length, 1, 'headless confirmation failure remains zero-extra-call');
    const readback = await failedRuntime.hayaku._test.loadRecoveryVault(scope.key, { force: true });
    assert.equal(readback.records.length, 1, 'when confirmation UI is unavailable, exact Recovery Journal debt remains durable');
    // Finalized capture may defer the fresh debt preflight until its write ends.
    await waitFor(() => failedRuntime.hayaku.lastDebug().lastWarnings.includes('recovery_confirmation_ui_unavailable'), 'fresh headless confirmation refusal', 5000);
    assert.ok(failedRuntime.hayaku.lastDebug().lastWarnings.includes('recovery_confirmation_ui_unavailable'));
  } finally {
    await failedRuntime.dispose();
  }

  const journalOnlyRuntime = await createHayakuRuntime({
    afterRequestAutoRepair: false,
    backgroundAutoRepair: true,
    messages: [user('journal-only-u1', 'I inspect the sealed door.')]
  });
  try {
    await registerCurrentTurn(journalOnlyRuntime);
    const returned = await journalOnlyRuntime.hayaku._test.repairCurrentPacketInsideAfterRequest(assistantText, 'model');
    assert.equal(returned, assistantText);
    assert.equal(journalOnlyRuntime.llmCalls.length, 0, 'disabling afterRequest repair must not disable journal preservation');
    journalOnlyRuntime.chat.message.push(assistant('journal-only-a1', returned));
    journalOnlyRuntime.chat.messages = journalOnlyRuntime.chat.message;
    await journalOnlyRuntime.hayaku._test.processRisuChatOutputEvent({
      char: journalOnlyRuntime.character,
      chat: journalOnlyRuntime.chat,
      characterIndex: 0,
      chatIndex: 0,
      messageIndex: 1
    });
    const scope = await journalOnlyRuntime.hayaku._test.currentChatScope();
    const journal = await journalOnlyRuntime.hayaku._test.loadRecoveryVault(scope.key, { force: true });
    assert.equal(journal.records.length, 1);
    assert.equal(journal.records[0].afterRequestRepair.outcome, 'disabled_journal_only');
    await waitFor(() => ['failed', 'idle'].includes(journalOnlyRuntime.hayaku.recovery.jobStatus()?.state || 'idle'), 'headless independent background confirmation refusal');
    assert.equal(journalOnlyRuntime.llmCalls.length, 0, 'background auto repair must not start without explicit visible confirmation');
    const absent = await journalOnlyRuntime.hayaku._test.resolveRecoveryJournalBackgroundConfirmation(false);
    assert.equal(absent.ok, false);
    assert.equal(absent.reason, 'recovery_confirmation_absent');
    assert.equal(journalOnlyRuntime.llmCalls.length, 0);
    const retained = await journalOnlyRuntime.hayaku._test.loadRecoveryVault(scope.key, { force: true });
    assert.equal(retained.records.length, 1, 'unavailable confirmation UI keeps the Journal entry for manual handling');
    assert.equal(retained.records[0].backgroundDecision, 'pending');
  } finally {
    await journalOnlyRuntime.dispose();
  }

  console.log('PASS hayaku_after_request_recovery_journal_runtime_test');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
