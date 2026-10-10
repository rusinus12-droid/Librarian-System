'use strict';
// B4: an unaccepted v5 lifecycle event stays independent in State and cannot
// become a Recall successor merely because its generic thread title matches.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { actualClassicPacket, deliveredClosureRows, assertNoForbiddenClosure } = require('./fixtures/libra_actual_classic_request.cjs');

const rows = [];
const pairs = [
  ['민아는 지호와 서재에서 이야기했다.', '지호는 민아에게 오늘 저녁 은빛 열쇠 반환 약속을 했다.'],
  ['민아는 서재를 정리했다.', '도서관은 저녁까지 열려 있었다.'],
  ['지호는 공연실에 갔다.', '공연 준비는 계속되었다.'],
  ['민아는 책을 읽었다.', '지호는 서재로 돌아왔다.'],
  ['두 사람은 잠시 기다렸다.', '열쇠 반환은 아직 확인되지 않았다.'],
  ['민아는 지호를 서재에서 기다렸다.', '지호는 민아에게 오늘 저녁 은빛 열쇠 반환 약속을 이행했다고 말했다.'],
  ['도서관의 불이 켜졌다.', '공연실은 비어 있었다.'],
  ['민아는 기록을 정리했다.', '지호는 문 앞에 멈췄다.'],
  ['두 사람은 서재에 있었다.', '책상 위에는 종이가 놓여 있었다.'],
  ['도서관은 문을 닫았다.', '그날의 대화가 끝났다.']
];
for (let index = 0; index < pairs.length; index += 1) {
  const turn = index + 1;
  rows.push({ turn, role: 'user', text: pairs[index][0] });
  rows.push({ turn, role: 'assistant', text: pairs[index][1] });
}
const chat = {
  id: 'thread-pending-recall-chat',
  chatId: 'thread-pending-recall-chat',
  name: 'Pending lifecycle Recall boundary',
  message: rows.map(row => ({ role: row.role, chatId: `t${row.turn}-${row.role === 'user' ? 'u' : 'a'}`, data: row.text }))
};
const quote = (turn, role) => {
  const row = rows.find(item => item.turn === turn && item.role === role);
  return { ref: `t${turn}-${role === 'user' ? 'u' : 'a'}`, quote: row.text };
};
const artifact = ({ turn, status, link = '', resolution = '', text }) => ({
  schema: 'libra.canonical_artifact.v5',
  entities: [
    { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', evidenceSpans: [quote(turn, 'assistant')] },
    { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: [quote(turn, 'assistant')] },
    { tempId: 'promise', name: '오늘 저녁 은빛 열쇠 반환 약속', type: 'world', kind: 'thread', evidenceSpans: [quote(turn, 'assistant')] }
  ],
  facts: [{
    tempFactId: `promise_${turn}`, domain: 'narrative', subjectTempRef: 'promise', claimKind: 'thread',
    values: { thread: {
      summary: '오늘 저녁 은빛 열쇠 반환 약속', status, kind: 'promise',
      participants: [
        { role: 'owner', personTempRef: 'jiho' },
        { role: 'target', personTempRef: 'mina' }
      ],
      ...(link ? { link } : {}), ...(resolution ? { resolution } : {})
    } },
    text, temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: [quote(turn === 1 ? 5 : turn, 'assistant')]
  }]
});

(async () => {
  const f = await fixture({ snapshot: { chat } });
  try {
    const debugBatch = Array.from({ length: 5 }, (_, index) => ({
      turn: index + 1,
      user: { text: rows.find(row => row.turn === index + 1 && row.role === 'user').text },
      assistant: { text: rows.find(row => row.turn === index + 1 && row.role === 'assistant').text }
    }));
    const validation = f.r.api.debugPrepareUnifiedMemoryArtifact(
      artifact({ turn: 1, status: 'open', text: '지호는 오늘 저녁 은빛 열쇠 반환 약속을 했다.' }), debugBatch);
    if (!validation.artifact?.facts?.length) throw new Error(JSON.stringify(validation.admission));
    const calls = [];
    f.control.onCall = args => {
      const user = args[0]?.messages?.find(row => row.role === 'user')?.content || '';
      const match = user.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
      calls.push(match ? JSON.parse(match[1]) : []);
      f.control.artifact = calls.length === 1
        ? artifact({ turn: 1, status: 'open', text: '열쇠 반환은 아직 확인되지 않았다.' })
        : artifact({ turn: 6, status: 'resolved', link: 'resolve', resolution: 'fulfilled', text: '지호는 민아에게 오늘 저녁 은빛 열쇠 반환 약속을 완료했다고 말했다.' });
      return { type: 'success', result: JSON.stringify(f.control.artifact) };
    };

    const result = await f.run();
    assert.equal(result.completed, 2, JSON.stringify(result));
    assert.equal(calls[0].length, 0);
    assert.equal(calls[1].length, 1, 'the second analysis was given the prior request-local candidate alias');
    assert.deepEqual(calls[1][0].participants, [
      { role: 'owner', name: '지호' }, { role: 'target', name: '민아' }
    ]);

    const first = f.getMemory(1);
    const second = f.getMemory(6);
    const prior = first.canonicalArtifact.facts[0].values.thread;
    const pending = second.canonicalArtifact.facts[0].values.thread;
    assert.equal(prior.linkStatus, 'new');
    assert.equal(pending.linkStatus, 'pending', 'omitting this request\'s alias leaves an independently stored pending event');
    assert.equal(pending.linkPendingReason, 'target_alias_required');
    assert.equal(f.getHead().narrative.threads.length, 1, 'the unresolved relation does not close the open State lifecycle');
    assert.equal(f.getHead().narrative.threads[0].status, 'open');

    const settings = await f.r.api.getLibraMemorySettings();
    await f.r.api.saveLibraMemorySettings({ ...(settings?.settings || settings || {}), recallMaxMemories: 1, recallQueryMessages: 1 });
    const query = '열쇠 반환은 아직 확인되지 않았다';
    const recall = await f.r.api.previewUnifiedMemoryRecall(query);
    assert.equal(recall.memories.length, 1);
    assert.equal(recall.memories[0].memory.memoryId, first.memoryId, 'Recall selected only the original open promise');
    const pendingText = second.canonicalArtifact.facts[0].text;
    assert.equal(JSON.stringify(recall.memories.map(row => row.excerpt || row.text || '')).includes(pendingText), false,
      'Recall selection did not already contain the pending event');
    const recallClosure = recall?.diagnostics?.recallContinuityClosure;
    const closureRows = recallClosure?.facts || [];
    assert.equal(closureRows.some(row => row.memoryId === second.memoryId), false,
      'the pending fact is retained in Canonical/History but is not emitted as an accepted lifecycle closure');
    assert.equal(recallClosure?.diagnostics?.closureCount, 0,
      'the pending relation contributes no closure row');
    assert.equal(recallClosure?.currentness, 'last-known',
      'an unaddressed v5 event prevents Recall from claiming the selected promise is current');
    assert.ok(recallClosure?.diagnostics?.reasons?.some(reason => reason.startsWith('thread_lifecycle_pending_not_authorized:')),
      'the lack of lifecycle authority is disclosed in Recall diagnostics');
    const preflight = await actualClassicPacket(f, query, first.scopeKey);
    const packetClosureRows = (preflight?.evidencePacket?.layers?.memory || []).filter(row => row.closure === true);
    assert.equal(packetClosureRows.some(row => row.memoryId === second.memoryId), false,
      'the actual Classic packet does not label the pending event as a lifecycle closure');
    const viewer = preflight.actualClassic.viewer;
    const ordinaryRows = viewer.rows.filter(row => row.closure !== true);
    assert.equal(ordinaryRows.length, 1);
    assert.equal(ordinaryRows[0].memoryId, first.memoryId, 'the same actual request selects only the original open promise');
    assert.equal(deliveredClosureRows(preflight).length, 0, 'the returned Classic block delivers no pending closure');
    assert.equal(viewer.closureCurrentness, 'last-known');
    assert.equal(viewer.closureFacts, 0);
    assert.equal(viewer.closureInjectedFacts, 0);
    assert.equal(viewer.closureApplied, false);
    assert.equal(viewer.closureDeliveryComplete, false);
    assertNoForbiddenClosure(preflight, [pendingText]);
    assert.ok(preflight.actualClassic.block.includes('Canonical continuity coverage is incomplete.'));

    console.log(JSON.stringify({
      test: 'libra_main_memory_candidate_boundary',
      pendingState: pending.linkPendingReason,
      stateStatus: f.getHead().narrative.threads[0].status,
      selectedMemory: first.memoryId,
      closureCount: recallClosure?.diagnostics?.closureCount,
      packetClosureCount: packetClosureRows.length,
      currentness: recallClosure?.currentness
    }));
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
