'use strict';

// Phase D2: fault recovery must preserve the new v5 meanings while the
// durable State/History/Recall surfaces recover. This is intentionally a
// narrow semantic fixture; the older v4 fault matrix remains separate.
const assert = require('node:assert/strict');
const { readActualCanonicalDelivery } = require('./fixtures/libra_actual_canonical_delivery.cjs');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];

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

const wrapPluginStateWrite = snapshot => {
  const storage = snapshot.f.r.context.risuai.pluginStorage;
  const original = storage.setItem;
  let injected = false;
  storage.setItem = async (key, raw, ...rest) => {
    const value = parse(raw);
    if (!injected && value.schema === 'libra.continuity_state.v2') {
      injected = true;
      throw new Error('phase_d_v5_state_write_fault');
    }
    return original.call(storage, key, raw, ...rest);
  };
  return () => { storage.setItem = original; };
};

const installServerStateFault = snapshot => {
  snapshot.app.repositories.libra.database.exec(
    "CREATE TEMP TRIGGER phase_d_v5_state_fault_insert BEFORE INSERT ON kv WHEN NEW.key LIKE '%:continuity-state' BEGIN SELECT RAISE(ABORT,'phase_d_v5_state_write_fault'); END;"
  );
  snapshot.app.repositories.libra.database.exec(
    "CREATE TEMP TRIGGER phase_d_v5_state_fault_update BEFORE UPDATE ON kv WHEN NEW.key LIKE '%:continuity-state' BEGIN SELECT RAISE(ABORT,'phase_d_v5_state_write_fault'); END;"
  );
  return () => {
    snapshot.app.repositories.libra.database.exec('DROP TRIGGER phase_d_v5_state_fault_insert');
    snapshot.app.repositories.libra.database.exec('DROP TRIGGER phase_d_v5_state_fault_update');
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
    const removeFault = mode === 'plugin_only' ? wrapPluginStateWrite(snapshot) : installServerStateFault(snapshot);
    const second = await f.run();
    removeFault();
    const secondMemoryBeforeRetry = memoryOf(snapshot, 6);
    assert.equal(second.completed, 1, `${mode}: second v5 batch canonical commit survives State fault`);
    const memory = memoryOf(snapshot, 6);
    assert.equal(memory?.artifactSchema, 'libra.canonical_artifact.v5', `${mode}: v5 canonical bytes are durable`);
    assert.equal(memory?.status, 'committed', `${mode}: canonical memory is committed`);
    assert.equal(headOf(snapshot)?.throughTurn, firstHead.throughTurn, `${mode}: failed State write leaves the prior head active`);

    const retry = await f.r.api.retryPendingUnifiedState();
    assert.equal(retry.recovered, 1, `${mode}: durable State operation retries without another provider call`);
    const head = headOf(snapshot);
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

    const history = await f.r.api.getWorldManagerHistoryDetail({ memoryId: memory.memoryId, revision: memory.revision });
    assert.equal(history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution,
      'fulfilled', `${mode}: v5 thread/link remains in History`);
    assert.equal(history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.linkStatus,
      'accepted', `${mode}: History records the accepted v5 link`);
    const recall = await f.r.api.previewUnifiedMemoryRecall('민아 민트차 열쇠 반환 약속');
    const recallText = JSON.stringify(recall);
    assert.match(recallText, /민트차를 좋아한다/, `${mode}: v5 preference is readable through Recall`);
    assert.match(recallText, /이행되었다|반환/, `${mode}: v5 linked thread is readable through Recall`);
    const packet = await readActualCanonicalDelivery(snapshot, '민아 민트차 열쇠 반환 약속', { expectedMemory: memory });
    const packetText = packet.canonicalText;
    assert.match(packetText, /민트차를 좋아한다/, `${mode}: Classic delivered canonical evidence carries the structured profile`);
    assert.match(packetText, /이행되었다/, `${mode}: Classic delivered canonical evidence carries the accepted resolved lifecycle`);

    observation.providerCalls = f.control.calls.length;
    observation.retryCode = retry.code || 'recovered';
    observation.memoryId = memory.memoryId;
    observation.stateThroughTurn = head.throughTurn;
    observation.historyResolution = history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution;
    observation.recallMemoryCount = recall.memories.length;
    assert.equal(observation.providerCalls, 2, `${mode}: recovery does not re-run the provider`);
    return observation;
  } finally {
    await snapshot.cleanup();
  }
};

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  const strip = ({ mode, ...rest }) => rest;
  assert.deepEqual(strip(results.mirror), strip(results.plugin_only), 'mirror preserves v5 semantic recovery');
  assert.deepEqual(strip(results.server_only), strip(results.plugin_only), 'server_only preserves v5 semantic recovery');
  console.log(JSON.stringify({
    test: 'libra_phase_d_v5_fault_semantic_recovery',
    passed: MODES.length,
    results,
    boundary: 'synthetic provider artifact; actual LIBRA storage/State/History/Recall in all three modes'
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
