'use strict';

// Phase D2 commit-before-scope boundary: a State candidate is refused when
// chat identity changes after State preparation and before the State commit.
// Canonical memory may already be durable; the State side-effect must fail
// closed and recovery must preserve the prior valid Head. This is intentionally a
// narrow semantic fixture; the older v4 fault matrix remains separate.
const assert = require('node:assert/strict');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];

// The callback runs after the replay State transaction is fully prepared, but
// before its durable journal is written and conditional commit is dispatched.
// This keeps the fixture at the product's scope guard instead of mutating a
// batch after HTTP dispatch has already started.
const stateCommitHookTransform = source => {
  const needle = /await storage\.setJson\(unifiedReplayTxKey\(context\.scope\),tx\);/g;
  assert.equal(source.match(needle)?.length || 0, 1, 'State replay preparation hook anchor is unique');
  return source.replace(needle,
    `if(typeof globalThis.__phaseDBeforeStateCommit==='function') await globalThis.__phaseDBeforeStateCommit({mode:'replay',tx:clone(tx)});\n        await storage.setJson(unifiedReplayTxKey(context.scope),tx);`);
};

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
const persistedRows = snapshot => [
  ...snapshot.storedRows(),
  ...[...snapshot.local.entries()].map(([key, raw]) => ({ key, value: parse(raw) }))
];
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

const installCommitScopeTransition = (snapshot, chat) => {
  const observation = { injected: false, body: null };
  const applyTransition = async body => {
    if (observation.injected) return;
    observation.injected = true;
    observation.body = clone(body?.tx || body);
    chat.id = 'scope-transition-chat';
    chat.chatId = 'scope-transition-chat';
  };
  snapshot.f.r.context.__phaseDBeforeStateCommit = applyTransition;
  return { observation, restore: () => { delete snapshot.f.r.context.__phaseDBeforeStateCommit; } };
};


const runMode = async mode => {
  const snapshot = await serverFixture({ mode, transformSource: stateCommitHookTransform });
  const observation = { mode };
  try {
    const f = snapshot.f;
    const originalChatId = f.chat.chatId;
    const originalId = f.chat.id;
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
    const originalScopeKey = firstHead?.scopeKey;
    assert.equal(firstHead?.status, 'ready', `${mode}: first State is ready before scope transition`);
    assert.equal(firstHead?.throughTurn, 5, `${mode}: first State frontier is T5`);
    assert.equal(firstHead.narrative?.threads?.some(thread => thread.summary === '오늘 열쇠 반환 약속' && thread.status === 'open'), true,
      `${mode}: first open lifecycle is current before scope transition`);

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
    const fault = installCommitScopeTransition(snapshot, f.chat);
    let transitioned; let transitionError;
    try { transitioned = await f.run(); } catch (error) { transitionError = error; }
    const changedRuntimeMeta = await f.r.api.getWorldManagerRuntimeMeta();
    const changedScopeKey = changedRuntimeMeta?.scopeKey || '';
    fault.restore();
    assert.equal(fault.observation.injected, true, `${mode}: chat identity transition was injected before State commit`);
    const warningText = JSON.stringify(transitioned?.stateWarnings || transitioned?.result?.stateWarnings || transitioned || {});
    assert.match(warningText, /UNIFIED_SCOPE_CHANGED/, `${mode}: State commit records the scope change explicitly`);
    assert.equal(memoryOf(snapshot, 6)?.artifactSchema, 'libra.canonical_artifact.v5', `${mode}: canonical memory remains durable before the State guard`);
    assert.equal(memoryOf(snapshot, 6)?.status, 'committed', `${mode}: changed-scope canonical memory is committed independently of State`);
    assert.equal(headOf(snapshot)?.throughTurn, 5, `${mode}: prior valid Head remains after scope rejection`);
    assert.equal(headOf(snapshot)?.narrative?.threads?.some(thread => thread.summary === '오늘 열쇠 반환 약속' && thread.status === 'open'), true,
      `${mode}: prior open lifecycle remains after scope rejection`);
    assert.ok(changedScopeKey && changedScopeKey !== originalScopeKey, `${mode}: changed chat resolves to a distinct scope identity`);
    const changedScopeRows = persistedRows(snapshot).filter(row => row.value?.scopeKey === changedScopeKey || row.key.includes(`:scope:${changedScopeKey}:`));
    assert.equal(changedScopeRows.length, 0, `${mode}: changed chat identity does not publish rows in its target namespace`);
    const originalScopeRows = persistedRows(snapshot).filter(row => /:continuity-state$|:memory:\d+:r\d+$/.test(row.key));
    assert.ok(originalScopeRows.length > 0 && originalScopeRows.every(row => row.value?.scopeKey === originalScopeKey),
      `${mode}: canonical and State rows remain in the original scope`);
    const callsAfterRejection = f.control.calls.length;

    f.chat.id = originalId;
    f.chat.chatId = originalChatId;
    const retried = await f.r.api.retryPendingUnifiedState();
    assert.ok(retried && typeof retried === 'object', `${mode}: restored-scope retry returns a durable outcome`);
    assert.equal(f.control.calls.length, callsAfterRejection,
      `${mode}: restored-scope retry does not call the provider again`);
    const memory = memoryOf(snapshot, 6);
    assert.equal(memory?.artifactSchema, 'libra.canonical_artifact.v5', `${mode}: restored-scope v5 canonical memory is durable`);
    assert.equal(memory?.status, 'committed', `${mode}: restored-scope canonical memory is committed`);
    const head = headOf(snapshot);
    assert.equal(head?.status, 'ready', `${mode}: restored-scope State is ready`);
    assert.equal(head?.throughTurn, 10, `${mode}: restored-scope State reaches T10`);
    assert.equal(head.narrative?.threads?.some(thread => thread.summary === '오늘 열쇠 반환 약속'), false,
      `${mode}: restored-scope fulfilled lifecycle closes the open thread`);
    const mina = head.characters.find(character => character.name === '민아');
    assert.match(JSON.stringify(mina?.state || {}), /민트차를 좋아한다/, `${mode}: restored-scope State keeps the v5 preference`);
    assert.ok(Array.isArray(mina?.state?.boundaries) && mina.state.boundaries.length > 0, `${mode}: restored-scope State keeps the v5 boundary`);
    const history = await f.r.api.getWorldManagerHistoryDetail({ memoryId: memory.memoryId, revision: memory.revision });
    assert.equal(history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution, 'fulfilled', `${mode}: restored-scope History keeps fulfilled lifecycle`);
    assert.equal(history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.linkStatus, 'accepted', `${mode}: restored-scope History keeps accepted link`);
    const recall = await f.r.api.previewUnifiedMemoryRecall('민아 민트차 열쇠 반환 약속');
    const recallText = JSON.stringify(recall);
    assert.match(recallText, /민트차를 좋아한다/, `${mode}: restored-scope Recall keeps structured preference`);
    assert.match(recallText, /이행되었다|반환/, `${mode}: restored-scope Recall keeps resolved lifecycle`);
    const packet = await f.r.api.prepareInputWriterEvidence('민아 민트차 열쇠 반환 약속');
    const packetText = JSON.stringify(packet?.evidencePacket || {});
    assert.match(packetText, /민트차를 좋아한다/, `${mode}: restored-scope Input Writer keeps structured preference`);
    assert.match(packetText, /이행되었다/, `${mode}: restored-scope Input Writer keeps resolved lifecycle`);
    observation.providerCalls = f.control.calls.length;
    observation.transitionRejected = true;
    observation.transitionError = transitionError?.code || transitionError?.message || null;
    observation.transitionWarning = (transitioned?.stateWarnings || transitioned?.result?.stateWarnings || []).map(item => item.reason || item);
    observation.canonicalPublishedBeforeStateGuard = true;
    observation.retryCode = retried.code || 'durable_retry';
    observation.retryPending = Number(retried.pending || 0);
    observation.originalScopeKey = originalScopeKey;
    observation.changedScopeKey = changedScopeKey;
    observation.changedScopeRows = changedScopeRows.length;
    observation.transitionOperationId = fault.observation.body?.operationId || null;
    observation.memoryId = memory.memoryId;
    observation.stateThroughTurn = head.throughTurn;
    observation.historyResolution = history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution;
    observation.recallMemoryCount = recall.memories.length;
    return observation;
  } finally {
    await snapshot.cleanup();
  }
};

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  for (const field of ['transitionRejected', 'canonicalPublishedBeforeStateGuard', 'stateThroughTurn', 'historyResolution', 'retryPending']) {
    assert.deepEqual(results.mirror[field], results.server_only[field], `mirror and server_only preserve ${field}`);
  }
  console.log(JSON.stringify({
    test: 'libra_phase_d_v5_state_scope_commit_boundary',
    passed: MODES.length,
    results,
    boundary: 'synthetic provider artifact; chat identity transition is injected at the real State batch boundary, stale scope is rejected or fails closed, and explicit identity restoration uses pending-State retry to recover v5 State/History/Recall/Input Writer in all three storage modes'
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
