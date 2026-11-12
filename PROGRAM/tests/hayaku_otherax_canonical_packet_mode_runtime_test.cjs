'use strict';
// HAYAKU "otherAX로 정본 패킷 작성" (otherAX canonical-packet mode), driven through the plugin's
// own beforeRequest / afterRequest replacers and chat-output capture.
//
// ON : the response model receives no packet-writing prompt (recalled continuity only); the
//      afterRequest Other Ax call — the existing missing-packet recovery path — writes the
//      packet even when "afterRequest 자동 복구" is off, and the stored record is a canonical
//      current_snapshot whose authorship says otherAX wrote it.
// OFF: the packet-writing prompt is injected as before, and a repaired packet is still stored
//      as an automatic repair ('after_request_repair').
const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, createStore } = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data, time: Date.now() });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data, time: Date.now() });

const envelopeFor = (assistantText, l) => {
  const packet = createValidPacket({ turn: 1, summary: assistantText });
  packet.meta.packet_type = 'current_snapshot';
  packet.meta.lineage = {
    parent_turn_node_id: l.parentTurnNodeId || '', logical_turn_id: l.logicalTurnId, request_nonce: l.requestNonce,
    identity_version: 2, lineage_schema: l.lineageSchema, turn_owner_key: l.turnOwnerKey, generation_attempt_id: l.generationAttemptId
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

const bodyOf = message => typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '');

const runTurn = async ({ otherAx, afterRequestAutoRepair }) => {
  const assistantText = 'Alice turned the brass valve and steam began flowing through the blue pipe.';
  const rows = [user('ox-u1', 'I turn the brass valve.')];
  const pluginStorage = createStore();
  await pluginStorage.setItem('hayaku.v2.settings.source-tracking.v1', JSON.stringify({ mode: 'off', epoch: 0 }));
  const h = await createHayakuRuntime({
    pluginStorage,
    messages: rows, afterRequestAutoRepair, backgroundAutoRepair: false,
    arguments: otherAx === undefined ? {} : { hayaku_otherax_canonical_packet: otherAx ? 'true' : 'false' }
  });
  try {
    h.hayaku._test.stopWorldlineTopologyObserver();
    const injected = await h.callBeforeRequest([{ role: 'user', chatId: 'ox-u1', id: 'ox-u1', content: 'I turn the brass valve.' }], 'model');
    const before = h.hayaku.lastDebug().lastBeforeRequest;
    const scope = await h.hayaku._test.currentChatScope();
    const pending = h.hayaku._test.selectPendingCapture([], scope, 'model');
    assert.ok(pending, 'beforeRequest registers the turn capture');
    const l = pending.lineage;
    h.setLlmResponder(async () => ({ type: 'success', result: envelopeFor(assistantText, l) }));
    const response = await h.callAfterRequest(assistantText, 'model');
    const calls = h.llmCalls.length;
    let captured = null;
    if (response !== assistantText) {
      rows.push(assistant('ox-a1', response));
      h.setMessages(rows);
      await h.hayaku._test.processRisuChatOutputEvent({ char: h.character, chat: h.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
      for (const started = Date.now(); !captured && Date.now() - started < 15000; await new Promise(resolve => setTimeout(resolve, 50))) {
        captured = Array.from((await h.hayaku.ledger.inspect({ includeRecords: true })).records || [])
          .find(record => record.recordState === 'active' && Number(record.targetPairIndex) === 1) || null;
      }
    }
    return {
      injectedText: injected.map(bodyOf).join('\n'), before, pending: { ...pending }, response, calls, captured,
      origin: captured ? h.hayaku._test.viewerRecordOrigin(captured) : null,
      settings: h.hayaku.lastDebug().settings || null
    };
  } finally { await h.dispose(); }
};

(async () => {
  // OFF (default): writing prompt injected, repaired packet stays an automatic repair.
  const off = await runTurn({ otherAx: undefined, afterRequestAutoRepair: true });
  assert.match(off.injectedText, /HAYAKU_STATE_PACKET_START/, 'OFF: the packet-writing prompt is injected');
  assert.equal(off.before.packetWriteActive, true);
  assert.equal('packetWriteMode' in off.before, false, 'OFF: no otherAX diagnostic field');
  assert.equal('otherAxCanonicalPacket' in off.pending, false, 'OFF: the capture is not marked for otherAX');
  assert.equal(off.calls, 1, 'OFF: a missing packet uses the one afterRequest repair call');
  assert.ok(off.captured, 'OFF: repaired packet captured');
  assert.equal(off.captured.packetAuthor, 'after_request_repair');
  assert.equal(off.origin.label, '자동 복구');

  const offExplicit = await runTurn({ otherAx: false, afterRequestAutoRepair: true });
  assert.match(offExplicit.injectedText, /HAYAKU_STATE_PACKET_START/, 'explicit false is the default mode');
  assert.equal(offExplicit.captured.packetAuthor, 'after_request_repair');

  // OFF with afterRequest repair disabled keeps the journal-only behaviour (no call).
  const offNoRepair = await runTurn({ otherAx: false, afterRequestAutoRepair: false });
  assert.equal(offNoRepair.calls, 0, 'OFF: disabling afterRequest repair still makes no call');
  assert.equal(offNoRepair.response, 'Alice turned the brass valve and steam began flowing through the blue pipe.');

  // ON: no writing prompt; otherAX writes the canonical packet even with afterRequest repair off.
  const on = await runTurn({ otherAx: true, afterRequestAutoRepair: false });
  assert.doesNotMatch(on.injectedText, /HAYAKU_STATE_PACKET_START|HAYAKU_STATE_PACKET_END/, 'ON: no packet-writing prompt reaches the response model');
  assert.equal(on.before.packetWriteMode, 'otherax_canonical');
  assert.equal(on.before.packetWritePromptInjected, false);
  assert.equal(on.pending.otherAxCanonicalPacket, true);
  assert.equal(on.calls, 1, 'ON: Other Ax writes the packet once');
  assert.match(on.response, /HAYAKU_STATE_PACKET_START/, 'ON: the Other Ax packet is attached to the response');
  assert.ok(on.captured, 'ON: the otherAX packet is captured');
  assert.equal(on.captured.packetType || 'current_snapshot', 'current_snapshot', 'ON: stored as the turn packet, not a recovery packet');
  assert.equal(on.captured.packetAuthor, 'otherax_canonical', 'ON: authorship records otherAX');
  assert.notEqual(on.captured.packetAuthor, 'after_request_repair');
  assert.equal(on.origin.key, 'canonical', 'ON: classified as canonical');
  assert.equal(on.origin.label, '정본 패킷 · otherAX');

  // ON with afterRequest repair left on: the two never run together. The packet is still
  // written once, by otherAX as canonical, never as an afterRequest repair.
  const onWithAfter = await runTurn({ otherAx: true, afterRequestAutoRepair: true });
  assert.equal(onWithAfter.calls, 1, 'ON: exactly one Other Ax call per turn');
  assert.equal(onWithAfter.captured.packetAuthor, 'otherax_canonical');

  // otherAX pauses afterRequest auto repair at run time only. The saved switch keeps its value,
  // so turning otherAX off in a later edit brings the previous choice back.
  const s = await createHayakuRuntime({ afterRequestAutoRepair: true, arguments: { hayaku_otherax_canonical_packet: 'true' } });
  try {
    const savedValues = async () => { const saved = JSON.parse(await s.pluginStorage.getItem('hayaku.v2.settings.values.v1') || '{}'); return saved.values || saved; };
    const current = await s.hayaku.settingsControl.current();
    assert.equal(current.hayaku_otherax_canonical_packet, 'true');
    assert.equal(current.hayaku_after_request_auto_repair, 'true', 'otherAX on leaves the saved afterRequest value as it was');
    const on = await s.hayaku.settingsControl.apply({ hayaku_otherax_canonical_packet: 'true', hayaku_after_request_auto_repair: 'true' });
    assert.equal(on.ok, true, 'a save with both on passes readback: ' + JSON.stringify(on).slice(0, 400));
    assert.notEqual((await savedValues()).hayaku_after_request_auto_repair, 'false', 'saving with otherAX on never overwrites afterRequest with false');
    const off = await s.hayaku.settingsControl.apply({ hayaku_otherax_canonical_packet: 'false' });
    assert.equal(off.ok, true, 'turning otherAX off saves: ' + JSON.stringify(off).slice(0, 600));
    const afterOff = await s.hayaku.settingsControl.current();
    assert.equal(afterOff.hayaku_otherax_canonical_packet, 'false');
    assert.equal(afterOff.hayaku_after_request_auto_repair, 'true', 'turning otherAX off in a later edit restores afterRequest auto repair');
    // An explicit off choice made while otherAX is on is kept too.
    const choiceOff = await s.hayaku.settingsControl.apply({ hayaku_otherax_canonical_packet: 'true', hayaku_after_request_auto_repair: 'false' });
    assert.equal(choiceOff.ok, true);
    const back = await s.hayaku.settingsControl.apply({ hayaku_otherax_canonical_packet: 'false' });
    assert.equal(back.ok, true);
    assert.equal((await s.hayaku.settingsControl.current()).hayaku_after_request_auto_repair, 'false', 'an explicit off choice survives otherAX');
  } finally { await s.dispose(); }
  console.log('PASS hayaku_otherax_canonical_packet_mode_runtime_test');
})().catch(error => { console.error(error); process.exitCode = 1; });
