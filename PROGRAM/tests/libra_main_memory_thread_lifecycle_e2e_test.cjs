'use strict';
// Phase B: actual provider prompt -> runtime candidate resolver -> canonical
// storage -> State projection. The controlled provider reads only request-local
// aliases from the prompt; it never receives or invents persistent identifiers.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { actualClassicPacket, deliveredClosureRows } = require('./fixtures/libra_actual_classic_request.cjs');

const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
const rows = [];
const batches = [
  [
    ['민아는 지호에게 은빛 열쇠를 건넸다.', '지호는 오늘 열쇠 반환 약속을 했다.'],
    ['두 사람은 도서관에서 대화를 나눴다.', '대화가 끝났다.'],
    ['민아는 서재에 남았다.', '지호는 열쇠를 가지고 떠났다.'],
    ['준호는 공연실에 있었다.', '준호는 약속 내용에 관여하지 않았다.'],
    ['도서관은 문을 닫았다.', '아직 열쇠 반환은 확인되지 않았다.']
  ],
  [
    ['민아는 공연실에 들어갔다.', '민아는 준호에게 인사했다.'],
    ['지호는 서재에 왔다.', '지호는 민아를 찾았다.'],
    ['민아는 도서관을 나갔다.', '지호는 계속 기다렸다.'],
    ['준호는 열쇠를 보지 못했다.', '준호는 약속을 알지 못했다.'],
    ['지호가 은빛 열쇠를 민아에게 돌려주었다.', '오늘 열쇠 반환 다짐이 이행되었다.']
  ]
];
for (let b = 0; b < batches.length; b += 1) {
  for (let i = 0; i < 5; i += 1) {
    const turn = b * 5 + i + 1;
    rows.push({ turn, role: 'user', text: batches[b][i][0] });
    rows.push({ turn, role: 'assistant', text: batches[b][i][1] });
  }
}
const chat = {
  id: 'thread-lifecycle-chat',
  chatId: 'thread-lifecycle-chat',
  name: 'Thread lifecycle two-batch fixture',
  message: rows.map(row => ({ role: row.role, chatId: `t${row.turn}-${row.role === 'user' ? 'u' : 'a'}`, data: row.text }))
};
const quote = (turn, role = 'assistant') => {
  const row = rows.find(item => item.turn === turn && item.role === (role === 'user' ? 'user' : 'assistant'));
  return { ref: `t${turn}-${role === 'user' ? 'u' : 'a'}`, quote: row.text };
};
const candidateRowsFromPrompt = call => {
  const user = call?.messages?.find(row => row.role === 'user')?.content || '';
  const match = user.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
  return match ? JSON.parse(match[1]) : [];
};
const threadArtifact = ({ turn, threadEntityName, summary, status, link, resolution, alias, injectRuntimeFields = false }) => {
  const sourceRole = turn === 1 || turn === 10 ? 'assistant' : 'assistant';
  const value = {
    summary, status, kind: 'promise',
    participants: [
      { role: 'owner', personTempRef: 'jiho' },
      { role: 'target', personTempRef: 'mina' }
    ],
    ...(link ? { link } : {}),
    ...(resolution ? { resolution } : {}),
    ...(alias ? { linkCandidateAlias: alias } : {}),
    ...(injectRuntimeFields ? {
      participantIds: [{ role: 'owner', personId: 'provider_person_id' }],
      lifecycleId: 'provider_lifecycle_id',
      linkStatus: 'accepted',
      linkTarget: { schema: 'provider_target', factId: 'provider_fact', cursor: { key: 'provider_key' } }
    } : {})
  };
  return {
    schema: 'libra.canonical_artifact.v5',
    entities: [
      { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: [quote(turn, 'user')] },
      { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', evidenceSpans: [quote(turn, 'user')] },
      { tempId: 'thread', name: threadEntityName, type: 'world', kind: 'thread', evidenceSpans: [quote(turn, sourceRole)] }
    ],
    facts: [{
      tempFactId: `thread_fact_${turn}`, domain: 'narrative', subjectTempRef: 'thread',
      claimKind: 'thread', values: { thread: value },
      text: summary, temporalRole: 'current_sequence', certainty: 'confirmed',
      evidenceSpans: [quote(turn, sourceRole)]
    }]
  };
};

(async () => {
  const f = await fixture({ snapshot: { chat } });
  try {
    const promptRows = [];
    f.control.onCall = args => {
      const callIndex = f.control.calls.length - 1;
      const aliases = candidateRowsFromPrompt(args[0]);
      promptRows.push(aliases);
      const artifact = callIndex === 0
        ? threadArtifact({
          turn: 1,
          threadEntityName: '오늘 열쇠 반환 약속',
          summary: '오늘 열쇠를 돌려주겠다는 약속',
          status: 'open',
          injectRuntimeFields: true
        })
        : threadArtifact({
          turn: 10,
          threadEntityName: '오늘 열쇠 반환 다짐',
          summary: '은빛 열쇠를 민아에게 돌려준 약속의 이행',
          status: 'resolved',
          link: 'resolve',
          resolution: 'fulfilled',
          alias: aliases[0]?.alias
        });
      return { type: 'success', result: JSON.stringify(artifact) };
    };

    const result = await f.run();
    assert.equal(result.completed, 2, JSON.stringify(result));
    assert.equal(countCalls(f.control).canonical,2);
    assert.equal(promptRows[0].length, 0, 'an empty chain has no continuity candidate block');
    assert.equal(promptRows[1].length, 1, 'the active v5 chain supplies one request-local candidate alias');
    assert.deepEqual(promptRows[1][0].participants, [
      { role: 'owner', name: '지호' },
      { role: 'target', name: '민아' }
    ], 'candidate prompt identifies the promise-maker and beneficiary separately');
    assert.equal(promptRows[1][0].summary, '오늘 열쇠를 돌려주겠다는 약속');
    assert.deepEqual(Object.keys(promptRows[1][0]).sort(), ['alias', 'participants', 'summary']);
    assert.doesNotMatch(JSON.stringify(promptRows[1]), /provider_person_id|provider_lifecycle_id|memoryId|factId|cursor|personId/);

    const head = f.getHead();
    const threads = Array.isArray(head?.narrative?.threads) ? head.narrative.threads : [];
    assert.equal(threads.length, 0, 'fulfilled v5 fact closes the earlier promise after its display expression changes');
    const first = f.getMemory(1);
    const second = f.getMemory(6);
    assert.ok(first?.canonicalArtifact?.facts?.length, 'first canonical promise remains retained');
    assert.ok(second?.canonicalArtifact?.facts?.length, 'independent fulfillment remains retained');
    const prior = first.canonicalArtifact.facts[0].values.thread;
    const closure = second.canonicalArtifact.facts[0].values.thread;
    const closureFactText = second.canonicalArtifact.facts[0].text;
    assert.notEqual(prior.lifecycleId, 'provider_lifecycle_id', 'provider lifecycle IDs are not admitted');
    assert.notEqual(prior.participantIds?.[0]?.personId, 'provider_person_id', 'provider participant IDs are not admitted');
    assert.equal(prior.linkStatus, 'new');
    assert.equal(closure.linkStatus, 'accepted');
    assert.equal(closure.lifecycleId, prior.lifecycleId, 'runtime resolver binds the exact same lifecycle');
    assert.equal(closure.linkTarget.factId, 'thread_fact_1', 'target fact ID is runtime-sealed');
    assert.equal(closure.linkTarget.linkKind, 'resolve');
    assert.equal(closure.resolution, 'fulfilled', 'closure reason remains in canonical history');
    assert.ok(!Object.hasOwn(closure, 'linkCandidateAlias'), 'request-local alias is discarded before canonical storage');

    const recallSettings = await f.r.api.getLibraMemorySettings();
    await f.r.api.saveLibraMemorySettings({ ...(recallSettings?.settings || recallSettings || {}), recallMaxMemories: 1 });
    const recallQuery = '오늘 열쇠를 돌려주겠다는 약속은 아직 이행되지 않았다';
    const recall = await f.r.api.previewUnifiedMemoryRecall(recallQuery);
    assert.equal(recall.memories.length, 1, 'the request selects one canonical memory');
    assert.equal(recall.memories[0].memory.memoryId, first.memoryId, 'the selected memory is the original open promise');
    assert.equal(JSON.stringify(recall.memories.map(row => row.excerpt || row.text || '')).includes(closureFactText), false,
      'the selected memory does not already contain the later outcome');
    const packet = await actualClassicPacket(f, recallQuery, f.getManifest().scopeKey);
    const delivered = deliveredClosureRows(packet).filter(row => row.memoryId === second.memoryId
      && row.revision === second.revision && row.text === closureFactText);
    assert.equal(delivered.length, 1,
      'the accepted v5 successor reaches the sealed, returned Classic request after entity and summary changes');
    assert.equal((packet.actualClassic.block.match(/\[LIBRA CLASSIC RECALL/g) || []).length, 1,
      'the actual request carries one Classic block');
    assert.equal(recall?.diagnostics?.recallContinuityClosure?.currentness, 'current',
      'the selected lifecycle chain reports its currentness');

    const history = await f.r.api.getWorldManagerHistoryDetail({ memoryId: second.memoryId, revision: second.revision });
    assert.equal(history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution, 'fulfilled',
      'public History detail retains the distinct closure reason');
    const semanticThreadEvents=history.semanticTimeline?.events?.filter(event=>event.threadLifecycleId===prior.lifecycleId)||[];
    assert.equal(JSON.stringify(semanticThreadEvents.map(event=>event.type)),JSON.stringify(['created','resolved']),
      `History derives the accepted lifecycle transition for the same canonical thread (${JSON.stringify(history.semanticTimeline?.reasons)})`);
    assert.equal(JSON.stringify(semanticThreadEvents.map(event=>event.canonicalCursor?.turnRange?.start)),JSON.stringify([1,6]),
      'the History lifecycle timeline follows the original and exact accepted successor cursors');
    assert.ok(semanticThreadEvents.every(event=>event.itemIdentity===JSON.stringify(['thread',prior.lifecycleId])
      &&event.evidenceSpans.length>0),'thread transitions cite the same lifecycle identity and direct canonical evidence');

    const firstKey = f.getManifest().memories['1'].key;
    const secondKey = f.getManifest().memories['6'].key;
    const canonicalBytes = [f.r.values.get(firstKey), f.r.values.get(secondKey)];
    const restarted = await fixture({ snapshot: { chat: f.chat, values: [...f.r.values.entries()] } });
    try {
      const replay = await restarted.r.api.rebuildWorldManagerState();
      assert.equal(replay.ok, true, JSON.stringify({ ok: replay.ok, code: replay.code, error: replay.error }));
      assert.equal(replay.providerCalls, 0);
      assert.equal(restarted.control.calls.length, 0, 'cold replay reads the stored v5 chain without a model call');
      assert.equal(restarted.getHead().throughTurn, 10);
      assert.equal(restarted.getHead().narrative.threads.length, 0);
      assert.deepEqual([restarted.r.values.get(firstKey), restarted.r.values.get(secondKey)], canonicalBytes,
        'replay does not rewrite retained v5 canonical artifact bytes');
      const replayHistory = await restarted.r.api.getWorldManagerHistoryDetail({ memoryId: second.memoryId, revision: second.revision });
      assert.equal(replayHistory.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution, 'fulfilled');
    } finally {
      await restarted.r.cleanup();
    }

    console.log(JSON.stringify({
      test: 'libra_main_memory_thread_lifecycle_e2e', completed: result.completed,
      threadCountAfterFulfillment: threads.length, storedBatchStarts: [first.turnRange.start, second.turnRange.start],
      lifecycleStatus: [prior.linkStatus, closure.linkStatus], historyResolution: 'fulfilled',
      semanticTimeline: semanticThreadEvents.map(event=>event.type),
      coldReplay: 'v5 canonical bytes and fulfilled History retained without a model call',
      boundary: 'controlled provider prompt through canonical storage, State, sealed actual Classic delivery and History'
    }));
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
