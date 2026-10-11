'use strict';
// B4 lifecycle authority matrix through the real controlled-provider commit path.
// The fixture keeps the provider boundary deterministic while exercising normal
// Canonical -> State -> Recall/History processing for each row.
const assert = require('node:assert/strict');
const { actualClassicPacket, deliveredClosureRows, assertNoForbiddenClosure } = require('./fixtures/libra_actual_classic_request.cjs');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const MODES = ['plugin_only', 'mirror', 'server_only'];
const digest = value => {
  const body = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  let hash = 2166136261, length = 0;
  for (let index = 0; index < body.length; index += 1) { hash ^= body.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  hash ^= 31; hash = Math.imul(hash, 16777619); length += body.length + 1;
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${length}`;
};
const originDigest = memory => digest(memory?.unifiedOrigin || {
  scopeKey: memory?.scopeKey, memoryId: memory?.memoryId, revision: memory?.revision,
  sourceDigest: memory?.sourceDigest, artifactDigest: memory?.artifactDigest, turnRange: memory?.turnRange
});
// Disposable semantic probes must move the server activation descriptor with
// their resealed manifest. Assert this identity formula against the original
// product-written descriptor before using it; no production guard is bypassed.
const serverManifestIdentity = manifest => digest([
  ...(manifest.inheritedMemories || []), ...Object.values(manifest.memories || {})
].filter(ref => ref?.status === 'committed' && ref?.key)
  .sort((left, right) => Number(left.sessionEpoch || 0) - Number(right.sessionEpoch || 0)
    || Number(left.turnRange?.start || 0) - Number(right.turnRange?.start || 0))
  .map(ref => ({ cursor: {
    key: String(ref.key || ''), memoryId: String(ref.memoryId || ''), revision: Number(ref.revision || 0),
    sourceDigest: String(ref.sourceDigest || ''), manualStateDispositionDigest: String(ref.manualStateDispositionDigest || ''),
    manualAuthorityHash: String(ref.manualAuthorityHash || ''), artifactSchema: String(ref.artifactSchema || ''),
    artifactDigest: String(ref.artifactDigest || ''), worldlineId: String(ref.worldlineId || 'main'), logicalWorldlineId: 'main',
    turnRange: JSON.parse(JSON.stringify(ref.turnRange || {})), sessionEpoch: Number(ref.sessionEpoch || 0),
    inheritedSessionHistory: ref.inheritedSessionHistory === true || ref.inherited === true,
    archiveShared: ref.archiveShared === true, archiveId: String(ref.archiveId || ''),
    archiveCanonicalId: String(ref.archiveCanonicalId || ''), handoffTransferId: String(ref.handoffTransferId || ''),
    sourceSessionScopeKey: String(ref.sourceSessionScopeKey || ''), nativeCopiedFromScopeKey: String(ref.nativeCopiedFromScopeKey || '')
  }, sourceEvidenceRef: ref.sourceEvidenceRef || null })));

const people = [
  ['jiho', '지호'], ['mina', '민아'], ['junho', '준호'], ['soyeon', '소연'], ['arin', '아린']
].map(([tempId, name]) => ({ tempId, name, type: 'person', kind: 'person' }));
const initial = [
  { id: 'fulfilled', summary: '은빛 열쇠 반환 약속', status: 'open', owner: '지호', target: '민아', evidence: '지호는 민아에게 은빛 열쇠 반환 약속을 했다.' },
  { id: 'broken', summary: '은빛 열쇠 반환 약속', status: 'open', owner: '준호', target: '민아', evidence: '준호는 민아에게 은빛 열쇠 반환 약속을 했다.' },
  { id: 'cancelled', summary: '기록회 확인 약속', status: 'open', owner: '소연', target: '민아', evidence: '소연은 민아에게 기록회 확인 약속을 했다.' },
  { id: 'blocked', summary: '도서관 출입 허가', status: 'blocked', owner: '아린', target: '지호', evidence: '아린은 지호에게 도서관 출입 허가 약속을 했다.' },
  { id: 'closed', summary: '계약서 보관', status: 'closed', owner: '지호', target: '아린', evidence: '지호는 아린에게 계약서 보관 약속을 했다.' },
  { id: 'ambiguous_a', summary: '회의실 열쇠 전달', status: 'open', owner: '아린', target: '민아', evidence: '아린은 민아에게 회의실 열쇠 전달 약속을 했다.' },
  { id: 'ambiguous_b', summary: '회의실 열쇠 전달', status: 'open', owner: '아린', target: '민아', evidence: '아린은 민아에게 회의실 열쇠 전달 약속을 다시 했다.' },
  { id: 'different_anchor', summary: '행사 기록 정리', status: 'open', owner: '아린', target: '준호', evidence: '아린은 준호에게 행사 기록 정리 약속을 했다.' }
];
const successors = [
  { id: 'fulfilled', summary: '은빛 열쇠 반환 약속', status: 'resolved', resolution: 'fulfilled', link: 'resolve', owner: '지호', target: '민아', targetId: 'fulfilled', evidence: '지호는 민아에게 은빛 열쇠 반환 약속이 이행되었다고 말했다.' },
  { id: 'broken', summary: '은빛 열쇠 반환 약속', status: 'resolved', resolution: 'broken', link: 'resolve', owner: '준호', target: '민아', targetId: 'broken', evidence: '준호는 민아에게 은빛 열쇠 반환 약속이 지켜지지 않아 파기되었다고 말했다.' },
  { id: 'cancelled', summary: '기록회 확인 약속', status: 'closed', resolution: 'cancelled', link: 'resolve', owner: '소연', target: '민아', targetId: 'cancelled', evidence: '소연은 민아에게 기록회 확인 약속이 취소되었다고 말했다.' },
  { id: 'blocked_resolved', summary: '도서관 출입 허가', status: 'resolved', resolution: 'completed', link: 'resolve', owner: '아린', target: '지호', targetId: 'blocked', evidence: '아린은 지호에게 도서관 출입 허가 약속을 직접 증거로 완료했다고 말했다.' },
  { id: 'reopened', summary: '계약서 보관', status: 'open', link: 'reopen', owner: '지호', target: '아린', targetId: 'closed', evidence: '지호는 아린에게 계약서 보관 약속을 다시 열기로 했다고 말했다.' },
  { id: 'similar_new', summary: '계약서 보관', status: 'open', owner: '지호', target: '아린', evidence: '지호는 아린과 새 계약서 보관 약속을 시작했다.' },
  { id: 'wrong_participant', summary: '은빛 열쇠 반환 약속', status: 'resolved', resolution: 'fulfilled', link: 'resolve', owner: '아린', target: '민아', targetId: 'fulfilled', evidence: '아린은 민아에게 은빛 열쇠 반환 약속을 완료했다고 주장했다.' },
  { id: 'different_anchor', summary: '도서관 비품 정리', status: 'resolved', resolution: 'fulfilled', link: 'resolve', owner: '아린', target: '준호', targetId: 'different_anchor', evidence: '아린은 준호에게 도서관 비품 정리 약속을 완료했다고 말했다.' },
  { id: 'ambiguous', summary: '회의실 열쇠 전달', status: 'resolved', resolution: 'fulfilled', link: 'resolve', owner: '아린', target: '민아', targetId: 'ambiguous_a', evidence: '아린은 민아에게 회의실 열쇠 전달 약속이 이행되었다고 말했다.' },
  { id: 'unknown_alias', summary: '은빛 열쇠 반환 약속', status: 'resolved', resolution: 'fulfilled', link: 'resolve', owner: '지호', target: '민아', alias: 'ca_unknown_from_another_request', targetId: 'fulfilled', evidence: '지호는 민아에게 은빛 열쇠 반환 약속이 끝났다고 말했다.' },
  { id: 'missing_alias', summary: '은빛 열쇠 반환 약속', status: 'resolved', resolution: 'fulfilled', link: 'resolve', owner: '지호', target: '민아', noAlias: true, targetId: 'fulfilled', evidence: '지호는 민아에게 은빛 열쇠 반환 약속이 정리되었다고 말했다.' }
];
const staleAliasSuccessor = [{ id: 'stale_alias', summary: '은빛 열쇠 반환 약속', status: 'open', link: 'reopen', owner: '지호', target: '민아', targetId: 'fulfilled', evidence: '지호는 민아에게 은빛 열쇠 반환 약속을 다시 열었다.' }];
for (const row of [...initial, ...successors, ...staleAliasSuccessor]) {
  row.threadName = `${row.owner} ${row.id} thread`;
  row.evidence = `${row.threadName}: ${row.evidence}`;
}
initial[0].evidence = `북쪽 온실 표식 41: ${initial[0].evidence}`;
const sourceText = rows => rows.map(row => row.evidence).join(' ');
const pairs = (start, source) => Array.from({ length: 5 }, (_, offset) => ({
  turn: start + offset,
  user: { text: '당사자들은 그날 있었던 일을 기록했다.' },
  assistant: { text: offset === 0 ? source : '기록은 계속 보관되었다.' }
}));
const allPairs = [...pairs(1, sourceText(initial)), ...pairs(6, sourceText(successors)), ...pairs(11, sourceText(staleAliasSuccessor))];
const chat = {
  id: 'thread-boundary-matrix-chat', chatId: 'thread-boundary-matrix-chat', name: 'Lifecycle authority matrix',
  message: allPairs.flatMap(pair => [
    { role: 'user', chatId: `t${pair.turn}-u`, data: pair.user.text },
    { role: 'assistant', chatId: `t${pair.turn}-a`, data: pair.assistant.text }
  ])
};
const quote = (row, turn) => ({ ref: `t${turn}-a`, quote: row.evidence });
const artifactFor = (records, turn, { seedInitial = false } = {}) => {
  const sourceRows = seedInitial ? initial : successors;
  const entityRecords = [...people, ...records.map(row => ({
    tempId: `thread_${row.id}`, name: row.threadName, type: 'world', kind: 'thread'
  }))];
  const entities = entityRecords.map(entity => {
    const evidenceRow = records.find(row => row.owner === entity.name || row.target === entity.name)
      || records.find(row => row.id === entity.tempId.replace(/^thread_/, '')) || records[0];
    return { ...entity, evidenceSpans: [quote(evidenceRow, turn)] };
  });
  const facts = records.map((row, index) => ({
    tempFactId: `f${index + 1}`, domain: 'narrative', subjectTempRef: `thread_${row.id}`, claimKind: 'thread',
    values: { thread: {
      summary: row.summary, status: row.status, kind: 'promise',
      participants: [ { role: 'owner', personTempRef: people.find(person => person.name === row.owner).tempId },
        { role: 'target', personTempRef: people.find(person => person.name === row.target).tempId } ],
      ...(row.link ? { link: row.link } : {}), ...(row.resolution ? { resolution: row.resolution } : {}),
      ...(row.alias ? { linkCandidateAlias: row.alias } : {})
    } }, text: row.evidence, temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: [quote(row, turn)]
  }));
  return { schema: 'libra.canonical_artifact.v5', entities, facts };
};
const candidateRowsFromPrompt = args => {
  const user = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '';
  const match = user.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
  return match ? JSON.parse(match[1]) : [];
};
const candidateAlias = (rows, summary, owner, target) => rows.find(row => row.summary === summary
  && JSON.stringify(row.participants) === JSON.stringify([
    { role: 'owner', name: owner }, { role: 'target', name: target }
  ]))?.alias || '';

(async () => {
  for (const mode of MODES) {
    const firstBatchChat = { ...chat, message: chat.message.filter(row => Number(/^t(\d+)/.exec(row.chatId)?.[1]) <= 5) };
    const server = await serverFixture({ mode, snapshot: { chat: firstBatchChat } });
    let f = server.f;
    const findManifestKey = () => [...server.local.keys()].find(key => key.endsWith(':manifest'))
      || server.storedRows().find(row => row.key.endsWith(':manifest'))?.key || '';
    const readStored = key => {
      const raw = server.local.get(key);
      if (mode === 'plugin_only' || raw !== undefined) {
        if (raw === undefined) return null;
        try { return JSON.parse(raw); } catch { return raw; }
      }
      return server.storedRows().find(row => row.key === key)?.value || null;
    };
    const readManifest = () => {
      const row = [...server.local.entries()].find(([key]) => key.endsWith(':manifest'));
      if (row) { try { return JSON.parse(row[1]); } catch { return null; } }
      return f.getManifest();
    };
    const persistRecord = async (key, value) => {
      let stored = false;
      if (server.local.has(key)) { server.local.set(key, JSON.stringify(value)); stored = true; }
      if (mode !== 'plugin_only' && server.storedRows().some(row => row.key === key)) {
        await server.mutate(key, value);
        stored = true;
      }
      assert.equal(stored, true, `${mode}: tamper fixture found storage record ${key}`);
    };
    const readMemory = start => {
      const ref = readManifest()?.memories?.[String(start)];
      return ref ? readStored(ref.key) : null;
    };
    const readHead = () => [...server.local.values()].flatMap(raw => { try { const value = JSON.parse(raw); return value?.schema === 'libra.continuity_state.v2' ? [value] : []; } catch { return []; } })[0]
      || f.getHead();
  try {
    const prompts = [];
    const validationRows = [];
    let oldFulfillmentAlias = '';
    f.control.onCall = args => {
      const candidates = candidateRowsFromPrompt(args);
      prompts.push(candidates);
      if (prompts.length === 2) oldFulfillmentAlias = candidateAlias(candidates, '은빛 열쇠 반환 약속', '지호', '민아');
      const records = prompts.length === 1 ? initial : prompts.length === 2 ? successors.map(row => {
        if (!row.targetId) return row;
        const target = initial.find(candidate => candidate.id === row.targetId);
        const alias = candidateAlias(candidates, target.summary, target.owner, target.target);
        return { ...row, alias: row.noAlias ? '' : (row.alias || alias) };
      }) : staleAliasSuccessor.map(row => ({ ...row, alias: oldFulfillmentAlias }));
      const artifact = artifactFor(records, prompts.length === 1 ? 1 : prompts.length === 2 ? 6 : 11);
      const start = prompts.length === 1 ? 1 : prompts.length === 2 ? 6 : 11;
      const batch = allPairs.filter(row => row.turn >= start && row.turn < start + 5);
      const prepared = f.r.api.debugPrepareUnifiedMemoryArtifact?.(artifact, batch);
      validationRows.push({ prepared: prepared?.admission, issues: f.r.api.debugValidateUnifiedArtifact?.(prepared?.artifact || artifact, batch)?.issues });
      return { type: 'success', result: JSON.stringify(artifact) };
    };

    const runs = [];
    const stateSnapshots = [];
    runs.push(await f.run());
    stateSnapshots.push(readHead()?.narrative?.threads?.map(row => ({ lifecycleId: row.lifecycleId, summary: row.summary, status: row.status })) || []);
    for (const range of [[6,10],[11,15]]) {
      f.chat.message.push(...chat.message.filter(row => {
        const turn = Number(/^t(\d+)/.exec(row.chatId)?.[1]);
        return turn >= range[0] && turn <= range[1];
      }));
      f.chat.messages = f.chat.message;
      runs.push(await f.run());
      stateSnapshots.push(readHead()?.narrative?.threads?.map(row => ({ lifecycleId: row.lifecycleId, summary: row.summary, status: row.status })) || []);
    }
    const run = { completed: runs.reduce((sum, result) => sum + Number(result.completed || 0), 0), stateWarnings: runs.flatMap(result => result.stateWarnings || []) };
    assert.equal(run.completed, 3, JSON.stringify({ runs, validationRows }));
    assert.equal(prompts[0].length, 0);
    assert.equal(prompts[1].length, initial.length, 'each independently identified participant/anchor pair receives a request-local candidate');
    const second = readMemory(6);
    const third = readMemory(11);
    const values = new Map(second.canonicalArtifact.facts.map(fact => [fact.tempFactId, fact.values.thread]));
    const factIds = new Map(successors.map((row, index) => [row.id, `f${index + 1}`]));
    const valueFor = id => values.get(factIds.get(id));

    for (const id of ['fulfilled','broken','cancelled','blocked_resolved','reopened']) {
      assert.equal(valueFor(id)?.linkStatus, 'accepted', `${id} has a runtime-validated lifecycle target`);
    }
    assert.equal(valueFor('broken')?.resolution, 'broken');
    assert.equal(valueFor('cancelled')?.resolution, 'cancelled');
    assert.equal(valueFor('blocked_resolved')?.link, 'resolve', 'direct proof can resolve a blocked lifecycle');
    assert.equal(valueFor('reopened')?.lifecycleId, readMemory(1).canonicalArtifact.facts[4].values.thread.lifecycleId,
      'reopening the closed item preserves its original lifecycle identity');
    assert.equal(valueFor('similar_new')?.linkStatus, 'new', 'a similar promise with no declared target remains independent');
    assert.notEqual(valueFor('similar_new')?.lifecycleId, valueFor('reopened')?.lifecycleId);

    const pendingReasons = Object.fromEntries(['wrong_participant','different_anchor','ambiguous','unknown_alias','missing_alias']
      .map(id => [id, valueFor(id)?.linkPendingReason]));
    assert.deepEqual(pendingReasons, {
      wrong_participant: 'participant_mismatch',
      different_anchor: 'thread_anchor_evidence_missing',
      ambiguous: 'ambiguous_candidate_anchor',
      unknown_alias: 'unknown_or_stale_candidate_alias',
      missing_alias: 'target_alias_required'
    });
    const staleValue = third.canonicalArtifact.facts[0].values.thread;
    assert.equal(staleValue.linkStatus, 'pending');
    assert.equal(staleValue.linkPendingReason, 'unknown_or_stale_candidate_alias',
      'an alias captured for batch two cannot authorize a later reopen after the request nonce rotates');
    assert.notEqual(oldFulfillmentAlias, candidateAlias(prompts[2], '은빛 열쇠 반환 약속', '지호', '민아'),
      'the third request receives a different alias even when it addresses the same closed lifecycle');
    assert.ok(valueFor('fulfilled')?.lifecycleId !== valueFor('broken')?.lifecycleId,
      'same title with different participants remains two distinct lifecycles');

    const head = readHead();
    const historyRows = head?.narrative?.threads || [];
    const originalClosed = new Set(['fulfilled','broken','cancelled','blocked'].map(id =>
      readMemory(1).canonicalArtifact.facts[initial.findIndex(row => row.id === id)].values.thread.lifecycleId));
    assert.ok(!historyRows.some(row => originalClosed.has(row.lifecycleId)),
      'fulfilled, broken, cancelled and directly resolved blocked items leave the active State projection');
    const reopenedId = valueFor('reopened').lifecycleId;
    assert.ok(historyRows.some(row => row.lifecycleId === reopenedId && row.status === 'open'),
      `the exact closed lifecycle returns to the active State projection (${JSON.stringify({ reopenedId, historyRows, stateSnapshots, stateWarnings: run.stateWarnings })})`);
    assert.ok(historyRows.some(row => row.lifecycleId === valueFor('similar_new')?.lifecycleId && row.status === 'open'),
      'the similar new promise remains a separate open State item');
    for (const id of ['ambiguous_a','ambiguous_b','different_anchor']) {
      const priorId = readMemory(1).canonicalArtifact.facts[initial.findIndex(row => row.id === id)].values.thread.lifecycleId;
      assert.ok(historyRows.some(row => row.lifecycleId === priorId && row.status === 'open'), `${id} stays open after an unaccepted candidate`);
    }

    const settings = await f.r.api.getLibraMemorySettings();
    await f.r.api.saveLibraMemorySettings({ ...(settings?.settings || settings || {}), recallMaxMemories: 1 });
    const query = '북쪽 온실 표식 41 지호는 민아에게 은빛 열쇠 반환 약속을 했다';
    const recall = await f.r.api.previewUnifiedMemoryRecall(query);
    assert.equal(recall.memories.length, 1);
    assert.equal(recall.memories[0].memory.memoryId, readMemory(1).memoryId);
    const closureRows = recall?.diagnostics?.recallContinuityClosure?.facts || [];
    const laterTexts = new Set(successors.map(row => row.evidence));
    const pendingTexts = new Set(['wrong_participant','different_anchor','ambiguous','unknown_alias','missing_alias']
      .map(id => successors.find(row => row.id === id).evidence).concat(staleAliasSuccessor.map(row => row.evidence)));
    assert.ok([...laterTexts].some(text => closureRows.some(row => row.text === text)),
      'the actual Recall closure includes accepted outcomes from the later canonical batch');
    assert.ok(!closureRows.some(row => pendingTexts.has(row.text)),
      'pending candidate text may remain historical evidence but does not enter accepted closure rows');
    assert.equal(recall?.diagnostics?.recallContinuityClosure?.currentness, 'last-known');
    const packet = await actualClassicPacket(f, query, readManifest().scopeKey);
    const packetClosures = (packet?.evidencePacket?.layers?.memory || []).filter(row => row.closure === true);
    assert.ok(packetClosures.some(row => row.text === successors.find(item => item.id === 'broken').evidence),
      'the actual packet preserves the broken outcome as a closure with its own reason text');
    assert.ok(!packetClosures.some(row => pendingTexts.has(row.text)),
      'the actual packet does not label unaccepted candidate events as lifecycle closures');
    const actualClosures = deliveredClosureRows(packet);
    assert.ok(actualClosures.some(row => row.text === successors.find(item => item.id === 'broken').evidence),
      'the retained broken-outcome positive obligation also reaches actual Classic output');
    assert.ok(!actualClosures.some(row => pendingTexts.has(row.text)),
      'pending historical evidence is never relabelled as actually delivered closure');
    assertNoForbiddenClosure(packet, pendingTexts);

    const firstHistory = await f.r.api.getWorldManagerHistoryDetail({ memoryId: readMemory(1).memoryId, revision: readMemory(1).revision });
    assert.ok(firstHistory.provenance?.domains?.narrative?.canonicalAssertions?.length,
      'History remains available for the selected source revision');

    const originalManifest = readManifest();
    const originalActiveRow = mode === 'plugin_only' ? null : server.storedRows()
      .find(row => row.value?.schema === 'libra.unified_server_active.v1' && row.value.scopeKey === originalManifest.scopeKey);
    if (mode !== 'plugin_only') {
      assert.ok(originalActiveRow, `${mode}: the product committed an activation descriptor`);
      assert.equal(originalActiveRow.value.manifestIdentity, serverManifestIdentity(originalManifest),
        `${mode}: the disposable fixture reproduces the product's original manifest identity`);
    }
    const originalMemory = readMemory(6);
    const originalParentMemory = readMemory(1);
    const originalParentRef = JSON.parse(JSON.stringify(originalManifest.memories['1']));
    const originalSuccessorRef = JSON.parse(JSON.stringify(originalManifest.memories['6']));
    const syntheticReadMap = new Map([[originalParentRef.key, originalParentMemory]]);
    const syntheticRefs = [originalParentRef];
    for (let index = 1; index <= 48; index += 1) {
      const start = 1 + (index * 5), turnRange = { start, end: start + 4 };
      const canonicalArtifact = { schema: 'libra.canonical_artifact.v4', entities: [], facts: [], stateBindings: [] };
      const memory = {
        memoryId: `b4_budget_mid_${index}`, revision: 1, sourceDigest: digest(`b4-budget-source-${index}`),
        artifactDigest: digest(canonicalArtifact), artifactSchema: canonicalArtifact.schema, canonicalArtifact,
        turnRange, status: 'committed', scopeKey: originalParentMemory.scopeKey
      };
      const ref = {
        key: `b4_budget_ref_${index}`, memoryId: memory.memoryId, revision: memory.revision,
        sourceDigest: memory.sourceDigest, artifactDigest: memory.artifactDigest, artifactSchema: memory.artifactSchema,
        turnRange, sessionEpoch: 0, worldlineId: 'main', status: 'committed'
      };
      syntheticRefs.push(ref);
      syntheticReadMap.set(ref.key, memory);
    }
    const syntheticCandidateMemory = { ...JSON.parse(JSON.stringify(originalMemory)), turnRange: { start: 246, end: 250 } };
    const syntheticCandidateRef = { ...originalSuccessorRef, key: 'b4_budget_candidate', turnRange: { start: 246, end: 250 }, sessionEpoch: 0, worldlineId: 'main' };
    delete syntheticCandidateRef.unifiedOriginDigest;
    syntheticRefs.push(syntheticCandidateRef);
    syntheticReadMap.set(syntheticCandidateRef.key, syntheticCandidateMemory);
    const syntheticManifest = { memories: Object.fromEntries(syntheticRefs.map(ref => [String(ref.turnRange.start), ref])), inheritedMemories: [] };
    let aggregateReads = 0;
    const boundedClosure = await f.r.api.debugResolveRecallContinuityClosure({
      selectedFacts: [{ fact: originalParentMemory.canonicalArtifact.facts[0], artifact: originalParentMemory.canonicalArtifact, ref: originalParentRef }],
      manifest: syntheticManifest, registry: { entities: [], splitRetiredNames: [] }, head: null,
      readFact: async ref => { aggregateReads += 1; return syntheticReadMap.get(ref.key) || null; }
    });
    assert.equal(boundedClosure.diagnostics.readCount, 48, `${mode}: prefix-proof reads share the closure's 48-ref ceiling`);
    assert.equal(aggregateReads, 48, `${mode}: validation never exceeds the aggregate ref-read cap`);
    assert.ok(boundedClosure.diagnostics.reasons.includes('thread_target_read_budget'),
      `${mode}: a target outside the proof budget is rejected with a disclosed reason`);
    assert.equal(boundedClosure.currentness, 'last-known');
    assert.ok(!boundedClosure.facts.some(row => row.text === originalMemory.canonicalArtifact.facts[0].text),
      `${mode}: a successor without enough prefix proof is not a closure row`);

    const cancel = new AbortController();
    const callsBeforeCancel = f.control.calls.length;
    let cancellationReads = 0;
    const cancelledClosure = await f.r.api.debugResolveRecallContinuityClosure({
      selectedFacts: [{ fact: originalParentMemory.canonicalArtifact.facts[0], artifact: originalParentMemory.canonicalArtifact, ref: originalParentRef }],
      manifest: originalManifest, registry: { entities: [], splitRetiredNames: [] }, head: null, signal: cancel.signal,
      readFact: async ref => { cancellationReads += 1; cancel.abort(); return readStored(ref.key); }
    });
    assert.equal(cancellationReads, 1, `${mode}: closure abort stops before another ref read`);
    assert.equal(cancelledClosure.currentness, 'last-known');
    assert.ok(cancelledClosure.diagnostics.reasons.includes('closure_aborted'));
    assert.equal(f.control.calls.length, callsBeforeCancel, `${mode}: cancelled Recall makes no provider call`);

    const manifestKey = findManifestKey();
    // Negative control: changing persisted canonical bytes without a new source
    // commit must stop at origin integrity, before link-target validation.
    const integrityMemory = JSON.parse(JSON.stringify(originalMemory));
    integrityMemory.canonicalArtifact.facts.find(fact => fact.tempFactId === 'f1').values.thread.linkTarget.factId = 'missing_fact_99';
    integrityMemory.text = f.r.api.debugRenderUnifiedArtifact(integrityMemory.canonicalArtifact);
    integrityMemory.artifactDigest = digest(integrityMemory.canonicalArtifact);
    const integrityManifest = JSON.parse(JSON.stringify(originalManifest));
    integrityManifest.memories['6'].artifactDigest = integrityMemory.artifactDigest;
    await persistRecord(integrityManifest.memories['6'].key, integrityMemory);
    await persistRecord(manifestKey, integrityManifest);
    f = await server.restart();
    const unsealedTamperRecall = await f.r.api.previewUnifiedMemoryRecall(query);
    const unsealedTamperClosure = unsealedTamperRecall?.diagnostics?.recallContinuityClosure;
    assert.ok(unsealedTamperClosure?.diagnostics?.reasons?.includes('closure_ref_artifact_digest_mismatch'),
      `${mode}: a storage mutation without a matching origin seal is rejected at artifact-origin integrity`);
    assert.ok(!unsealedTamperClosure?.facts?.some(row => row.text === originalMemory.canonicalArtifact.facts[0].text),
      `${mode}: an unsealed storage mutation cannot enter the recall closure`);
    assert.equal(unsealedTamperClosure.currentness, 'last-known', `${mode}: the integrity negative control does not claim currentness`);
    const unsealedTamperPacket = await actualClassicPacket(f, query, readManifest().scopeKey, { allowEmpty: true });
    assert.ok(!(unsealedTamperPacket?.evidencePacket?.layers?.memory || []).some(row => row.closure === true && row.text === originalMemory.canonicalArtifact.facts[0].text),
      `${mode}: an unsealed storage mutation is not delivered as packet closure`);
    assert.ok(!deliveredClosureRows(unsealedTamperPacket).some(row => row.text === originalMemory.canonicalArtifact.facts[0].text),
      `${mode}: unsealed mutation has no actual closure delivery witness`);
    assertNoForbiddenClosure(unsealedTamperPacket, [originalMemory.canonicalArtifact.facts[0].text]);
    const integrityTamperObserved = {
      caseId: 'unsealed_storage_artifact_edit', reason: 'closure_ref_artifact_digest_mismatch',
      boundary: 'persisted artifact/ref digests updated; original unifiedOriginDigest deliberately retained'
    };
    await persistRecord(originalManifest.memories['6'].key, originalMemory);
    await persistRecord(manifestKey, originalManifest);
    f = await server.restart();
    assert.deepEqual(readMemory(6), originalMemory, `${mode}: integrity control restores the original durable canonical record`);

    const targetTamperCases = [
      ['nonexistent_fact', fact => { fact.values.thread.linkTarget.factId = 'missing_fact_99'; }, 'thread_target_fact_stale', { semanticProbe: true }],
      ['stale_lineage', fact => { fact.values.thread.linkTarget.lineageDigest = '00000000:1'; }, 'thread_target_lineage_stale', { semanticProbe: true }],
      ['stale_revision', fact => {
        const target = fact.values.thread.linkTarget;
        target.cursor.canonicalOrigin.revision += 99;
        const originKey = digest(target.cursor.canonicalOrigin);
        target.cursor.canonicalOriginKey = originKey;
        target.canonicalOriginKey = originKey;
      }, 'thread_target_origin_not_in_active_prefix', { semanticProbe: true }],
      ['unrelated_summary', fact => { fact.values.thread.summary = '창고 문 잠금 기록'; }, 'thread_target_anchor_mismatch', { semanticProbe: true }],
      ['unrelated_evidence', fact => { fact.evidenceSpans[0].quote = successors.find(row => row.id === 'different_anchor').evidence; }, 'thread_anchor_evidence_missing', { semanticProbe: true }],
      ['artifact_bytes_digest_mismatch', fact => { fact.values.thread.linkTarget.factId = 'missing_fact_99'; }, 'closure_ref_artifact_digest_mismatch', { staleDigest: true, skipReplay: true }],
      ['outer_schema_mismatch', () => {}, 'closure_ref_identity_mismatch', { skipReplay: true, mutateMemory: memory => { memory.artifactSchema = 'libra.canonical_artifact.v99'; } }],
      ['inner_v5_outer_unknown', () => {}, 'closure_ref_artifact_schema_mismatch', {
        skipReplay: true, mutateMemory: memory => { memory.artifactSchema = 'libra.canonical_artifact.v99'; },
        mutateRef: ref => { ref.artifactSchema = 'libra.canonical_artifact.v99'; }
      }]
    ];
    const targetTamperObserved = [];
    const descriptorNegativeObserved = [];
    for (const [caseId, alter, reason, options = {}] of targetTamperCases) {
      const changedMemory = JSON.parse(JSON.stringify(originalMemory));
      const accepted = changedMemory.canonicalArtifact.facts.find(fact => fact.tempFactId === 'f1');
      alter(accepted);
      changedMemory.text = f.r.api.debugRenderUnifiedArtifact(changedMemory.canonicalArtifact);
      options.mutateMemory?.(changedMemory);
      const changedManifest = JSON.parse(JSON.stringify(originalManifest));
      options.mutateRef?.(changedManifest.memories['6']);
      if (!options.staleDigest) {
        changedMemory.artifactDigest = digest(changedMemory.canonicalArtifact);
        changedManifest.memories['6'].artifactDigest = changedMemory.artifactDigest;
        if (options.semanticProbe) {
          // Re-sealing this disposable fixture only reaches semantic target
          // validation. It does not represent a source-approved canonical commit.
          changedManifest.memories['6'].unifiedOriginDigest = originDigest(changedMemory);
        }
      }
      await persistRecord(changedMemory.memoryId ? changedManifest.memories['6'].key : '', changedMemory);
      await persistRecord(manifestKey, changedManifest);
      f = await server.restart();
      if (options.semanticProbe && originalActiveRow) {
        if (caseId === 'nonexistent_fact') {
          const rejectedReplay = await f.r.api.rebuildWorldManagerState();
          assert.equal(rejectedReplay.ok, false, `${mode}: an unsynchronized semantic fixture fails closed`);
          assert.equal(rejectedReplay.code, 'UNIFIED_SERVER_ACTIVE_DESCRIPTOR_MISMATCH');
          assert.equal(rejectedReplay.providerCalls, 0);
          assert.equal(rejectedReplay.storageMutationCommitted, false);
          descriptorNegativeObserved.push({ code: rejectedReplay.code, storageMutationCommitted: false });
        }
        await persistRecord(originalActiveRow.key, { ...originalActiveRow.value,
          manifestIdentity: serverManifestIdentity(changedManifest) });
        f = await server.restart();
      }
      if (!options.skipReplay) {
        const replay = await f.r.api.rebuildWorldManagerState();
        assert.equal(replay.ok, true, `${mode}/${caseId}: a valid but stale target field cold-replays without rewriting canonical data`);
        assert.equal(replay.providerCalls, 0, `${mode}/${caseId}: replay makes no provider call`);
        const parentLifecycle = originalMemory.canonicalArtifact.facts[0].values.thread.lifecycleId;
        assert.ok(readHead()?.narrative?.threads?.some(row => row.lifecycleId === parentLifecycle && row.status === 'open'),
          `${mode}/${caseId}: State's target verifier does not close the selected lifecycle`);
      }
      const tamperedRecall = await f.r.api.previewUnifiedMemoryRecall(query);
      const tamperedClosure = tamperedRecall?.diagnostics?.recallContinuityClosure;
      const tamperedRows = tamperedClosure?.facts || [];
      const rejectedOutcomeText = originalMemory.canonicalArtifact.facts.find(fact => fact.tempFactId === 'f1').text;
      assert.ok(tamperedClosure?.diagnostics?.reasons?.includes(reason),
        `${mode}/${caseId}: Recall reports ${reason} (${JSON.stringify(tamperedClosure?.diagnostics)})`);
      assert.ok(!tamperedRows.some(row => row.text === rejectedOutcomeText), `${mode}/${caseId}: rejected target is not a closure row`);
      assert.equal(tamperedClosure.currentness, 'last-known', `${mode}/${caseId}: invalid target proof does not claim currentness`);
      const tamperedPacket = await actualClassicPacket(f, query, readManifest().scopeKey, { allowEmpty: true });
      const closurePacketRows = (tamperedPacket?.evidencePacket?.layers?.memory || []).filter(row => row.closure === true);
      assert.ok(!closurePacketRows.some(row => row.text === rejectedOutcomeText), `${mode}/${caseId}: invalid target is not labelled as packet closure`);
      assert.ok(!deliveredClosureRows(tamperedPacket).some(row => row.text === rejectedOutcomeText),
        `${mode}/${caseId}: invalid target has no actual closure delivery witness`);
      assertNoForbiddenClosure(tamperedPacket, [rejectedOutcomeText]);
      targetTamperObserved.push({ caseId, reason, currentness: tamperedClosure.currentness, closureCount: tamperedClosure.diagnostics.closureCount,
        syntheticSemanticProbe: options.semanticProbe === true });
      await persistRecord(originalMemory.memoryId ? originalManifest.memories['6'].key : '', originalMemory);
      await persistRecord(manifestKey, originalManifest);
      if (options.semanticProbe && originalActiveRow) await persistRecord(originalActiveRow.key, originalActiveRow.value);
      f = await server.restart();
      if (originalActiveRow) assert.deepEqual(readStored(originalActiveRow.key), originalActiveRow.value,
        `${mode}/${caseId}: descriptor restoration preserves the original durable authority`);
    }
    console.log(JSON.stringify({
      test: 'libra_main_memory_thread_lifecycle_boundary_matrix', mode, batches: run.completed,
      candidateCount: prompts[1].length, accepted: ['fulfilled','broken','cancelled','blocked_resolved','reopened'],
      pendingReasons: { ...pendingReasons, stale_alias: staleValue.linkPendingReason }, stateThreads: historyRows.length, closureCount: recall?.diagnostics?.recallContinuityClosure?.diagnostics?.closureCount,
      currentness: recall?.diagnostics?.recallContinuityClosure?.currentness,
      integrityTamperObserved,
      targetTamperObserved,
      descriptorNegativeObserved,
      syntheticSemanticProbeBoundary: 'targetTamperCases with syntheticSemanticProbe=true are disposable resealed fixtures, not source-approved commits',
      aggregateBudget: { readCount: boundedClosure.diagnostics.readCount, reason: 'thread_target_read_budget' },
      cancellation: { readCount: cancellationReads, currentness: cancelledClosure.currentness },
      observation: 'provider prompt -> canonical records -> State projection -> Recall closure -> Input Writer packet -> History'
    }));
    } finally { await server.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
