'use strict';

// A11: two source-backed promises share one title and owner but have different
// recipients. The controlled provider resolves only one through the actual
// request-local alias path, then a separate negative run proposes the other
// recipient's alias and must leave both original obligations open.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
const { cases } = require('./fixtures/acceptance_scenarios.json');

const ACTION = cases.find(row => row.id === 'A11').action;
const MODES = ['plugin_only', 'mirror', 'server_only'];
const TITLE = '푸른 편지 전달 약속';
const clone = value => JSON.parse(JSON.stringify(value));

const turns = [
  { turn: 1, user: '지호는 민아에게 푸른 편지 전달 약속을 했다.', assistant: '민아는 그 약속을 기억했다.' },
  { turn: 2, user: '지호는 준호에게 푸른 편지 전달 약속을 했다.', assistant: '준호는 그 약속을 기억했다.' },
  { turn: 3, user: '두 사람은 다음 만남을 정했다.', assistant: '대화는 차분하게 이어졌다.' },
  { turn: 4, user: '민아는 기록을 정리했다.', assistant: '준호는 곁에서 기다렸다.' },
  { turn: 5, user: '두 약속은 아직 이행되지 않았다.', assistant: '그날 대화가 끝났다.' },
  { turn: 6, user: '지호는 민아에게 푸른 편지를 전달했다.', assistant: '민아는 받은 푸른 편지를 확인했다.' },
  { turn: 7, user: '두 사람은 잠시 이야기를 나눴다.', assistant: '편지는 민아에게 있었다.' },
  { turn: 8, user: '민아는 서재로 이동했다.', assistant: '지호는 도서관에 남았다.' },
  { turn: 9, user: '준호는 공연실에 갔다.', assistant: '준호는 편지를 받았다는 말을 하지 않았다.' },
  { turn: 10, user: '도서관은 문을 닫았다.', assistant: '그날 기록이 마무리되었다.' }
];

const rowsForTurns = selected => selected.flatMap(row => [
  { role: 'user', chatId: `t${row.turn}-u`, data: row.user },
  { role: 'assistant', chatId: `t${row.turn}-a`, data: row.assistant }
]);
const makeChat = selected => ({
  id: 'unified-chat', chatId: 'unified-chat', name: 'A11 same-title promises',
  message: rowsForTurns(selected)
});
const quote = (turn, role = 'user') => {
  const row = turns.find(item => item.turn === turn);
  assert.ok(row, `source turn ${turn} exists`);
  return { ref: `t${turn}-${role === 'assistant' ? 'a' : 'u'}`, quote: row[role] };
};
const sourceBatch = selected => selected.map(row => ({
  turn: row.turn,
  user: { text: row.user },
  assistant: { text: row.assistant }
}));
const candidatesFromCall = args => {
  const user = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '';
  const match = user.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
  return match ? JSON.parse(match[1]) : [];
};
const candidateForTarget = (rows, target) => rows.find(row => row.summary === TITLE
  && JSON.stringify(row.participants) === JSON.stringify([
    { role: 'owner', name: '지호' }, { role: 'target', name: target }
  ]));

const openingArtifact = () => ({
  schema: 'libra.canonical_artifact.v5',
  entities: [
    { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', evidenceSpans: [quote(1)] },
    { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: [quote(1)] },
    { tempId: 'junho', name: '준호', type: 'person', kind: 'person', evidenceSpans: [quote(2)] },
    { tempId: 'promise_mina', name: '민아에게 푸른 편지 전달 약속', type: 'world', kind: 'thread', evidenceSpans: [quote(1)] },
    { tempId: 'promise_junho', name: '준호에게 푸른 편지 전달 약속', type: 'world', kind: 'thread', evidenceSpans: [quote(2)] }
  ],
  facts: [
    {
      tempFactId: 'promise_for_mina', domain: 'narrative', subjectTempRef: 'promise_mina', claimKind: 'thread',
      values: { thread: { summary: TITLE, status: 'open', kind: 'promise', participants: [
        { role: 'owner', personTempRef: 'jiho' }, { role: 'target', personTempRef: 'mina' }
      ] } },
      text: '지호는 민아에게 푸른 편지 전달 약속을 했다.', temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: [quote(1)]
    },
    {
      tempFactId: 'promise_for_junho', domain: 'narrative', subjectTempRef: 'promise_junho', claimKind: 'thread',
      values: { thread: { summary: TITLE, status: 'open', kind: 'promise', participants: [
        { role: 'owner', personTempRef: 'jiho' }, { role: 'target', personTempRef: 'junho' }
      ] } },
      text: '지호는 준호에게 푸른 편지 전달 약속을 했다.', temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: [quote(2)]
    }
  ]
});

const deliveryArtifact = alias => ({
  schema: 'libra.canonical_artifact.v5',
  entities: [
    { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', evidenceSpans: [quote(6)] },
    { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: [quote(6)] },
    { tempId: 'delivered_letter', name: '민아에게 푸른 편지', type: 'world', kind: 'thread', evidenceSpans: [quote(6)] }
  ],
  facts: [{
    tempFactId: 'delivery_for_mina', domain: 'narrative', subjectTempRef: 'delivered_letter', claimKind: 'thread',
    values: { thread: {
      summary: TITLE, status: 'resolved', kind: 'promise', resolution: 'fulfilled', link: 'resolve',
      participants: [ { role: 'owner', personTempRef: 'jiho' }, { role: 'target', personTempRef: 'mina' } ],
      linkCandidateAlias: alias
    } },
    text: '지호는 민아에게 푸른 편지를 전달했다.', temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: [quote(6)]
  }]
});

const parseJson = raw => {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
};
const rowsAcrossStores = server => {
  const local = [...server.local.entries()].map(([key, raw]) => ({ key, raw, value: parseJson(raw), source: 'plugin' }));
  const remote = server.storedRows().map(row => ({ key: row.key, raw: row.raw, value: row.value, source: 'server' }));
  return [...local, ...remote];
};
const fieldDiffs = (left, right, path = '') => {
  if (Object.is(left, right)) return [];
  const leftArray = Array.isArray(left), rightArray = Array.isArray(right);
  if (leftArray && rightArray) {
    const diffs = [];
    if (left.length !== right.length) diffs.push({ path: `${path}.$length`, plugin: left.length, server: right.length });
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      diffs.push(...fieldDiffs(left[index], right[index], `${path}[${index}]`));
    }
    return diffs;
  }
  const leftObject = left !== null && typeof left === 'object' && !leftArray;
  const rightObject = right !== null && typeof right === 'object' && !rightArray;
  if (leftObject && rightObject) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap(key => {
      const childPath = path ? `${path}.${key}` : key;
      const leftHas = Object.hasOwn(left, key), rightHas = Object.hasOwn(right, key);
      if (!leftHas || !rightHas) return [{ path: childPath, pluginPresent: leftHas, serverPresent: rightHas,
        ...(leftHas ? { plugin: left[key] } : {}), ...(rightHas ? { server: right[key] } : {}) }];
      return fieldDiffs(left[key], right[key], childPath);
    });
  }
  return [{ path: path || '$', plugin: left, server: right }];
};
const AUDIT_TIME_PATHS = new Set([
  'updatedAt', 'branchGuard.lastFullAuditAt', 'branchGuard.updatedAt'
]);
const manifestIdentity = value => ({
  schema: value.schema, scopeKey: value.scopeKey, characterId: value.characterId, chatId: value.chatId,
  memories: value.memories, inheritedMemories: value.inheritedMemories, worldlineMeta: value.worldlineMeta
});
const manifestForChat = (server, chatId) => {
  const matches = rowsAcrossStores(server).filter(row => row.key.endsWith(':manifest')
    && row.value?.schema === 'libra.manifest.v1' && row.value.chatId === chatId);
  assert.ok(matches.length, `${chatId} canonical manifest is readable`);
  if (matches.length > 1) {
    assert.equal(new Set(matches.map(row => row.key)).size, 1, 'mirror stores read the same manifest key');
    const plugin = matches.find(row => row.source === 'plugin')?.value;
    const remote = matches.find(row => row.source === 'server')?.value;
    assert.ok(plugin && remote, 'mirror readback includes plugin and server manifest rows');
    const differences = fieldDiffs(plugin, remote);
    const unexpected = differences.filter(row => !AUDIT_TIME_PATHS.has(row.path));
    console.log(JSON.stringify({
      schema: 'a11.mirror_manifest_field_diff.v1', chatId, key: matches[0].key,
      sources: matches.map(row => row.source), differences,
      allowedAuditTimePaths: differences.filter(row => AUDIT_TIME_PATHS.has(row.path)).map(row => row.path),
      unexpectedDifferences: unexpected.map(row => row.path),
      canonicalRefs: Object.entries(plugin.memories || {}).map(([start, ref]) => ({ start, ...ref })),
      byteEqual: matches.every(row => row.raw === matches[0].raw)
    }));
    assert.deepEqual(unexpected, [], `mirror parsed manifest differs outside approved audit timestamps: ${JSON.stringify(unexpected)}`);
    assert.deepEqual(manifestIdentity(plugin), manifestIdentity(remote), 'mirror manifest identity and active canonical refs agree');
    assert.equal(typeof plugin.updatedAt, 'string');
    assert.equal(typeof remote.updatedAt, 'string');
    assert.equal(typeof plugin.branchGuard?.lastFullAuditAt, 'number');
    assert.equal(typeof remote.branchGuard?.lastFullAuditAt, 'number');
    assert.equal(typeof plugin.branchGuard?.updatedAt, 'string');
    assert.equal(typeof remote.branchGuard?.updatedAt, 'string');
  }
  return matches[0].value;
};
const memoryForChat = (server, chatId, start) => {
  const manifest = manifestForChat(server, chatId);
  const ref = manifest.memories?.[String(start)];
  assert.ok(ref, `${chatId} manifest includes canonical start ${start}`);
  const bytes = rawForKey(server, ref.key);
  assert.equal(typeof bytes, 'string', `canonical record ${ref.key} is read back as stored bytes`);
  return parseJson(bytes);
};
const rawForKey = (server, key) => {
  const matches = rowsAcrossStores(server).filter(row => row.key === key);
  assert.ok(matches.length, `canonical bytes for ${key} are available from a configured store`);
  if (matches.length > 1) assert.ok(matches.every(row => row.raw === matches[0].raw), `${key} mirror bytes agree`);
  assert.ok(matches.every(row => typeof row.raw === 'string'), `${key} readback is stored as bytes`);
  console.log(JSON.stringify({
    schema: 'a11.canonical_raw_readback.v1', key, sources: matches.map(row => row.source),
    byteEqualAcrossStores: matches.length < 2 || matches.every(row => row.raw === matches[0].raw),
    rawByteLength: Buffer.byteLength(matches[0].raw, 'utf8'),
    rawSha256: crypto.createHash('sha256').update(matches[0].raw, 'utf8').digest('hex')
  }));
  return matches[0].raw;
};
const publicThreads = async api => {
  const replay = await api.rebuildWorldManagerState();
  assert.equal(replay.ok, true, JSON.stringify({ code: replay.code, error: replay.error }));
  assert.ok(replay.head?.narrative, 'public State readback returns the authority-derived narrative Head');
  return Array.isArray(replay.head.narrative.threads) ? replay.head.narrative.threads : [];
};
const participantTargetId = value => value?.participantIds?.find(row => row.role === 'target')?.personId || '';
const packetRows = packet => Object.values(packet?.evidencePacket?.layers || {}).flatMap(rows => Array.isArray(rows) ? rows : []);

const openTwoPromises = async (server, mode) => {
  const f = server.f;
  const initial = openingArtifact();
  const admitted = f.r.api.debugPrepareUnifiedMemoryArtifact(initial, sourceBatch(turns.slice(0, 5)));
  assert.equal(admitted.admission?.status, 'complete', `minimal initial fixture is fully admitted: ${JSON.stringify(admitted.admission)}`);
  assert.equal(admitted.admission?.rejected?.length, 0, 'no source-backed entity or fact is rejected');
  assert.equal(admitted.admission?.droppedFields?.length, 0, 'no source quote is dropped');
  assert.equal(admitted.artifact?.facts?.filter(row => row.claimKind === 'thread').length, 2,
    'both source-backed same-title promises survive evidence admission');
  console.log(JSON.stringify({
    schema: 'a11.source_evidence_admission.v1', mode,
    admittedThreads: admitted.artifact.facts.filter(row => row.claimKind === 'thread').length,
    rejected: admitted.admission.rejected.length, droppedEvidence: admitted.admission.droppedFields.length
  }));

  const promptRows = [];
  f.control.onCall = args => {
    const calls = f.control.calls.length;
    const candidates = candidatesFromCall(args);
    promptRows.push(candidates);
    if (calls === 1) return { type: 'success', result: JSON.stringify(initial) };
    assert.equal(calls, 2, 'the controlled provider receives one later delivery batch');
    assert.equal(candidates.length, 2, 'the actual request carries both distinct promise candidates');
    const mina = candidateForTarget(candidates, '민아');
    assert.ok(mina?.alias, 'the request-local candidate alias identifies the 민아 promise');
    return { type: 'success', result: JSON.stringify(deliveryArtifact(mina.alias)) };
  };
  const result = await f.r.api.runManualColdStart();
  assert.equal(result.completed, 1, `the first canonical batch commits: ${JSON.stringify(result)}`);
  assert.equal(countCalls(f.control).canonical,1);
  assert.equal(promptRows[0].length, 0, 'a new thread does not receive fabricated prior candidates');

  const memory = memoryForChat(server, 'unified-chat', 1);
  const facts = memory.canonicalArtifact.facts.filter(row => row.claimKind === 'thread');
  assert.equal(facts.length, 2, 'both promise facts are retained in the first canonical artifact');
  const byTarget = new Map(facts.map(row => [participantTargetId(row.values.thread), row.values.thread]));
  assert.equal(byTarget.size, 2, 'the two promises have independent participant identities');
  const sameTitle = [...byTarget.values()];
  assert.ok(sameTitle.every(value => value.summary === TITLE && value.status === 'open'));
  assert.notEqual(sameTitle[0].lifecycleId, sameTitle[1].lifecycleId, 'same title does not merge lifecycle identity');
  const before = await publicThreads(f.r.api);
  assert.equal(before.length, 2, `public State shows both open promises: ${JSON.stringify(before)}`);
  assert.ok(before.every(row => row.status === 'open' && row.summary === TITLE));
  assert.equal(new Set(before.map(row => row.lifecycleId)).size, 2, 'public State preserves both lifecycle identities');
  console.log(JSON.stringify({
    schema: 'a11.pre_delivery_state.v1', mode,
    state: before.map(row => ({ lifecycleId: row.lifecycleId, status: row.status, summary: row.summary,
      targetId: row.participants?.find(participant => participant.role === 'target')?.personId || '' }))
  }));
  return { memory, facts, before, promptRows };
};

const appendDeliveryBatch = f => {
  f.chat.message.push(...rowsForTurns(turns.slice(5)));
  f.chat.messages = f.chat.message;
};

const runPositive = async mode => {
  const server = await serverFixture({ mode, snapshot: { chat: makeChat(turns.slice(0, 5)) } });
  try {
    const { f } = server;
    const initial = await openTwoPromises(server, mode);
    const originals = new Map(initial.facts.map(row => [participantTargetId(row.values.thread), row.values.thread]));
    appendDeliveryBatch(f);
    const result = await f.r.api.runManualColdStart();
    assert.equal(result.completed, 1, `${mode} commits the one-letter delivery batch: ${JSON.stringify(result)}`);
    assert.equal(countCalls(f.control).canonical,2);
    const deliveryMemory = memoryForChat(server, 'unified-chat', 6);
    const delivery = deliveryMemory.canonicalArtifact.facts.find(row => row.tempFactId === 'delivery_for_mina')?.values.thread;
    const minaOriginal = [...originals.values()].find(value => value.participants.some(row => row.personTempRef === 'mina'));
    const junhoOriginal = [...originals.values()].find(value => value.participants.some(row => row.personTempRef === 'junho'));
    assert.equal(delivery?.linkStatus, 'accepted', `${mode} verifies the exact request-local alias`);
    assert.equal(delivery?.link, 'resolve');
    assert.equal(delivery?.resolution, 'fulfilled');
    assert.equal(delivery?.lifecycleId, minaOriginal?.lifecycleId, 'only the recipient-matched promise is resolved');
    assert.equal(delivery?.linkTarget?.factId, 'promise_for_mina', 'the accepted link is sealed to the source-backed canonical target');
    assert.ok(!Object.hasOwn(delivery || {}, 'linkCandidateAlias'), 'request-local alias is removed from canonical storage');

    const after = await publicThreads(f.r.api);
    assert.equal(after.length, 1, `${mode} State retains exactly the other open promise: ${JSON.stringify(after)}`);
    assert.equal(after[0].status, 'open');
    assert.equal(after[0].lifecycleId, junhoOriginal?.lifecycleId, 'the 준호 promise remains open');
    assert.notEqual(after[0].lifecycleId, delivery?.lifecycleId, 'the resolved target is absent from open State');

    const history = await f.r.api.getWorldManagerHistoryDetail({ memoryId: deliveryMemory.memoryId, revision: deliveryMemory.revision });
    const lifecycleEvents = history.semanticTimeline?.events || [];
    const eventsForMina = lifecycleEvents.filter(event => event.threadLifecycleId === minaOriginal?.lifecycleId);
    const eventsForJunho = lifecycleEvents.filter(event => event.threadLifecycleId === junhoOriginal?.lifecycleId);
    assert.deepEqual(Array.from(eventsForMina, event => event.type), ['created', 'resolved'], `${mode} History records only the accepted lifecycle transition`);
    assert.deepEqual(Array.from(eventsForMina, event => event.evidenceSpans?.[0]?.ref), ['t1-u', 't6-u']);
    assert.deepEqual(Array.from(eventsForJunho, event => event.type), ['created'], `${mode} History leaves the other lifecycle untouched`);
    assert.ok(lifecycleEvents.every(event => event.evidenceSpans?.length && event.itemIdentity), 'History transitions carry source evidence and item identity');

    const settings = await f.r.api.getLibraMemorySettings();
    await f.r.api.saveLibraMemorySettings({ ...(settings?.settings || settings || {}), recallMaxMemories: 1 });
    const query = '지호는 민아에게 푸른 편지 전달 약속을 했다';
    const recall = await f.r.api.previewUnifiedMemoryRecall(query);
    assert.ok(recall.memories?.length > 0, `${mode} Recall returns evidence for the public query`);
    const recallClosure = recall.diagnostics?.recallContinuityClosure;
    assert.ok((recallClosure?.facts || []).some(row => row.memoryId === deliveryMemory.memoryId), `${mode} Recall verifies the accepted fulfillment as linked evidence`);
    assert.ok(['current', 'last-known'].includes(recallClosure?.currentness), `${mode} Recall reports observed lifecycle currentness`);
    const writer = await f.r.api.prepareInputWriterEvidence(query);
    const rows = packetRows(writer);
    assert.ok(writer.evidencePacket, `${mode} Input Writer exposes its final evidence packet`);
    assert.ok(rows.some(row => row.text?.includes('지호는 민아에게 푸른 편지를 전달했다.')),
      `${mode} Input Writer carries the source-backed delivered-letter evidence`);
    assert.ok(rows.some(row => row.text?.includes('지호는 민아에게 푸른 편지를 전달했다.')
      && Number(row.turnRange?.start || 0) <= 6 && Number(row.turnRange?.end || 0) >= 6),
      `${mode} Input Writer packet preserves the delivery's canonical evidence time`);

    if (mode === 'server_only') {
      const deliveryKey = manifestForChat(server, 'unified-chat').memories?.['6']?.key;
      assert.ok(deliveryKey, 'server_only delivery manifest reference contains its canonical key');
      assert.ok(server.storedRows().some(row => row.key === deliveryKey), 'server_only canonical delivery is read back from SQLite');
      assert.equal(server.getMemory(6)?.canonicalArtifact?.facts?.find(row => row.tempFactId === 'delivery_for_mina')?.values?.thread?.linkStatus,
        'accepted', 'server_only delivery and alias verification are durable in SQLite');
    } else if (mode === 'mirror') {
      assert.equal(f.getMemory(6)?.canonicalArtifact?.facts?.find(row => row.tempFactId === 'delivery_for_mina')?.values?.thread?.linkStatus,
        'accepted', 'mirror plugin storage has the accepted canonical target');
      assert.equal(server.getMemory(6)?.canonicalArtifact?.facts?.find(row => row.tempFactId === 'delivery_for_mina')?.values?.thread?.linkStatus,
        'accepted', 'mirror server storage agrees on the accepted canonical target');
    }
    return {
      mode, openingThreads: initial.before.length, candidateCount: initial.promptRows[1].length,
      resolvedLifecycleId: delivery.lifecycleId, remainingOpenLifecycleId: after[0].lifecycleId,
      history: { mina: eventsForMina.map(event => event.type), junho: eventsForJunho.map(event => event.type) },
      recallCurrentness: recallClosure.currentness, inputWriterCutoff: writer.evidencePacket.temporal_scope.sourceEvidenceCutoffTurn
    };
  } finally {
    await server.cleanup();
  }
};

const runWrongTargetNegative = async mode => {
  const server = await serverFixture({ mode, snapshot: { chat: makeChat(turns.slice(0, 5)) } });
  try {
    const { f } = server;
    const initial = await openTwoPromises(server, mode);
    const originals = new Set(initial.facts.map(row => row.values.thread.lifecycleId));
    appendDeliveryBatch(f);
    f.control.onCall = args => {
      const calls = f.control.calls.length;
      if (calls === 1) return { type: 'success', result: JSON.stringify(openingArtifact()) };
      const candidates = candidatesFromCall(args);
      assert.equal(candidates.length, 2, `${mode} wrong-target request receives both actual aliases`);
      const wrong = candidateForTarget(candidates, '준호');
      assert.ok(wrong?.alias, `${mode} wrong-target control selects the different-recipient alias`);
      return { type: 'success', result: JSON.stringify(deliveryArtifact(wrong.alias)) };
    };
    const result = await f.r.api.runManualColdStart();
    assert.equal(result.completed, 1, `${mode} stores the delivery attempt for negative checking`);
    const attemptMemory = memoryForChat(server, 'unified-chat', 6);
    const attempt = attemptMemory.canonicalArtifact.facts.find(row => row.tempFactId === 'delivery_for_mina')?.values.thread;
    assert.equal(attempt?.linkStatus, 'pending', `${mode} refuses the alias for the wrong recipient`);
    assert.equal(attempt?.linkPendingReason, 'participant_mismatch');
    assert.ok(!originals.has(attempt?.lifecycleId), 'a refused alias does not rewrite either original lifecycle');
    assert.ok(!attempt?.linkTarget, 'a refused alias has no canonical link target');
    const state = await publicThreads(f.r.api);
    assert.equal(state.length, 2, `${mode} State preserves both earlier obligations after the wrong-target attempt`);
    assert.ok(state.every(row => row.status === 'open' && originals.has(row.lifecycleId)));
    assert.equal(new Set(state.map(row => row.lifecycleId)).size, 2);

    const history = await f.r.api.getWorldManagerHistoryDetail({ memoryId: attemptMemory.memoryId, revision: attemptMemory.revision });
    assert.ok(!(history.semanticTimeline?.events || []).some(event => event.type === 'resolved'
      && originals.has(event.threadLifecycleId)), `${mode} History has no false resolution for either original lifecycle`);
    const settings = await f.r.api.getLibraMemorySettings();
    await f.r.api.saveLibraMemorySettings({ ...(settings?.settings || settings || {}), recallMaxMemories: 1 });
    const query = '지호는 민아에게 푸른 편지 전달 약속을 했다';
    const recall = await f.r.api.previewUnifiedMemoryRecall(query);
    assert.ok(!(recall.diagnostics?.recallContinuityClosure?.facts || []).some(row => row.memoryId === attemptMemory.memoryId),
      `${mode} Recall does not authorize the wrong-target event as a lifecycle closure`);
    const writer = await f.r.api.prepareInputWriterEvidence(query);
    const wrongClosureRows = packetRows(writer).filter(row => row.closure === true
      && row.text?.includes('지호는 민아에게 푸른 편지를 전달했다.'));
    assert.equal(wrongClosureRows.length, 0, `${mode} Input Writer does not present the wrong-target attempt as fulfillment`);

    if (mode === 'server_only') {
      assert.equal(server.getMemory(6)?.canonicalArtifact?.facts?.find(row => row.tempFactId === 'delivery_for_mina')?.values?.thread?.linkPendingReason,
        'participant_mismatch', 'server_only persists and reads back the refused target reason');
    } else if (mode === 'mirror') {
      assert.equal(f.getMemory(6)?.canonicalArtifact?.facts?.find(row => row.tempFactId === 'delivery_for_mina')?.values?.thread?.linkPendingReason,
        'participant_mismatch', 'mirror plugin storage records the refused target');
      assert.equal(server.getMemory(6)?.canonicalArtifact?.facts?.find(row => row.tempFactId === 'delivery_for_mina')?.values?.thread?.linkPendingReason,
        'participant_mismatch', 'mirror server storage records the refused target');
    }
    return { mode, wrongAliasStatus: attempt.linkStatus, wrongAliasReason: attempt.linkPendingReason, stateOpenCount: state.length };
  } finally {
    await server.cleanup();
  }
};

(async () => {
  for (const mode of MODES) {
    const positive = await runPositive(mode);
    const negative = await runWrongTargetNegative(mode);
    console.log(JSON.stringify({ schema: 'a11.same_title_observation.v1', positive, negative }));
    console.log(JSON.stringify({
      schema: 'acceptance.action_result.v1', case_id: 'A11', mode, action: ACTION, assertion_result: true
    }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
