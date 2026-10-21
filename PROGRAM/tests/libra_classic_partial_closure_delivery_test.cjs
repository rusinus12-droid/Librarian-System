'use strict';
// The cross-artifact "continuity closure" stage (a separate successor pass with its own
// "LATER CANONICAL CONTINUITY EVIDENCE" section, closureFacts/closureApplied viewer fields and a
// currentness verdict) was retired with the legacy retrieval in 9c03c35
// (docs/LIBRA_UNIFIED_SEARCH_REPLACEMENT_CONTRACT_20261014.md). The unified engine delivers every
// selected canonical assertion as a plain `[canonical:canonical_assertion]` unit through the retained
// Classic hook. This suite holds the CURRENT contract on the same thread-lifecycle fixture:
//   - no closure diagnostics, viewer fields, rows or section exist any more;
//   - an accepted successor and an unlinked (pending) successor are both ordinary canonical evidence,
//     each bound to its sealed physical ref; neither is relabelled as closure or as current state;
//   - an unlinked successor never promotes the thread state: it stays storage-pending and the State
//     unit for the thread stays last-known;
//   - unrelated pending evidence does not block delivery of the accepted successor;
//   - the hook adds no provider call (checked by the shared packet helper).
const assert = require('node:assert/strict');
const { generated, query, rows, threadArtifact } = require('./fixtures/libra_q04_thread_fixture.cjs');
const { actualClassicPacket, deliveredClosureRows, assertNoForbiddenClosure } = require('./fixtures/libra_actual_classic_request.cjs');
const question = query[0].content;
const observations = [];
const retiredViewerFields = ['closureCurrentness', 'closureFacts', 'closureInjectedFacts', 'closureApplied', 'closureDeliveryComplete'];

const assertNoClosureSurface = (recall, packet) => {
  assert.equal(recall.diagnostics.recallContinuityClosure, undefined, 'the closure diagnostic is retired');
  const viewer = packet.actualClassic.viewer;
  for (const field of retiredViewerFields) assert.equal(viewer[field], undefined, `retired viewer field ${field} must be absent`);
  assert.equal(deliveredClosureRows(packet).length, 0);
  assert.equal((packet.evidencePacket.layers.memory || []).some(row => row.closure === true), false);
  assert.equal(packet.actualClassic.deliveredRows.some(row => row.closure === true || Number(row.closureFacts || 0) > 0), false);
  assert.equal(packet.actualClassic.block.includes('LATER CANONICAL CONTINUITY EVIDENCE'), false);
};
const unitLines = block => block.split('\n').filter(line => /^\(\d+\) \[/.test(line));

async function rejectedOnly() {
  const f = await generated(undefined, '', 'invalid_alias');
  try {
    const original = f.getMemory(1).canonicalArtifact.facts[0];
    const rejected = f.getMemory(6).canonicalArtifact.facts[0];
    assert.equal(rejected.values.thread.linkStatus, 'pending');
    assert.equal(rejected.values.thread.linkPendingReason, 'unknown_or_stale_candidate_alias');
    const recall = await f.r.api.previewUnifiedMemoryRecall(question);
    assert.equal(recall.diagnostics.memoryEngine.mode, 'unified');
    const packet = await actualClassicPacket(f, question, f.getManifest().scopeKey);
    assertNoClosureSurface(recall, packet);
    assertNoForbiddenClosure(packet, [rejected.text]);
    const block = packet.actualClassic.block;
    const lines = unitLines(block);
    assert.ok(block.includes(original.text) && block.includes(rejected.text), 'both canonical assertions are plain evidence');
    // The unlinked successor must not turn the thread state into a current/resolved value.
    const threadState = lines.filter(line => line.includes('narrative.threads'));
    assert.ok(threadState.length >= 1, 'the thread State unit is still delivered');
    for (const line of threadState) {
      assert.match(line, /\[state:state_last_known\]/, 'pending link keeps the thread state last-known');
      assert.equal(line.includes('이행'), false, 'the unlinked fulfilment is not folded into thread state');
    }
    assert.equal(lines.some(line => /\[state:state_current\] narrative\.threads/.test(line)), false);
    observations.push({ case: 'rejected_only', units: lines.length });
  } finally { await f.r.cleanup(); }
}

async function acceptedSuccessor() {
  const f = await generated();
  try {
    const original = f.getMemory(1).canonicalArtifact.facts[0];
    const accepted = f.getMemory(6).canonicalArtifact.facts[0];
    assert.equal(accepted.values.thread.linkStatus, 'accepted');
    const recall = await f.r.api.previewUnifiedMemoryRecall(question);
    const packet = await actualClassicPacket(f, question, f.getManifest().scopeKey);
    assertNoClosureSurface(recall, packet);
    const block = packet.actualClassic.block;
    assert.ok(block.includes(original.text) && block.includes(accepted.text));
    const delivered = packet.actualClassic.deliveredRows.filter(row => row.kind === 'canonical');
    assert.deepEqual(delivered.map(row => row.memoryId).sort(), [f.getMemory(1).memoryId, f.getMemory(6).memoryId].sort(),
      'each delivered canonical row is bound to its own durable memory');
    observations.push({ case: 'accepted_successor', rows: delivered.length });
  } finally { await f.r.cleanup(); }
}

async function pastQuestionHasNoTemporalClosure() {
  const f = await generated();
  try {
    const pastQuestion = 'T99 당시 오늘 열쇠를 돌려주겠다는 약속은 어떻게 되었나요?';
    const recall = await f.r.api.previewUnifiedMemoryRecall(pastQuestion);
    assert.equal(recall.diagnostics.recallContinuityClosure, undefined);
    assert.equal(recall.diagnostics.temporalAnchor, undefined, 'the retired temporal-anchor/closure stage reports nothing');
    const packet = await actualClassicPacket(f, pastQuestion, f.getManifest().scopeKey, { allowEmpty: true });
    assertNoClosureSurface(recall, packet);
    for (const text of [f.getMemory(1).canonicalArtifact.facts[0].text, f.getMemory(6).canonicalArtifact.facts[0].text]) {
      assert.ok(packet.actualClassic.block.includes(text), 'the lexical match still delivers plain evidence');
    }
    observations.push({ case: 'past_question', units: unitLines(packet.actualClassic.block).length });
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
    const packet = await actualClassicPacket(f, question, f.getManifest().scopeKey);
    assertNoClosureSurface(recall, packet);
    const block = packet.actualClassic.block;
    assert.ok(block.includes(accepted.text), 'the accepted successor is delivered despite unrelated pending evidence');
    const acceptedRow = packet.actualClassic.deliveredRows.find(row => row.memoryId === f.getMemory(6).memoryId);
    assert.ok(acceptedRow && acceptedRow.kind === 'canonical', 'the accepted successor is bound to its own durable memory');
    // The pending fact is a different promise; it is ordinary evidence at most, never closure.
    assertNoForbiddenClosure(packet, [pending.text]);
    observations.push({ case: 'mixed_accepted_and_pending', units: unitLines(block).length });
  } finally { await f.r.cleanup(); }
}

(async () => {
  await rejectedOnly();
  await acceptedSuccessor();
  await pastQuestionHasNoTemporalClosure();
  await mixedAcceptedAndPending();
  console.log(JSON.stringify({ test: 'libra_classic_partial_closure_delivery', passed: observations.length, boundary: 'retained Classic hook, sealed physical refs, exact source evidence; closure stage retired; controlled provider and plugin_only storage', observations }));
})().catch(error => { console.error(error); process.exitCode = 1; });
