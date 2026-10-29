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
    // The repaired packet is captured from the chat output like any packet, but keeps its authorship
    // so the GUI can show it as an automatic repair rather than a main-model packet.
    runtime.chat.message.push(assistant('after-a1', repaired));
    runtime.chat.messages = runtime.chat.message;
    await runtime.hayaku._test.processRisuChatOutputEvent({ char: runtime.character, chat: runtime.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
    let captured = null;
    for (const started = Date.now(); !captured && Date.now() - started < 15000; await new Promise(resolve => setTimeout(resolve, 50))) {
      captured = Array.from((await runtime.hayaku.ledger.inspect({ includeRecords: true })).records || [])
        .find(record => record.recordState === 'active' && Number(record.targetPairIndex) === 1) || null;
    }
    assert.ok(captured, 'repaired packet captured from the chat output');
    assert.equal(captured.packetAuthor, 'after_request_repair', 'an afterRequest-repaired packet records its authorship');
    assert.equal(runtime.hayaku._test.viewerRecordOrigin(captured).label, '자동 복구');
  } finally {
    await runtime.dispose();
  }

  const failedRuntime = await createHayakuRuntime({
    arguments: { hayaku_debug: 'true' },
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
    const automaticLease = await failedRuntime.hayaku._test.acquireRecoveryDebtLeaseForNativeRepair({
      debtId: journal.recordId, runId: 'review-stale-automatic-approval', scopeKey: scope.key,
      explicitRetry: true, requireAutoApproval: true
    });
    assert.equal(automaticLease.acquired, false, 'a stale automatic approval cannot bypass fresh failed repair provenance at lease acquisition');
    assert.equal(automaticLease.reason, 'recovery_journal_auto_approval_changed');
    assert.equal(failedRuntime.llmCalls.length, 1);
    const failure = await failedRuntime.hayaku._test.readFailedAnalysisArtifact(scope.key, journal.failedAnalysisId);
    assert.equal(failure.durable, true);
    assert.equal(failure.payload.attempts.length, 1);
    assert.equal(failure.payload.attempts[0].rawResponse, 'not-json-after-request');
    assert.deepEqual(Array.from(failure.payload.attempts[0].requestMessages || []), []);
    await waitFor(() => ['failed', 'idle'].includes(failedRuntime.hayaku.recovery.jobStatus()?.state || 'idle'), 'headless Recovery Journal confirmation refusal');
    assert.equal(failedRuntime.llmCalls.length, 1, 'journal creation never starts a background call');
    const absent = await failedRuntime.hayaku._test.resolveRecoveryJournalBackgroundConfirmation(true);
    assert.equal(absent.ok, false);
    assert.equal(absent.reason, 'recovery_confirmation_absent');
    assert.equal(failedRuntime.llmCalls.length, 1, 'headless confirmation failure remains zero-extra-call');
    const readback = await failedRuntime.hayaku._test.loadRecoveryVault(scope.key, { force: true });
    assert.equal(readback.records.length, 1, 'when confirmation UI is unavailable, exact Recovery Journal debt remains durable');
    // afterRequest is the only automatic stage: a failed turn gets no background
    // repair and no confirmation dialog, only the durable Journal entry.
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.ok(!failedRuntime.hayaku.lastDebug().lastWarnings.includes('recovery_confirmation_ui_unavailable'), 'no confirmation dialog is requested');
    assert.equal(failedRuntime.llmCalls.length, 1, 'a failed afterRequest repair is never retried automatically');
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
    assert.equal(journalOnlyRuntime.llmCalls.length, 0, 'the retired background stage never calls Other Ax');
    const absent = await journalOnlyRuntime.hayaku._test.resolveRecoveryJournalBackgroundConfirmation(false);
    assert.equal(absent.ok, false);
    assert.equal(absent.reason, 'recovery_confirmation_absent');
    assert.equal(journalOnlyRuntime.llmCalls.length, 0);
    const retained = await journalOnlyRuntime.hayaku._test.loadRecoveryVault(scope.key, { force: true });
    assert.equal(retained.records.length, 1, 'the Journal entry stays for manual repair');
    assert.equal(Number(retained.records[0].backgroundPromptedAt || 0), 0, 'the retired background stage never prompts');
    assert.ok(!journalOnlyRuntime.hayaku.lastDebug().lastWarnings.includes('recovery_confirmation_ui_unavailable'));
  } finally {
    await journalOnlyRuntime.dispose();
  }

  // Exercise the actual beforeRequest ledger writer, not a manually armed capture.
  // Change a readset setting during its write; recall must fail closed while the
  // independent, source-bound afterRequest repair still gets one chance.
  for(const editPrefix of [false,true]){
    const rows=[user('independent-u1','I inspect the valve.'),assistant('independent-a1','The valve is closed.'),user('independent-u2','I turn the brass valve.')];
    const h=await createHayakuRuntime({messages:rows,afterRequestAutoRepair:true,backgroundAutoRepair:false});
    try{
      h.hayaku._test.stopWorldlineTopologyObserver();
      const write=h.pluginStorage.setItem.bind(h.pluginStorage);let changed=false;
      h.pluginStorage.setItem=async(key,value)=>{
        const result=await write(key,value);
        if(!changed&&String(key).startsWith('hayaku.v2.ledger.')){
          changed=true;h.argumentsMap.set('hayaku_mode','quality');
        }
        return result;
      };
      await h.callBeforeRequest([{role:'user',chatId:'independent-u2',id:'independent-u2',content:'I turn the brass valve.'}],'model');
      assert.equal(changed,true,'fault entered real ledger write');
      assert.equal(h.hayaku.lastDebug().lastBeforeRequest.reason,'HAYAKU_READSET_AUTHORITY_CHANGED');
      assert.ok(h.hayaku.lastDebug().lastBeforeRequest.authorityFailure);
      const scope=await h.hayaku._test.currentChatScope();
      const pending=h.hayaku._test.selectPendingCapture([],scope,'model');
      assert.ok(pending,'request capture survives recall rejection');
      if(editPrefix){rows[1].data='The earlier scene has changed.';h.setMessages(rows);}
      const l=pending.lineage;
      h.setLlmResponder(async()=>({type:'success',result:JSON.stringify(currentEnvelope(assistantText,{
        parent_turn_node_id:l.parentTurnNodeId,logical_turn_id:l.logicalTurnId,request_nonce:l.requestNonce,
        identity_version:2,lineage_schema:l.lineageSchema,turn_owner_key:l.turnOwnerKey,generation_attempt_id:l.generationAttemptId
      }))}));
      const response=await h.callAfterRequest(assistantText,'model');
      assert.equal(h.llmCalls.length,editPrefix?0:1,'one repair only for unchanged source');
      assert.equal(response!==assistantText,!editPrefix);
      await h.callAfterRequest(response,'model');
      assert.equal(h.llmCalls.length,editPrefix?0:1,'repeated afterRequest must not resend');
    }finally{await h.dispose();}
  }
  console.log('PASS hayaku_after_request_recovery_journal_runtime_test');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
