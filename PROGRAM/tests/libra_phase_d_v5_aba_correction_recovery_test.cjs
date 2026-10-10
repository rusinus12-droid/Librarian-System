'use strict';

// Phase D2 ABA/correction race: an old v5 State candidate is refused after a same-value external ABA. Canonical history remains durable while the prior Head is preserved.
// durable State/History/Recall surfaces recover. This is intentionally a
// narrow semantic fixture; the older v4 fault matrix remains separate.
const assert = require('node:assert/strict');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const MODES = ['mirror', 'server_only'];

const parse = value => { try { return JSON.parse(value); } catch (_) { return {}; } };
const clone = value => JSON.parse(JSON.stringify(value));

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
  return localJson(snapshot, /:memory:1:/);
};

const wrapPluginStateWriteAfterCommit = snapshot => {
  const storage = snapshot.f.r.context.risuai.pluginStorage;
  const original = storage.setItem;
  const observation = { injected: false };
  storage.setItem = async (key, raw, ...rest) => {
    const value = parse(raw);
    const result = await original.call(storage, key, raw, ...rest);
    if (!observation.injected && value.schema === 'libra.continuity_state.v2') {
      observation.injected = true;
      throw new Error('phase_d_v5_aba_unreachable_response_loss');
    }
    return result;
  };
  return { observation, restore: () => { storage.setItem = original; } };
};

const installServerABA = snapshot => {
  const observation = { injected: false, body: null, originalRevision: null, temporaryRevision: null, restoredRevision: null };
  snapshot.hooks.beforeBatch = async body => {
    if (observation.injected) return;
    const mutation = body.mutations.find(item => String(item.key || '').endsWith(':continuity-state'));
    if (!mutation) return;
    const row = snapshot.storedRows().find(item => item.key === mutation.key);
    assert.ok(row, 'ABA target State row exists before the conditional commit');
    observation.body = clone(body);
    observation.originalRevision = row.revision;
    await snapshot.mutate(mutation.key, { ...row.value, phaseDAbaTemporaryCorrection: 'external correction' });
    observation.temporaryRevision = snapshot.storedRows().find(item => item.key === mutation.key)?.revision;
    await snapshot.mutate(mutation.key, row.value);
    observation.restoredRevision = snapshot.storedRows().find(item => item.key === mutation.key)?.revision;
    observation.injected = true;
  };
  return { observation, restore: () => { snapshot.hooks.beforeBatch = null; } };
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
    const firstHeadRaw = JSON.stringify(firstHead);
    assert.equal(firstHead.status, 'ready', `${mode}: control batch State is ready before the fault`);
    const firstMina = firstHead.characters.find(character => character.name === '민아');
    assert.match(JSON.stringify(firstMina?.state || {}), /민트차를 좋아한다/, `${mode}: control batch projects the preference`);
    assert.ok(Array.isArray(firstMina?.state?.boundaries) && firstMina.state.boundaries.length > 0, `${mode}: control batch projects the boundary`);
    const firstThread = firstHead.narrative?.threads?.find(thread => thread.summary === '오늘 열쇠 반환 약속');
    assert.equal(firstThread?.status, 'open', `${mode}: control batch preserves the open v5 thread`);

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
    const fault = installServerABA(snapshot);
    const second = await f.run();
    fault.restore();
    assert.equal(fault.observation.injected, true, `${mode}: ABA correction injection actually ran`);
    assert.ok(fault.observation.body?.operationId, `${mode}: ABA captured the original State operation`);
    assert.ok(Number(fault.observation.temporaryRevision) > Number(fault.observation.originalRevision), `${mode}: temporary correction advances State revision`);
    assert.ok(Number(fault.observation.restoredRevision) > Number(fault.observation.temporaryRevision), `${mode}: ABA restore advances State revision again`);
    assert.notEqual(fault.observation.restoredRevision, fault.observation.originalRevision, `${mode}: ABA is not hidden by equal final bytes`);
    const stateBatchCount = snapshot.batches.filter(body => body.mutations.some(item => String(item.key || '').endsWith(':continuity-state'))).length;
    assert.ok(stateBatchCount >= 2, `${mode}: conditional State write retries after ABA read-set conflict`);
    assert.equal(second.completed, 1, `${mode}: second v5 batch canonical commit survives ABA correction`);
    const memory = memoryOf(snapshot, 6);
    assert.equal(memory?.artifactSchema, 'libra.canonical_artifact.v5', `${mode}: v5 canonical bytes are durable`);
    assert.equal(memory?.status, 'committed', `${mode}: canonical memory is committed`);
    const committedHead = headOf(snapshot);
    assert.equal(committedHead?.throughTurn, 5, `${mode}: ABA leaves the prior durable Head until the pending State retry`);

    const retry = await f.r.api.retryPendingUnifiedState();
    assert.ok([0, 1].includes(Number(retry.recovered)), `${mode}: post-race recovery returns an explicit durable outcome ${JSON.stringify(retry)}`);
    const head = headOf(snapshot);
    assert.ok(head, `${mode}: State readback exists after retry`);
    assert.equal(JSON.stringify(head), firstHeadRaw,
      `${mode}: stale ABA retry preserves the exact prior Head JSON bytes`);
    assert.equal(head.status, 'ready', `${mode}: recovered State is authoritative and ready`);
    assert.equal(retry.recovered, 0, `${mode}: stale ABA candidate is not reported as recovered`);
    assert.equal(retry.pending, 1, `${mode}: stale ABA candidate remains explicitly pending`);
    assert.equal(retry.ok, false, `${mode}: stale ABA recovery fails closed`);
    assert.match(retry.entries?.[0]?.error || '', /conditional_batch_state_changed/, `${mode}: retry records the read-set conflict`);
    assert.equal(head.narrative?.threads?.some(thread => thread.summary === '오늘 열쇠 반환 약속' && thread.status === 'open'), true,
      `${mode}: prior valid open lifecycle remains current after stale candidate rejection`);
    const mina = head.characters.find(character => character.name === '민아');
    assert.ok(mina, `${mode}: prior character State survives stale retry`);
    const stateText = JSON.stringify(mina.state || {});
    assert.match(stateText, /민트차를 좋아한다/, `${mode}: v5 preference survives stale State rejection`);
    assert.ok(Array.isArray(mina.state?.boundaries) && mina.state.boundaries.length > 0,
      `${mode}: v5 boundary survives stale State rejection`);

    const history = await f.r.api.getWorldManagerHistoryDetail({ memoryId: memory.memoryId, revision: memory.revision });
    assert.equal(history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution,
      'fulfilled', `${mode}: v5 thread/link remains in History`);
    assert.equal(history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.linkStatus,
      'accepted', `${mode}: History records the accepted v5 link`);
    const recall = await f.r.api.previewUnifiedMemoryRecall('민아 민트차 열쇠 반환 약속');
    const recallText = JSON.stringify(recall);
    assert.match(recallText, /민트차를 좋아한다/, `${mode}: v5 preference is readable through Recall`);
    assert.match(recallText, /이행되었다|반환/, `${mode}: v5 linked thread is readable through Recall`);
    const packet = await f.r.api.prepareInputWriterEvidence('민아 민트차 열쇠 반환 약속');
    const packetText = JSON.stringify(packet?.evidencePacket || {});
    assert.match(packetText, /민트차를 좋아한다/, `${mode}: Input Writer packet carries the structured profile`);
    assert.match(packetText, /이행되었다/, `${mode}: Input Writer packet carries the accepted resolved lifecycle`);

    observation.providerCalls = f.control.calls.length;
    observation.injectionObserved = fault.observation.injected;
    observation.stateBatchCount = stateBatchCount;
    observation.abaOriginalRevision = fault.observation.originalRevision;
    observation.abaTemporaryRevision = fault.observation.temporaryRevision;
    observation.abaRestoredRevision = fault.observation.restoredRevision;
    observation.sameOperationId = fault.observation.body.operationId;
    observation.retryCode = retry.code || 'durable_retry';
    observation.retryRecovered = Number(retry.recovered || 0);
    observation.memoryId = memory.memoryId;
    observation.stateThroughTurn = head.throughTurn;
    observation.canonicalThroughTurn = memory.turnRange.end;
    observation.retryPending = retry.pending;
    assert.equal(head.throughTurn, 5, `${mode}: stale ABA retry preserves the prior State frontier`);
    observation.historyResolution = history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution;
    observation.recallMemoryCount = recall.memories.length;
    assert.equal(observation.providerCalls, 2, `${mode}: stale recovery does not re-run the provider`);
    return observation;
  } finally {
    await snapshot.cleanup();
  }
};

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  const strip = ({ mode, retryRecovered, sameOperationId, ...rest }) => rest;
  assert.deepEqual(strip(results.mirror), strip(results.server_only), 'mirror and server_only preserve stale v5 State rejection semantics');
  console.log(JSON.stringify({
    test: 'libra_phase_d_v5_aba_correction_recovery',
    passed: MODES.length,
    results,
    boundary: 'synthetic provider artifact; external same-value ABA correction on real HTTP/SQLite State CAS; stale State candidate rejected, prior Head preserved, canonical v5 History/Recall readable in mirror and server_only'
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
