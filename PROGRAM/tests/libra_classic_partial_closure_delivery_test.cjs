'use strict';
// Removing partial closure additions from packet preparation must fail the mixed
// case. Promoting pending facts or an unresolved temporal cursor must fail the
// exclusions. All witnesses come from the retained Classic hook and sealed refs.
const assert = require('node:assert/strict');
const { generated, query, rows, threadArtifact } = require('./fixtures/libra_q04_thread_fixture.cjs');
const { actualClassicPacket, deliveredClosureRows, assertNoForbiddenClosure } = require('./fixtures/libra_actual_classic_request.cjs');
const question = query[0].content;
const coverageWarning = 'Canonical continuity coverage is incomplete.';
const closureLayers = packet => (packet.evidencePacket.layers.memory || []).filter(row => row.closure === true);
const observations = [];

async function rejectedOnly() {
  const f = await generated(undefined, '', 'invalid_alias');
  try {
    const rejected = f.getMemory(6).canonicalArtifact.facts[0];
    assert.equal(rejected.values.thread.linkStatus, 'pending');
    assert.equal(rejected.values.thread.linkPendingReason, 'unknown_or_stale_candidate_alias');
    const recall = await f.r.api.previewUnifiedMemoryRecall(question);
    const closure = recall.diagnostics.recallContinuityClosure;
    assert.equal(closure.currentness, 'last-known');
    assert.equal(closure.closureComplete, false);
    assert.equal(closure.facts.length, 0);
    const packet = await actualClassicPacket(f, question, f.getManifest().scopeKey);
    const viewer = packet.actualClassic.viewer;
    assert.equal(viewer.closureCurrentness, 'last-known');
    assert.equal(viewer.closureFacts, 0);
    assert.equal(viewer.closureInjectedFacts, 0);
    assert.equal(viewer.closureApplied, false);
    assert.equal(viewer.closureDeliveryComplete, false);
    assert.equal(closureLayers(packet).length, 0);
    assert.equal(deliveredClosureRows(packet).length, 0);
    assertNoForbiddenClosure(packet, [rejected.text]);
    assert.ok(packet.actualClassic.block.includes(coverageWarning));
    observations.push({ case: 'rejected_only', currentness: viewer.closureCurrentness, prepared: viewer.closureFacts, injected: viewer.closureInjectedFacts });
  } finally { await f.r.cleanup(); }
}

async function unknownTemporalCursor() {
  const f = await generated();
  try {
    const accepted = f.getMemory(6).canonicalArtifact.facts[0];
    const current = await actualClassicPacket(f, question, f.getManifest().scopeKey);
    assert.equal(deliveredClosureRows(current).length, 1, 'the same store has a deliverable accepted successor before the unresolved query');
    const pastQuestion = 'T99 당시 오늘 열쇠를 돌려주겠다는 약속은 어떻게 되었나요?';
    const recall = await f.r.api.previewUnifiedMemoryRecall(pastQuestion);
    const closure = recall.diagnostics.recallContinuityClosure;
    assert.equal(recall.diagnostics.temporalAnchor.status, 'unavailable');
    assert.equal(closure.currentness, 'unknown');
    assert.equal(closure.closureComplete, false);
    assert.ok(closure.diagnostics.reasons.includes('temporal_anchor_unavailable'));
    assert.equal(closure.facts.length, 0);
    const packet = await actualClassicPacket(f, pastQuestion, f.getManifest().scopeKey, { allowEmpty: true });
    const viewer = packet.actualClassic.viewer;
    assert.equal(packet.evidencePacket.temporal_scope.status, 'unavailable');
    assert.equal(viewer.closureCurrentness, 'unknown');
    assert.equal(viewer.closureFacts, 0);
    assert.equal(viewer.closureInjectedFacts, 0);
    assert.equal(viewer.closureApplied, false);
    assert.equal(viewer.closureDeliveryComplete, false);
    assert.equal(closureLayers(packet).length, 0);
    assert.equal(deliveredClosureRows(packet).length, 0);
    assert.equal(packet.actualClassic.deliveredRows.some(row => row.closure === true || Number(row.closureFacts || 0) > 0), false);
    assertNoForbiddenClosure(packet, [accepted.text]);
    observations.push({ case: 'unknown_temporal_cursor', temporalAnchor: viewer.temporalAnchor.status, currentness: viewer.closureCurrentness, prepared: viewer.closureFacts, injected: viewer.closureInjectedFacts });
  } finally { await f.r.cleanup(); }
}

async function mixedAcceptedAndPending() {
  const f = await generated();
  try {
    const accepted = f.getMemory(6).canonicalArtifact.facts[0];
    for (let turn = 11; turn <= 15; turn += 1) {
      const pair = ['민아와 지호는 기록회 확인 약속을 살폈다.', '지호는 민아에게 기록회 확인 약속이 이행되었다고 주장했다.'];
      for (const [index, role] of ['user', 'assistant'].entries()) {
        rows.push({ turn, role, text: pair[index] });
        f.chat.message.push({ role, chatId: `t${turn}-${index ? 'a' : 'u'}`, data: pair[index] });
      }
    }
    f.control.onCall = () => ({ type: 'success', result: JSON.stringify(threadArtifact({
      turn: 15, threadEntityName: '기록회 확인 약속', summary: '기록회 확인 약속이 이행되었다',
      status: 'resolved', link: 'resolve', resolution: 'fulfilled', alias: 'foreign_request_alias'
    })) });
    assert.equal((await f.run()).completed, 1);
    const pending = f.getMemory(11).canonicalArtifact.facts[0];
    assert.equal(pending.values.thread.linkStatus, 'pending');
    assert.equal(pending.values.thread.linkPendingReason, 'unknown_or_stale_candidate_alias');
    const settings = await f.r.api.getLibraMemorySettings();
    await f.r.api.saveLibraMemorySettings({ ...settings, recallQueryMessages: 1 });
    const recall = await f.r.api.previewUnifiedMemoryRecall(question);
    assert.equal(recall.memories.length, 1);
    assert.equal(recall.memories[0].memory.memoryId, f.getMemory(1).memoryId);
    const closure = recall.diagnostics.recallContinuityClosure;
    assert.equal(closure.currentness, 'last-known');
    assert.equal(closure.closureComplete, false);
    assert.equal(closure.diagnostics.pendingThreadCandidates, 1);
    assert.equal(closure.diagnostics.linkTargetChecks, 1);
    assert.equal(closure.diagnostics.linkTargetRejected, 0);
    assert.deepEqual(Array.from(closure.facts, row => row.text), [accepted.text]);
    const packet = await actualClassicPacket(f, question, f.getManifest().scopeKey);
    const viewer = packet.actualClassic.viewer;
    const ordinary = viewer.rows.filter(row => row.closure !== true);
    assert.equal(ordinary.length, 1);
    assert.equal(ordinary[0].memoryId, f.getMemory(1).memoryId,
      'the actual request also selects only the original promise');
    assert.equal(viewer.closureCurrentness, 'last-known');
    const actualClosures = deliveredClosureRows(packet);
    assert.equal(actualClosures.length, 1, 'one revalidated successor is actually delivered despite unrelated pending evidence');
    assert.equal(actualClosures[0].text, accepted.text);
    assert.equal(closureLayers(packet).length, 1);
    assert.equal(viewer.closureCurrentness, 'last-known');
    assert.equal(viewer.closureFacts, 1);
    assert.equal(viewer.closureInjectedFacts, 1);
    assert.equal(viewer.closureApplied, true);
    assert.equal(viewer.closureDeliveryComplete, false, 'partial coverage is never promoted to complete delivery');
    assert.ok(packet.actualClassic.block.includes(accepted.evidenceSpans[0].ref));
    assert.ok(packet.actualClassic.block.includes(accepted.evidenceSpans[0].quote));
    assert.ok(packet.actualClassic.block.includes(coverageWarning));
    assert.ok(packet.actualClassic.block.includes('Earlier open, resolved, or closed statuses are last-known evidence only'));
    assertNoForbiddenClosure(packet, [pending.text]);
    assert.ok(viewer.classicEvidenceChars <= viewer.evidenceCharCeiling);
    assert.ok(viewer.classicEvidenceTokens <= viewer.tokenCeiling);
    observations.push({ case: 'mixed_accepted_and_pending', currentness: viewer.closureCurrentness, prepared: viewer.closureFacts, injected: viewer.closureInjectedFacts, deliveryComplete: viewer.closureDeliveryComplete, pending: closure.diagnostics.pendingThreadCandidates, validated: closure.diagnostics.linkTargetChecks });
  } finally { await f.r.cleanup(); }
}

(async () => {
  await rejectedOnly();
  await unknownTemporalCursor();
  await mixedAcceptedAndPending();
  console.log(JSON.stringify({ test: 'libra_classic_partial_closure_delivery', passed: 1, boundary: 'retained Classic hook, sealed physical refs, exact source evidence; controlled provider and plugin_only storage', observations }));
})().catch(error => { console.error(error); process.exitCode = 1; });
