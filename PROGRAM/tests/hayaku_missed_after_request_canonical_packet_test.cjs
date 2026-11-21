'use strict';
// otherAX canonical-packet mode writes a turn's packet inside afterRequest. Live chat 2026-11-17
// (T12): the reply finished but the host never called afterRequest, so the turn stayed 패킷 누락
// until someone pressed repair. The finalized live-chat capture now runs that same single-turn
// repair once when afterRequest never ran, and leaves turns alone when afterRequest did run.
const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, createStore } = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data, time: Date.now() });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data, time: Date.now() });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const envelopeFor = (assistantText, lineage) => {
  const packet = createValidPacket({ turn: 1, summary: assistantText });
  packet.meta.packet_type = 'current_snapshot';
  if (lineage) packet.meta.lineage = {
    parent_turn_node_id: lineage.parentTurnNodeId || '', logical_turn_id: lineage.logicalTurnId, request_nonce: lineage.requestNonce,
    identity_version: 2, lineage_schema: lineage.lineageSchema, turn_owner_key: lineage.turnOwnerKey, generation_attempt_id: lineage.generationAttemptId
  };
  packet.meta.turn_anchor = assistantText;
  packet.meta.summary_memory = {
    summary: assistantText, recallAnchors: [], recallAliases: {}, canonicalAnchors: [], mentionedEntityNames: [],
    directEvidenceSnippets: [assistantText], related_refs: [], confidence: 0.82
  };
  packet.entity = { characters: [], relations: [], pov_memories: [], secrets: [] };
  packet.world = { location: '', time: '', scene: '', weather: '', active_events: [], historical_events: [], world_rules: [], offscreen_threads: [], factions: [], regions: [] };
  packet.narrative = { scene_phase: '', current_arc: '', pacing: '', conflict_traces: [], scene_deltas: [], theme_motifs: [], critical_dialogue: [] };
  packet.planner = { continuity_locks: [], do_not_resolve_yet: [], consequence_ledger: [], payoff_tracker: [], open_invitations: [] };
  packet.importance = { overall: 0.72, reason: [assistantText] };
  return JSON.stringify({ schema: 'hayaku.native_repair_output.v1', packet, grounding: [{ path: 'meta.summary_memory.summary', source: 'target', evidence: [assistantText] }] });
};

const run = async ({ callAfterRequest }) => {
  const assistantText = 'Alice turned the brass valve and steam began flowing through the blue pipe.';
  const rows = [user('mx-u1', 'I turn the brass valve.')];
  const pluginStorage = createStore();
  await pluginStorage.setItem('hayaku.v2.settings.source-tracking.v1', JSON.stringify({ mode: 'off', epoch: 0 }));
  const h = await createHayakuRuntime({
    pluginStorage, messages: rows, afterRequestAutoRepair: false, backgroundAutoRepair: false,
    arguments: { hayaku_otherax_canonical_packet: 'true' },
    // The chat output listener is silent, as in the live run, so capture falls back to watching the
    // finalized chat; the repair grace period is shortened for the test.
    transformSource: source => {
      const out = source
        .replace('MISSED_AFTER_REQUEST_REPAIR_DELAY_MS = 15000', 'MISSED_AFTER_REQUEST_REPAIR_DELAY_MS = 50')
        .replace('      if (chatOutputRegistered) {\n        Memory.captureBackend = HAYAKU_CAPTURE_BACKENDS.CHAT_OUTPUT_V3;', '      if (false) {\n        Memory.captureBackend = HAYAKU_CAPTURE_BACKENDS.CHAT_OUTPUT_V3;');
      if (out.includes('if (chatOutputRegistered) {\n        Memory.captureBackend')) throw new Error('capture backend switch not found');
      return out;
    }
  });
  try {
    h.hayaku._test.stopWorldlineTopologyObserver();
    await h.callBeforeRequest([{ role: 'user', chatId: 'mx-u1', id: 'mx-u1', content: 'I turn the brass valve.' }], 'model');
    const scope = await h.hayaku._test.currentChatScope();
    const pending = h.hayaku._test.selectPendingCapture([], scope, 'model');
    assert.ok(pending?.otherAxCanonicalPacket, 'the turn is registered for an otherAX canonical packet');
    h.setLlmResponder(async () => ({ type: 'success', result: envelopeFor(assistantText, null) }));
    if (callAfterRequest) {
      // afterRequest runs but its otherAX call fails: the turn is left for the user, as before.
      h.setLlmResponder(async () => ({ type: 'fail', result: 'provider down' }));
      await h.callAfterRequest(assistantText, 'model');
      h.setLlmResponder(async () => ({ type: 'success', result: envelopeFor(assistantText, null) }));
    }
    rows.push(assistant('mx-a1', assistantText));
    h.setMessages(rows);
    const log = () => (h.hayaku._test.operationLogSnapshot?.() || []).map(entry => entry.event);
    let captured = null;
    for (const started = Date.now(); Date.now() - started < 30000; await sleep(100)) {
      captured = Array.from((await h.hayaku.ledger.inspect({ includeRecords: true })).records || [])
        .find(record => record.recordState === 'active' && Number(record.targetPairIndex) === 1) || null;
      if (captured || (callAfterRequest && log().includes('capture:packet_missing') && Date.now() - started > 3000)) break;
    }
    return { captured, events: log(), calls: h.llmCalls.length };
  } finally { await h.dispose(); }
};

(async () => {
  const missed = await run({ callAfterRequest: false });
  assert.ok(missed.events.includes('capture:packet_missing'), 'the finalized reply is first seen without a packet: ' + missed.events.join(','));
  assert.ok(missed.events.includes('native_recovery:missed_after_request_repair_scheduled'), 'a repair is scheduled for the missed afterRequest');
  assert.ok(missed.captured, 'the packet is written without pressing repair: ' + missed.events.filter(e => /native_recovery|capture/.test(e)).join(','));
  assert.equal(missed.calls, 1, 'one otherAX call, the one afterRequest would have made');

  const ran = await run({ callAfterRequest: true });
  assert.ok(!ran.events.includes('native_recovery:missed_after_request_repair_scheduled'), 'a turn whose afterRequest ran is left to the user');
  console.log('PASS hayaku_missed_after_request_canonical_packet_test');
})().catch(error => { console.error(error); process.exitCode = 1; });
