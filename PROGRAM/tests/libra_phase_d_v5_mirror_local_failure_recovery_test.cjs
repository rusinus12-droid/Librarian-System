'use strict';

// Phase D2 mirror fault: remote State commit succeeds, then the local mirror
// write fails. The local replica must not become an authority; after the
// failure is removed an explicit retry restores the v5 State/History/Recall
// surfaces. This is intentionally a narrow semantic fixture.
const assert = require('node:assert/strict');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const A06_ACTION = require('./fixtures/acceptance_scenarios.json').cases.find(row => row.id === 'A06').action;

const MODES = ['mirror'];
const expose = source => source.replace('  const RisuCompat = (() => {',
  '  globalThis.__auditStorageBridge = MemorySuiteStorageBridge;\n  const RisuCompat = (() => {');
const bridge = snapshot => snapshot.f.r.context.__auditStorageBridge;

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
  return start === 1 ? localJson(snapshot, /:memory:1:/) : null;
};

const localHeadOf = snapshot => localJson(snapshot, /:continuity-state$/);
const copies = snapshot => {
  for (const row of snapshot.storedRows().filter(row => row.key.endsWith(':manifest')
    || row.value?.schema === 'libra.continuity_state.v2'
    || row.value?.schema === 'libra.entity_registry.v2')) {
    assert.equal(snapshot.local.get(row.key), row.raw, `${row.key}: repaired mirror raw bytes match server`);
  }
};

const installMirrorLocalFailure = snapshot => {
  // Hook the fixture's actual pluginStorage backend. The public LIBRA proxy
  // can read the authoritative server and repair a mirror on demand; this
  // hook must fail the local write itself, before the backing Map changes.
  const storage = snapshot.backend;
  const original = storage.setItem;
  const observation = { injected: false, remoteStateSeen: false, body: null, localStateWriteFailures: 0 };
  snapshot.hooks.afterBatch = async body => {
    if (observation.remoteStateSeen) return;
    if (body.mutations.some(mutation => String(mutation.key || '').endsWith(':continuity-state'))) {
      observation.remoteStateSeen = true;
      observation.body = clone(body);
    }
  };
  storage.setItem = async (key, raw, ...rest) => {
    const value = parse(raw);
    if (value.schema === 'libra.continuity_state.v2') {
      observation.injected = true;
      observation.localStateWriteFailures += 1;
      return false;
    }
    return original.call(storage, key, raw, ...rest);
  };
  return { observation, restore: () => { storage.setItem = original; snapshot.hooks.afterBatch = null; } };
};

const runMode = async mode => {
  const snapshot = await serverFixture({ mode, transformSource: expose });
  const observation = { mode };
  try {
    let f = snapshot.f;
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
    const localStateKey = [...snapshot.local.keys()].find(key => /:continuity-state$/.test(key));
    assert.ok(localStateKey, `${mode}: local mirror State key is captured before the fault`);

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
    const fault = installMirrorLocalFailure(snapshot);
    const originalDiag = f.r.context.__librarianDiag;
    const diagnosticEvents = [];
    const diagnosticSpy = (namespace, tag, error) => {
      diagnosticEvents.push({ namespace, tag, message: String(error?.message || error || '') });
      return originalDiag?.(namespace, tag, error);
    };
    diagnosticSpy.registerSink = originalDiag?.registerSink;
    diagnosticSpy.snapshot = originalDiag?.snapshot;
    diagnosticSpy.reset = originalDiag?.reset;
    f.r.context.__librarianDiag = diagnosticSpy;
    const second = await f.run();
    const localHeadRawDuringFault = localHeadOf(snapshot);
    const serverHeadDuringFault = snapshot.getHead();
    f.r.context.__librarianDiag = originalDiag;
    const semanticChatSnapshot = clone(f.chat);
    fault.restore();
    assert.equal(fault.observation.remoteStateSeen, true, `${mode}: remote State commit was observed before local failure`);
    assert.equal(fault.observation.injected, true, `${mode}: local mirror failure injection actually ran`);
    assert.ok(fault.observation.body?.operationId, `${mode}: remote State operation is captured`);
    assert.equal(second.completed, 1, `${mode}: remote canonical and State operation completes despite local mirror refusal`);
    const providerCallsBeforeRestart = f.control.calls.length;
    const memory = memoryOf(snapshot, 6);
    assert.equal(memory?.artifactSchema, 'libra.canonical_artifact.v5', `${mode}: v5 canonical bytes are durable`);
    assert.equal(memory?.status, 'committed', `${mode}: canonical memory is committed`);
    assert.equal(serverHeadDuringFault?.throughTurn, 10, `${mode}: server State Head is durable at T10 after local failure`);
    assert.ok(fault.observation.localStateWriteFailures > 0, `${mode}: local State writes were actually refused while the fault was active`);
    assert.ok(diagnosticEvents.some(event => event.namespace === 'libra' && event.tag === 'storage.mirror.readback'),
      `${mode}: the documented storage.mirror.readback diagnostic hook observed the local failure`);
    assert.equal(localHeadRawDuringFault?.throughTurn, 5,
      `${mode}: raw local mirror remains at the prior T5 Head while the T10 write is refused`);

    await snapshot.restart();
    f = snapshot.f;
    // serverFixture restart intentionally creates a fresh runtime. Restore the
    // same accepted v5 transcript so Input Writer can be checked against the
    // exact source evidence after the storage repair.
    f.chat.id = semanticChatSnapshot.id;
    f.chat.chatId = semanticChatSnapshot.chatId;
    f.chat.message = semanticChatSnapshot.message;
    f.chat.messages = f.chat.message;
    assert.equal(f.control.calls.length, 0, `${mode}: restart is non-generative after mirror failure`);
    await bridge(snapshot).synchronizeNow();
    copies(snapshot);
    const publicReadback = await f.r.api.getCurrentStateHead();
    assert.equal(publicReadback?.throughTurn, 10, `${mode}: synchronized public State readback sees the durable remote successor`);
    const head = headOf(snapshot);
    assert.ok(head, `${mode}: State readback exists after synchronize`);
    assert.equal(head.status, 'ready', `${mode}: recovered State is authoritative and ready`);
    assert.equal(localHeadOf(snapshot)?.throughTurn, 10, `${mode}: synchronize repairs the local mirror to T10`);
    assert.deepEqual(localHeadOf(snapshot), snapshot.getHead(), `${mode}: local mirror converges exactly to remote State after synchronize`);
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
    const packet = await f.r.api.prepareInputWriterEvidence('민아 민트차 열쇠 반환 약속');
    const packetText = JSON.stringify(packet?.evidencePacket || {});
    if (!/민트차를 좋아한다/.test(packetText)) {
      throw new Error(JSON.stringify({
        headStatus: head.status,
        headThroughTurn: head.throughTurn,
        characterNames: (head.characters || []).map(character => character.name),
        minaState: head.characters?.find(character => character.name === '민아')?.state || null,
        packetMemoryCount: packet?.evidencePacket?.memories?.length || 0,
        packetPreview: packetText.slice(0, 500)
      }));
    }
    assert.match(packetText, /민트차를 좋아한다/, `${mode}: Input Writer packet carries the structured profile`);
    assert.match(packetText, /이행되었다/, `${mode}: Input Writer packet carries the accepted resolved lifecycle`);

    observation.providerCalls = providerCallsBeforeRestart;
    observation.injectionObserved = fault.observation.injected;
    observation.localStateWriteFailures = fault.observation.localStateWriteFailures;
    observation.localHeadDuringFault = localHeadRawDuringFault?.throughTurn ?? null;
    observation.serverHeadDuringFault = serverHeadDuringFault?.throughTurn ?? null;
    observation.memoryId = memory.memoryId;
    observation.stateThroughTurn = head.throughTurn;
    assert.equal(head.throughTurn, 10, `${mode}: synchronized State remains at the committed successor`);
    observation.historyResolution = history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution;
    observation.recallMemoryCount = recall.memories.length;
    assert.equal(observation.providerCalls, 2, `${mode}: mirror fault path uses the original two provider calls`);
    return observation;
  } finally {
    await snapshot.cleanup();
  }
};

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  console.log(JSON.stringify({
    schema: 'acceptance.action_result.v1', case_id: 'A06', mode: 'mirror',
    action: A06_ACTION, assertion_result: true,
    observed: `At injected local write failure raw local State stayed at ${results.mirror.localHeadDuringFault}, remote State reached ${results.mirror.serverHeadDuringFault}; after reconnect, synchronize read back turn ${results.mirror.stateThroughTurn} and repaired local raw State.`
  }));
  console.log(JSON.stringify({
    test: 'libra_phase_d_v5_mirror_local_failure_recovery',
    passed: MODES.length,
    results,
    boundary: 'synthetic provider artifact; mirror remote State commit succeeds while local mirror write fails; restart+synchronizeNow repairs the local replica from remote authority and preserves v5 State/History/Recall'
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
