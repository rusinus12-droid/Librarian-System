'use strict';

// Phase D2 server_only outage: the server transport is unavailable before a
// successor run can publish anything. There is no hidden local State
// authority; after reconnect a fresh public run restores State/History/Recall.
const assert = require('node:assert/strict');
const {actualClassicPacket}=require('./fixtures/libra_actual_classic_request.cjs');
const crypto = require('node:crypto');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const A06_ACTION = require('./fixtures/acceptance_scenarios.json').cases.find(row => row.id === 'A06').action;

const MODES = ['server_only'];

const parse = value => { try { return JSON.parse(value); } catch (_) { return {}; } };
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const compactRows = rows => rows.map(row => ({ key: row.key, revision: row.revision, rawDigest: digest(row.raw) }));
const compactLocal = entries => entries.map(([key, raw]) => ({ key, rawDigest: digest(raw) }));

const PROFILE_QUOTE = '민아는 민트차를 좋아한다고 말했다.';
const BOUNDARY_QUOTE = '민아는 지호에게 오늘 편지를 열지 말라고 했다.';
const OPEN_THREAD_QUOTE = '오늘 열쇠를 반환하겠다는 약속은 아직 이행되지 않았다.';
const OPEN_THREAD_SOURCE = `서재에서 준호가 열쇠를 지호에게 건넸고, 지호가 그것을 민아에게 돌려주었다. ${OPEN_THREAD_QUOTE} 공연 허가를 누가 내주는지는 아직 밝혀지지 않았다.`;

const appendProfileEvidence = (chat, ref) => {
  const row = chat.message.find(message => message.chatId === ref);
  assert.ok(row, `v5 source message exists: ${ref}`);
  const suffix = `${PROFILE_QUOTE} ${BOUNDARY_QUOTE}`;
  if (!String(row.data || '').includes(PROFILE_QUOTE)) row.data = `${row.data || ''} ${suffix}`.trim();
};

const v5MeaningArtifact = ({ offset = 0, resolved = false, alias = '' } = {}) => {
  const value = artifact();
  value.schema = 'libra.canonical_artifact.v5';
  for (const row of [...value.entities, ...value.facts]) {
    for (const span of row.evidenceSpans || []) {
      span.ref = span.ref.replace(/^t(\d+)/, (_, turn) => `t${Number(turn) + offset}`);
      if (!resolved && span.ref === `t${5 + offset}-a`) span.quote = OPEN_THREAD_SOURCE;
    }
  }
  const mina = value.entities.find(entity => entity.tempId === 'mina');
  const add = (tempFactId, claimKind, values, text, evidenceSpans, extra = {}) => value.facts.push({
    tempFactId,
    domain: 'character',
    subjectTempRef: mina.tempId,
    claimKind,
    values,
    text,
    temporalRole: extra.temporalRole || 'current_sequence',
    certainty: extra.certainty || 'confirmed',
    evidenceSpans,
    ...extra
  });
  add('phase_d_preference', 'character_preference', {
    preferences: [{ content: '민트차를 좋아한다', topic: '민트차', kind: 'preference' }]
  }, '민아는 민트차를 좋아한다고 말했다.', [{ ref: `t${4 + offset}-a`, quote: PROFILE_QUOTE }]);
  add('phase_d_boundary', 'character_boundary', {
    boundaries: [{
      content: '민아는 지호에게 오늘 편지를 열지 말라고 했다',
      topic: '편지 열기', kind: 'boundary',
      scope: { subjectRef: 'mina', targetRef: 'jiho', act: '편지 열기', when: '오늘' }
    }]
  }, '민아는 지호에게 오늘 편지를 열지 말라고 했다', [{ ref: `t${4 + offset}-a`, quote: BOUNDARY_QUOTE }]);
  const thread = value.facts.find(fact => fact.tempFactId === 'f12');
  thread.values.thread = {
    summary: '오늘 열쇠 반환 약속',
    status: resolved ? 'resolved' : 'open',
    kind: 'promise',
    participants: [
      { role: 'owner', personTempRef: 'jiho' },
      { role: 'target', personTempRef: 'mina' }
    ],
    ...(resolved ? { link: 'resolve', resolution: 'fulfilled', ...(alias ? { linkCandidateAlias: alias } : {}) } : {})
  };
  thread.text = resolved ? '오늘 열쇠 반환 약속이 이행되었다.' : '오늘 열쇠 반환 약속은 아직 이행되지 않았다.';
  if (!resolved) {
    for (const span of thread.evidenceSpans || []) if (span.ref === `t${5 + offset}-a`) span.quote = OPEN_THREAD_SOURCE;
  }
  return value;
};

const localJson = (snapshot, pattern) => {
  const key = [...snapshot.local.keys()].find(candidate => pattern.test(candidate));
  return key ? parse(snapshot.local.get(key)) : null;
};
const headOf = snapshot => localJson(snapshot, /:continuity-state$/) || snapshot.getHead() || null;
const memoryOf = (snapshot, start = 1) => {
  const manifest = snapshot.getManifest() || localJson(snapshot, /:manifest$/);
  const ref = manifest?.memories?.[String(start)];
  if (ref) {
    const serverRow = snapshot.storedRows().find(row => row.key === ref.key);
    if (serverRow) return serverRow.value;
    return parse(snapshot.local.get(ref.key));
  }
  return start === 1 ? localJson(snapshot, /:memory:1:/) : null;
};

const localHeadOf = snapshot => localJson(snapshot, /:continuity-state$/);

const installServerOnlyOutage = snapshot => {
  const observation = { injected: false, blocked: false, networkDown: true, body: null, requestUrl: null, serverRowsAtInjection: null, localEntriesAtInjection: null };
  snapshot.hooks.beforeBatch = async body => {
    if (observation.injected) return;
    observation.injected = true;
    observation.body = clone(body);
    observation.serverRowsAtInjection = snapshot.storedRows().map(row => ({ key: row.key, raw: row.raw, revision: row.revision }));
    observation.localEntriesAtInjection = [...snapshot.local.entries()];
  };
  snapshot.hooks.beforeServerRequest = async (url, init) => {
    if (observation.networkDown) {
      observation.requestUrl ||= url;
      if (!observation.injected) {
        observation.injected = true;
        observation.requestUrl = url;
        try { observation.body = init?.body ? JSON.parse(init.body) : null; } catch (_) { observation.body = null; }
        observation.serverRowsAtInjection = snapshot.storedRows().map(row => ({ key: row.key, raw: row.raw, revision: row.revision }));
        observation.localEntriesAtInjection = [...snapshot.local.entries()];
      }
      observation.blocked = true;
      throw Error('phase_d_server_transport_outage');
    }
  };
  return {
    observation,
    restore: () => {
      snapshot.hooks.beforeBatch = null;
      snapshot.hooks.beforeServerRequest = null;
      observation.networkDown = false;
    }
  };
};

const runMode = async mode => {
  const snapshot = await serverFixture({ mode });
  const observation = { mode };
  try {
    const f = snapshot.f;
    let firstArtifact = v5MeaningArtifact({ resolved: false });
    let secondArtifact;
    f.control.artifact = firstArtifact;
    f.control.onCall = args => {
      const callIndex = f.control.calls.length - 1;
      if (callIndex === 0) return { type: 'success', result: JSON.stringify(firstArtifact) };
      const content = clone(secondArtifact);
      const userPrompt = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '';
      const match = userPrompt.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
      const candidates = match ? JSON.parse(match[1]) : [];
      const candidate = candidates.find(row => row.summary === '오늘 열쇠 반환 약속') || candidates[0];
      if (candidate?.alias) content.facts.find(fact => fact.tempFactId === 'f12').values.thread.linkCandidateAlias = candidate.alias;
      return { type: 'success', result: JSON.stringify(content) };
    };
    appendProfileEvidence(f.chat, 't4-a');
    const openThreadSource = f.chat.message.find(message => message.chatId === 't5-a');
    assert.ok(openThreadSource, `${mode}: first batch has the open thread source`);
    openThreadSource.data = OPEN_THREAD_SOURCE;
    const first = await f.run();
    assert.equal(first.completed, 1, `${mode}: first v5 open thread commits`);
    const firstHead = headOf(snapshot);
    assert.ok(firstHead, `${mode}: first State is readable before the fault`);
    assert.equal(firstHead.status, 'ready', `${mode}: control batch State is ready before the fault`);
    const firstMina = firstHead.characters.find(character => character.name === '민아');
    assert.match(JSON.stringify(firstMina?.state || {}), /민트차를 좋아한다/, `${mode}: control batch projects the preference`);
    assert.ok(Array.isArray(firstMina?.state?.boundaries) && firstMina.state.boundaries.length > 0, `${mode}: control batch projects the boundary`);
    const firstThread = firstHead.narrative?.threads?.find(thread => thread.summary === '오늘 열쇠 반환 약속');
    assert.equal(firstThread?.status, 'open', `${mode}: control batch preserves the open v5 thread`);
    // The canonical run schedules derived embedding metadata on the owner
    // queue. Drain that preceding work before installing the network fault;
    // an already-sent T5 request is not a successor write during the outage.
    const drained = await f.r.api.retryPendingUnifiedVectors();
    assert.equal(drained.ok, true, `${mode}: pre-outage owner queue drained: ${JSON.stringify(drained)}`);
    assert.equal(snapshot.getMemory(1)?.embedding?.status, 'disabled');
    assert.equal(snapshot.getManifest()?.memories?.['1']?.embeddingStatus, 'disabled');
    const providerCallsBeforeOutage = f.control.calls.length;
    fiveMore(f);
    appendProfileEvidence(f.chat, 't9-a');
    secondArtifact = v5MeaningArtifact({ offset: 5, resolved: true });
    const acceptedQuote = '지호가 민아에게 열쇠를 돌려주어 오늘 열쇠 반환 약속이 이행되었다. 공연 허가자는 아직 밝혀지지 않았다.';
    const acceptedSource = f.chat.message.find(message => message.chatId === 't10-a');
    assert.ok(acceptedSource, `${mode}: second batch has the accepted thread source`);
    acceptedSource.data = acceptedQuote;
    for (const row of [...secondArtifact.entities, ...secondArtifact.facts]) {
      for (const span of row.evidenceSpans || []) if (span.ref === 't10-a') span.quote = acceptedQuote;
    }
    f.control.artifact = secondArtifact;
    const chatAfterSecondBatch = clone(f.chat);
    const fault = installServerOnlyOutage(snapshot);
    let second;
    let secondError;
    try { second = await f.run(); } catch (error) { secondError = error; }
    // Keep the transport blocked while the runtime's indeterminate mutation
    // handling drains. Otherwise a background retry can race the snapshot
    // and make the post-fault write look like an outage write.
    await new Promise(resolve => setTimeout(resolve, 300));
    const rowsDuringOutage = snapshot.storedRows().map(row => ({ key: row.key, raw: row.raw, revision: row.revision }));
    const serverHeadDuringFault = snapshot.getHead();
    const localHeadDuringOutage = localHeadOf(snapshot);
    assert.equal(fault.observation.injected, true, `${mode}: server outage intercepted the first successor batch`);
    assert.equal(fault.observation.blocked, true, `${mode}: server transport request was actually blocked`);
    assert.match(String(fault.observation.requestUrl || ''), /\/v1\//, `${mode}: blocked request target is captured`);
    assert.equal(fault.observation.networkDown, true, `${mode}: transport remains unavailable during the outage readback`);
    assert.ok(secondError || Number(second?.completed) === 0, `${mode}: outage returns an explicit incomplete outcome or an explicit transport error`);
    if (secondError) {
      assert.match(String(secondError.message || secondError), /phase_d_server_transport_outage/,
        `${mode}: transport outage is surfaced by the public run`);
      assert.equal(secondError.storageMutationIndeterminate, true,
        `${mode}: interrupted server mutation is explicitly marked indeterminate`);
    }
    assert.equal(f.control.calls.length, providerCallsBeforeOutage, `${mode}: offline run does not spend another provider call`);
    assert.deepEqual(compactRows(rowsDuringOutage), compactRows(fault.observation.serverRowsAtInjection), `${mode}: server raw rows remain unchanged after transport is down`);
    assert.deepEqual(compactLocal([...snapshot.local.entries()]), compactLocal(fault.observation.localEntriesAtInjection), `${mode}: local raw storage remains unchanged after transport is down`);
    const memory = memoryOf(snapshot, 6);
    assert.equal(memory, null, `${mode}: no canonical successor is published while transport is down`);
    assert.equal(serverHeadDuringFault?.throughTurn, 5, `${mode}: server State remains at the prior T5 Head during outage`);
    assert.equal(localHeadDuringOutage, null, `${mode}: server_only has no hidden local State authority during outage`);

    fault.restore();

    await snapshot.restart();
    const reconnected = snapshot;
    const liveChat = reconnected.f.chat;
    Object.assign(liveChat, {
      id: chatAfterSecondBatch.id,
      chatId: chatAfterSecondBatch.chatId,
      name: chatAfterSecondBatch.name,
      message: liveChat.message
    });
    liveChat.message.splice(0, liveChat.message.length, ...chatAfterSecondBatch.message.map(clone));
    liveChat.messages = liveChat.message;
    reconnected.f.character.chats = [liveChat];
    reconnected.f.control.artifact = secondArtifact;
    reconnected.f.control.onCall = args => {
      const content = clone(secondArtifact);
      const userPrompt = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '';
      const match = userPrompt.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
      const candidates = match ? JSON.parse(match[1]) : [];
      const candidate = candidates.find(row => row.summary === '오늘 열쇠 반환 약속') || candidates[0];
      if (candidate?.alias) content.facts.find(fact => fact.tempFactId === 'f12').values.thread.linkCandidateAlias = candidate.alias;
      return { type: 'success', result: JSON.stringify(content) };
    };
    const recoveredRun = await reconnected.f.run();
    assert.equal(recoveredRun.completed, 1, `${mode}: fresh public run succeeds after server reconnect`);
    const head = headOf(reconnected);
    const recoveredMemory = memoryOf(reconnected, 6);
    assert.equal(recoveredMemory?.artifactSchema, 'libra.canonical_artifact.v5', `${mode}: v5 canonical bytes are durable after reconnect`);
    assert.equal(recoveredMemory?.status, 'committed', `${mode}: canonical memory is committed after reconnect`);
    assert.ok(head, `${mode}: State readback exists after retry`);
    assert.equal(head.status, 'ready', `${mode}: recovered State is authoritative and ready`);
    assert.equal(head.narrative?.threads?.some(thread => thread.summary === '오늘 열쇠 반환 약속'), false,
      `${mode}: accepted fulfilled lifecycle is removed from open current threads`);
    const mina = head.characters.find(character => character.name === '민아');
    assert.ok(mina, `${mode}: character State survives retry`);
    const stateText = JSON.stringify(mina.state || {});
    assert.match(stateText, /민트차를 좋아한다/, `${mode}: v5 preference survives State recovery`);
    assert.ok(Array.isArray(mina.state?.boundaries) && mina.state.boundaries.length > 0,
      `${mode}: v5 boundary survives State recovery`);

    const history = await reconnected.f.r.api.getWorldManagerHistoryDetail({ memoryId: recoveredMemory.memoryId, revision: recoveredMemory.revision });
    assert.equal(history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution,
      'fulfilled', `${mode}: v5 thread/link remains in History`);
    assert.equal(history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.linkStatus,
      'accepted', `${mode}: History records the accepted v5 link`);
    const recall = await reconnected.f.r.api.previewUnifiedMemoryRecall('민아 민트차 열쇠 반환 약속');
    const recallText = JSON.stringify(recall);
    assert.match(recallText, /민트차를 좋아한다/, `${mode}: v5 preference is readable through Recall`);
    assert.match(recallText, /이행되었다|반환/, `${mode}: v5 linked thread is readable through Recall`);
    const scope=await reconnected.f.r.api.getHostLineageStatus();
    const packet=await actualClassicPacket(reconnected.f,'민아 민트차 열쇠 반환 약속',scope.scopeKey);
    const packetText=packet.actualClassic.block;
    assert.match(packetText, /민트차를 좋아한다/, `${mode}: actual delivered Classic block carries the structured profile`);
    assert.match(packetText, /이행되었다/, `${mode}: actual delivered Classic block carries the accepted resolved lifecycle`);

    observation.providerCalls = reconnected.f.control.calls.length;
    observation.additionalProviderCallsDuringOutage = f.control.calls.length - providerCallsBeforeOutage;
    observation.injectionObserved = fault.observation.injected;
    observation.reconnectRunCompleted = Number(recoveredRun.completed || 0);
    observation.serverHeadDuringFault = serverHeadDuringFault?.throughTurn ?? null;
    observation.memoryId = recoveredMemory.memoryId;
    observation.stateThroughTurn = head.throughTurn;
    assert.equal(head.throughTurn, 10, `${mode}: retry State remains at the committed successor`);
    observation.historyResolution = history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution;
    observation.recallMemoryCount = recall.memories.length;
    assert.equal(observation.providerCalls, 1, `${mode}: reconnect path uses one fresh provider call`);
    return observation;
  } finally {
    await snapshot.cleanup();
  }
};

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  console.log(JSON.stringify({
    schema: 'acceptance.action_result.v1', case_id: 'A06', mode: 'server_only',
    action: A06_ACTION, assertion_result: true,
    observed: `During blocked transport raw server rows and empty local raw storage remained unchanged; after reconnect, the fresh run read back State through turn ${results.server_only.stateThroughTurn}.`
  }));
  console.log(JSON.stringify({
    test: 'libra_phase_d_v5_server_only_outage_recovery',
    passed: MODES.length,
    results,
  boundary: 'synthetic provider artifact; server_only loopback transport is blocked before the successor run, raw server/local stores remain unchanged with no hidden local authority, and a fresh reconnect run restores v5 State/History/Recall'
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
