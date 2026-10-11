'use strict';

// Phase D2 correction race: an old v5 State candidate is refused after an
// external user correction. Canonical history remains durable while the
// corrected Head is preserved.
// durable State/History/Recall surfaces recover. This is intentionally a
// narrow semantic fixture; the older v4 fault matrix remains separate.
const assert = require('node:assert/strict');
const { readActualCanonicalDelivery } = require('./fixtures/libra_actual_canonical_delivery.cjs');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { fixture, artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];

// The callback runs after the real replay State transaction has been prepared,
// before its durable tx journal is written and conditional commit dispatched.
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
const CORRECTION_CONDITION = '사용자가 현재 상태를 정정했다';

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

// Create a second LIBRA runtime against the same loopback server and plugin
// storage.  The second runtime is the user/editor writer: its public correction
// API appends the real journal and rebuilds the real Head while the primary
// runtime is between State preparation and its conditional commit.
const createCorrectionRuntime = async (snapshot, mode, chat) => {
  // The LIBRA VM owns the loopback authentication headers.  Passing through
  // the request unchanged preserves the same bootstrap/session contract as
  // serverFixture and avoids replacing the SDK's bearer with a test token.
  const nativeFetch = async (url, init = {}) => fetch(url, init);
  // Keep a distinct adapter object for the second VM.  Both adapters address
  // the same local Map, but the primary plugin_only fault wrapper must not
  // intercept the correction runtime's own State write recursively.
  const local = snapshot.local;
  const backend = {
    getItem: async key => local.get(key) ?? null,
    setItem: async (key, value) => { local.set(key, value); return true; },
    removeItem: async key => { local.delete(key); return true; },
    keys: async () => [...local.keys()]
  };
  return fixture({
    // `fixture.options.mode` controls the memory engine, while the storage
    // backend mode belongs in memory_suite_server_mode.  Keep the secondary
    // runtime on the unified engine for every D2 storage mode.
    mode: 'unified',
    snapshot: { chat: clone(chat) },
    args: { memory_suite_server_mode: mode, memory_suite_server_url: snapshot.url },
    host: {
      pluginStorage: backend,
      safeLocalStorage: backend,
      getLocalPluginStorage: async () => backend,
      nativeFetch
    }
  });
};

const installPublicCorrectionRace = (snapshot, correctionRuntime) => {
  const observation = {
    injected: false, body: null, beforeHead: null, afterHead: null,
    correction: null, correctionError: null
  };
  const applyCorrection = async body => {
    if (observation.injected) return;
    if (body) observation.body = clone(body);
    try {
      // Mirror runtimes may keep the public projection cold even though the
      // authoritative Head is readable from the primary snapshot.  The public
      // correction API still performs its own durable read; use the actual
      // primary snapshot only to select the stable entity identity.
      observation.beforeHead = headOf(snapshot) || await correctionRuntime.r.api.getCurrentStateHead();
      const mina = observation.beforeHead?.characters?.find(character => character.name === '민아');
      assert.ok(mina?.id, `public correction target character is present in the durable Head ${JSON.stringify({ status: observation.beforeHead?.status, throughTurn: observation.beforeHead?.throughTurn, characters: observation.beforeHead?.characters?.map(row => ({ id: row.id, name: row.name })) })}`);
      observation.correction = await correctionRuntime.r.api.addWorldManagerCorrection({
        anchorTurn: 5,
        target: { domain: 'characters' },
        patch: { characters: [{ id: mina.id, set: { condition: CORRECTION_CONDITION } }] }
      });
      assert.equal(observation.correction?.ok, true, 'public correction API commits a real journal record');
      observation.afterHead = observation.correction?.head || headOf(snapshot) || await correctionRuntime.r.api.getCurrentStateHead();
    } catch (error) {
      observation.correctionError = String(error?.code || error?.message || error);
      observation.correctionStack = String(error?.stack || '').slice(0, 1200);
      throw error;
    } finally {
      observation.injected = true;
    }
  };
  snapshot.f.r.context.__phaseDBeforeStateCommit = applyCorrection;
  return { observation, restore: () => { delete snapshot.f.r.context.__phaseDBeforeStateCommit; } };
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

const runMode = async mode => {
  const snapshot = await serverFixture({ mode, transformSource: stateCommitHookTransform });
  const observation = { mode };
  let correctionRuntime;
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
    correctionRuntime = await createCorrectionRuntime(snapshot, mode, f.chat);
    const fault = installPublicCorrectionRace(snapshot, correctionRuntime);
    let second; let secondError;
    try { second = await f.run(); } catch (error) { secondError = error; }
    for (let i = 0; i < 400 && !fault.observation.injected; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
    fault.restore();
    assert.equal(fault.observation.injected, true, `${mode}: user correction injection actually ran`);
    assert.ok(fault.observation.body?.tx?.scopeKey, `${mode}: correction race captures the prepared State transaction`);
    assert.equal(fault.observation.correction?.ok, true, `${mode}: public user correction journal commits ${JSON.stringify({ correction: fault.observation.correction, error: fault.observation.correctionError, stack: fault.observation.correctionStack })}`);
    assert.ok(fault.observation.correction?.correctionId, `${mode}: public correction returns its durable correctionId`);
    const preparedTxText = JSON.stringify(fault.observation.body?.tx || {});
    assert.doesNotMatch(preparedTxText, new RegExp(CORRECTION_CONDITION), `${mode}: prepared State transaction excludes the later correction patch`);
    assert.notEqual(fault.observation.beforeHead?.characters?.find(character => character.name === '민아')?.state?.condition,
      CORRECTION_CONDITION, `${mode}: correction race starts from a Head without the later public condition`);
    assert.doesNotMatch(preparedTxText, /state_correction_[a-z0-9_]+/, `${mode}: prepared State transaction excludes the later correction journal id`);
    assert.equal(fault.observation.afterHead?.characters?.find(character => character.name === '민아')?.state?.condition,
      CORRECTION_CONDITION, `${mode}: public condition correction updates the durable Head before stale candidate commit`);
    const correctionPage = await f.r.api.listWorldManagerCorrections({ domain: 'characters', status: 'active', limit: 20 });
    const correctionRecord = correctionPage.items.find(item => item.correctionId === fault.observation.correction.correctionId);
    assert.ok(correctionRecord, `${mode}: public correction journal is readable by the primary runtime`);
    assert.equal(correctionRecord.status, 'active', `${mode}: correction journal readback is active`);
    assert.equal(correctionRecord.target?.domain, 'characters', `${mode}: correction journal preserves its target domain`);
    assert.equal(correctionRecord.after?.characters?.[0]?.set?.condition, CORRECTION_CONDITION, `${mode}: correction journal readback preserves the condition patch`);
    const stateBatchCount = snapshot.batches.filter(body => body.mutations.some(item => String(item.key || '').endsWith(':continuity-state'))).length;
    assert.ok(mode === 'plugin_only' || stateBatchCount >= 1, `${mode}: State write activity is observed around the correction race`);
    assert.ok(secondError || second?.completed === 1, `${mode}: primary candidate reaches a settled result around the correction race`);
    const memory = memoryOf(snapshot, 6);
    assert.equal(memory?.artifactSchema, 'libra.canonical_artifact.v5', `${mode}: v5 canonical bytes are durable`);
    assert.equal(memory?.status, 'committed', `${mode}: canonical memory is committed`);
    const headBeforeRetry = headOf(snapshot);
    const retry = await f.r.api.retryPendingUnifiedState();
    assert.ok(retry && typeof retry === 'object', `${mode}: post-race recovery returns an explicit durable outcome`);
    const head = headOf(snapshot);
    assert.ok(head, `${mode}: State readback exists after retry`);
    assert.equal(head.characters.find(character => character.name === '민아')?.state?.condition,
      CORRECTION_CONDITION, `${mode}: stale candidate cannot overwrite the public corrected Head`);
    assert.equal(head.status, 'ready', `${mode}: recovered State is authoritative and ready`);
    assert.equal(head.narrative?.threads?.some(thread => thread.summary === '오늘 열쇠 반환 약속' && thread.status === 'open'), false,
      `${mode}: rebuilt State retains the resolved v5 lifecycle after public correction`);
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
    const packet = await readActualCanonicalDelivery(snapshot, '민아 민트차 열쇠 반환 약속', { expectedMemory: memory });
    const packetText = packet.canonicalText;
    assert.match(packetText, /민트차를 좋아한다/, `${mode}: Classic delivered canonical evidence carries the structured profile`);
    assert.match(packetText, /이행되었다/, `${mode}: Classic delivered canonical evidence carries the accepted resolved lifecycle`);

    observation.providerCalls = f.control.calls.length;
    observation.injectionObserved = fault.observation.injected;
    observation.correctionId = fault.observation.correction?.correctionId || null;
    observation.correctionMode = 'public_api_two_runtime_race';
    observation.journalReadback = { correctionId: correctionRecord.correctionId, status: correctionRecord.status, targetDomain: correctionRecord.target?.domain };
    observation.preparedTxContainsCorrection = new RegExp(CORRECTION_CONDITION).test(preparedTxText);
    observation.headBeforeRetry = {
      throughTurn: Number(headBeforeRetry?.throughTurn || 0),
      status: headBeforeRetry?.status || '',
      condition: headBeforeRetry?.characters?.find(character => character.name === '민아')?.state?.condition || null
    };
    observation.beforeCorrectionCondition = fault.observation.beforeHead?.characters?.find(character => character.name === '민아')?.state?.condition || null;
    observation.stateBatchCount = stateBatchCount;
    observation.retryCode = retry.code || 'durable_retry';
    observation.retryRecovered = Number(retry.recovered || 0);
    observation.secondCompleted = Number(second?.completed || 0);
    observation.secondError = secondError?.code || secondError?.message || null;
    observation.memoryId = memory.memoryId;
    observation.stateThroughTurn = head.throughTurn;
    observation.canonicalThroughTurn = memory.turnRange.end;
    observation.retryPending = retry.pending;
    assert.equal(head.throughTurn, 10, `${mode}: correction recovery reaches the v5 State frontier`);
    observation.historyResolution = history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution;
    observation.recallMemoryCount = recall.memories.length;
    assert.equal(observation.providerCalls, 2, `${mode}: stale recovery does not re-run the provider`);
    return observation;
  } finally {
    await correctionRuntime?.r.cleanup();
    await snapshot.cleanup();
  }
};

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  for (const mode of MODES) {
    assert.equal(results[mode].injectionObserved, true, `${mode}: correction observation is present in final accounting`);
    assert.equal(results[mode].historyResolution, 'fulfilled', `${mode}: corrected run retains v5 History resolution`);
  }
  console.log(JSON.stringify({
    test: 'libra_phase_d_v5_correction_race_recovery',
    passed: MODES.length,
    results,
    boundary: 'synthetic provider artifact; a second LIBRA runtime calls the public addWorldManagerCorrection API at the real State batch boundary; the durable correction journal and corrected Head are read back before stale candidate retry, and v5 preference/History/Recall/Classic consumer remain readable'
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
