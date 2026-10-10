'use strict';
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { parent, branch, character, clone } = require('./fixtures/native_branch_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const source = require('./fixtures/unified_vertical_source.json');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const MODES = ['plugin_only', 'server_only'];
const EMBEDDING = {
  enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings',
  model: 'text-embedding-3-small', key: 'fixture-only', dimensions: 256, maxRetries: 0
};
const embeddingResponse = init => {
  const body = JSON.parse(init.body);
  return new Response(JSON.stringify({
    data: body.input.map((_, index) => ({ index, embedding: Array.from({ length: 256 }, (_, i) => i === 0 ? 1 : 0) })),
    usage: { total_tokens: 10 }
  }), { status: 200 });
};
const rowMessages = (fromTurn, placement) => source.sourceRows
  .filter(row => Number(row.ref.match(/^t(\d+)/)?.[1] || 0) >= fromTurn)
  .map(row => ({
    role: row.role,
    chatId: row.ref,
    data: row.text + (row.ref === 't2-a' ? ` ${placement.sentence}` : '')
  }));
const withPlacement = (value, placement) => {
  const output = clone(value);
  output.entities.push({
    tempId: placement.tempId, name: placement.container, type: 'world', kind: 'location',
    evidenceSpans: [{ ref: 't2-a', quote: placement.sentence }]
  });
  output.facts.push({
    tempFactId: placement.factId, domain: 'world', subjectTempRef: 'key', claimKind: 'placement',
    values: { containerRef: placement.tempId }, text: placement.factText,
    temporalRole: 'current_sequence', certainty: 'confirmed',
    evidenceSpans: [{ ref: 't2-a', quote: placement.sentence }]
  });
  output.stateBindings.push({
    factTempId: placement.factId, typedValueField: 'containerRef', stateDomain: 'world', stateField: 'containerRef'
  });
  return output;
};
const placements = {
  W0: { tempId: 'drawer', container: '서랍', sentence: '민아는 은빛 열쇠를 서랍에 넣었다.', factId: 'w0-drawer', factText: '은빛 열쇠는 서랍 안에 있다.' },
  W1: { tempId: 'vault', container: '금고', sentence: '민아는 은빛 열쇠를 금고에 넣었다.', factId: 'w1-vault', factText: '은빛 열쇠는 금고 안에 있다.' }
};
const shiftedArtifact = value => {
  const output = clone(value);
  for (const item of [...output.entities, ...output.facts]) {
    for (const span of item.evidenceSpans || []) span.ref = span.ref.replace(/^t(\d+)/, (_match, turn) => `t${Number(turn) + 5}`);
  }
  return output;
};
const selectedSources = mode => mode === 'plugin_only' ? ['local'] : mode === 'mirror' ? ['server', 'local'] : ['server'];
const decode = raw => {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
};
const findStoredKey = (fixture, key) => ['server', 'local'].map(sourceName => records(fixture, sourceName).find(row => row.key === key)).find(Boolean) || null;
const records = (fixture, sourceName) => sourceName === 'server'
  ? fixture.storedRows().map(row => ({ key: row.key, raw: String(row.raw), value: row.value }))
  : [...fixture.local.entries()].map(([key, raw]) => ({ key, raw: String(raw), value: decode(String(raw)) }));
const canonical = (fixture, chatId, sourceName) => {
  const rows = records(fixture, sourceName);
  const manifestRow = rows.find(row => row.key.endsWith(':manifest')
    && row.value?.schema === 'libra.manifest.v1' && row.value.chatId === chatId);
  if (!manifestRow) return null;
  const ref = manifestRow.value.memories?.['1'];
  if (!ref?.key) return null;
  const memoryRow = rows.find(row => row.key === ref.key);
  if (!memoryRow) return null;
  const memory = memoryRow.value;
  const evidenceRow = rows.find(row => row.key === memory.sourceEvidenceRef?.key);
  const vectorRow = rows.find(row => row.key === memory.embedding?.vectorKey);
  return { sourceName, manifest: manifestRow.value, ref, memoryRow, memory, evidenceRow, vectorRow };
};
const storageBundle = (fixture, chatId) => Object.fromEntries(selectedSources(fixture.mode).map(sourceName => [
  sourceName, canonical(fixture, chatId, sourceName)
]));
const findBundleCanonical = bundle => Object.values(bundle).find(Boolean) || null;
const requestBlock = messages => messages
  .filter(message => message?.role === 'system' && String(message.content || '').includes('[LIBRA CLASSIC RECALL'))
  .map(message => String(message.content || ''))[0] || '';
const liveChatState = fixture => {
  const runtime = fixture.f.r.api.getRuntime();
  return {
    lastInjection: String(runtime.lastInjection || ''),
    injectionScopeKey: runtime.lastMemoryInjectionMeta?.scopeKey || '',
    viewerScopeKey: runtime.lastMemoryRecallViewer?.scopeKey || '',
    viewerChatId: runtime.lastMemoryRecallViewer?.scope?.chatId || '',
    viewerInjected: Number(runtime.lastMemoryRecallViewer?.injectedMemories || 0),
    viewerError: runtime.lastMemoryRecallViewer?.errorCode || ''
  };
};
const diagnosticSummary = (state, expectedFact) => ({
  injectionScopeKey: state.injectionScopeKey,
  injectionContainsExpectedFact: state.lastInjection.includes(expectedFact),
  viewerScopeKey: state.viewerScopeKey,
  viewerChatId: state.viewerChatId,
  viewerInjected: state.viewerInjected,
  viewerError: state.viewerError
});
const makeWorlds = () => {
  const w0 = parent('unified-chat', 5);
  w0.name = 'W0 parent';
  w0.message = rowMessages(1, placements.W0);
  w0.messages = w0.message;
  const child = branch(w0, 1, 'w1-branch');
  child.name = 'W1 branch';
  child.messages = child.message;
  child.message.push(...rowMessages(2, placements.W1));
  child.messages = child.message;
  const char = character([w0]);
  char.id = 'unified-char';
  char.chaId = 'unified-char';
  let active = w0;
  const select = chat => {
    if (!char.chats.includes(chat)) char.chats.push(chat);
    active = chat;
    char.chatPage = char.chats.indexOf(chat);
    return chat;
  };
  const host = {
    getCurrentCharacterIndex: async () => 0,
    getCurrentChatIndex: async () => char.chats.indexOf(active),
    getCharacter: async () => char,
    getCharacterFromIndex: async () => char,
    getChatFromIndex: async (_characterIndex, chatIndex) => char.chats[chatIndex] || null,
    getDatabase: async fields => {
      const db = { personas: [], selectedPersona: '', characters: [char], plugins: [] };
      return Array.isArray(fields) ? Object.fromEntries(fields.map(key => [key, db[key] ?? null])) : db;
    }
  };
  return { w0, child, char, host, select };
};
const parentByteSnapshot = value => ({
  memoryRaw: value.memoryRow.raw,
  sourceDigest: value.memory.sourceDigest,
  sourceEvidenceRef: clone(value.memory.sourceEvidenceRef),
  evidenceRaw: value.evidenceRow?.raw || '',
  vectorRef: String(value.memory.embedding?.vectorKey || ''),
  embedding: clone(value.memory.embedding || null),
  vectorRaw: value.vectorRow?.raw || ''
});
const worldlineScopeSnapshot = value => ({
  scopeKey: value.manifest.scopeKey,
  chatId: value.manifest.chatId,
  worldlineId: value.ref.worldlineId,
  revision: value.ref.revision,
  memoryId: value.ref.memoryId,
  sourceDigest: value.ref.sourceDigest,
  sourceEvidenceRef: clone(value.memory.sourceEvidenceRef),
  vectorRef: String(value.memory.embedding?.vectorKey || '')
});

(async () => {
  const reports = {};
  for (const mode of MODES) {
    const worlds = makeWorlds();
    const fixture = await serverFixture({ mode, host: worlds.host, transformSource: source => {
      const anchor = '\n\n  const RisuCompat = (() => {';
      assert.equal(source.split(anchor).length, 2, 'unique actual storage bridge fixture exposure');
      return source.replace(anchor, '\n  globalThis.__fixtureStorageBridge = MemorySuiteStorageBridge;' + anchor);
    } });
    const report = { mode, worldline: {}, positive: {}, barrier: {}, stores: {} };
    try {
      fixture.mode = mode;
      // The current storage contract publishes per-chat mode explicitly. A legacy
      // global mode argument alone leaves plugin-only parent aliases unregistered.
      const bridge = fixture.f.r.context.__fixtureStorageBridge;
      const parentLineage = await fixture.f.r.api.getHostLineageStatus();
      const parentScope = { scopeId: parentLineage.scopeKey, scopeKey: parentLineage.scopeKey,
        characterId: parentLineage.characterId, chatId: worlds.w0.id,
        aliases: [parentLineage.scopeKey, worlds.w0.id], label: worlds.w0.id };
      await assert.rejects(() => bridge.setScopeMode(parentScope, 'mirror'), /memory_suite_mirror_is_transition_only/, 'mirror is rejected as a current operational mode');
      await bridge.setScopeMode(parentScope, mode);
      assert.equal((await bridge.getScopeMode(parentScope)).mode, mode, 'selected parent mode is durably published');
      fixture.hooks.externalFetch = async (_url, init) => embeddingResponse(init);
      await fixture.f.r.api.saveEmbeddingSettings(EMBEDDING);
      fixture.f.control.artifact = withPlacement(artifact(), placements.W0);
      const w0Run = await fixture.f.r.api.runManualColdStart();
      assert.equal(w0Run.completed, 1, `${mode}: W0 canonical creation: ${JSON.stringify(w0Run)}`);
      const w0Initial = findBundleCanonical(storageBundle(fixture, worlds.w0.id));
      assert.ok(w0Initial, `${mode}: W0 canonical must be readable from its selected authority`);
      await waitFor(() => canonical(fixture, worlds.w0.id, w0Initial.sourceName)?.memory?.embedding?.status === 'ready', 20000);

      worlds.select(worlds.child);
      fixture.f.control.artifact = withPlacement(artifact(), placements.W1);
      const w1Run = await fixture.f.r.api.runManualColdStart();
      assert.equal(w1Run.completed, 1, `${mode}: W1 canonical creation: ${JSON.stringify(w1Run)}`);
      const lineage = await fixture.f.r.api.getHostLineageStatus();
      assert.equal(lineage.kind, 'native_branch', `${mode}: W1 must be host-native branch`);
      assert.equal(lineage.status, 'verified', `${mode}: W1 native branch prefix must be verified`);
      assert.equal(lineage.forkMessageId, 't1-a', `${mode}: W1 forks at the shared T1 assistant message`);
      assert.equal(lineage.commonPrefixPairs, 1, `${mode}: exactly T1 is shared before the W1 branch`);
      assert.equal(lineage.parentChatId, worlds.w0.id, `${mode}: W1 parent is W0`);
      assert.equal(lineage.worldlineMeta?.forkTurn, 1, `${mode}: W1 forks after T1`);
      report.worldline = { kind: lineage.kind, status: lineage.status, parentChatId: lineage.parentChatId, forkTurn: lineage.worldlineMeta?.forkTurn ?? null };
      const w1Initial = findBundleCanonical(storageBundle(fixture, worlds.child.id));
      assert.ok(w1Initial, `${mode}: W1 canonical must be readable from its selected authority`);
      await waitFor(() => canonical(fixture, worlds.child.id, w1Initial.sourceName)?.memory?.embedding?.status === 'ready', 20000);

      worlds.select(worlds.w0);
      const w0Positive = await fixture.f.control.hooks.beforeRequest([{ role: 'user', content: '은빛 열쇠의 현재 보관 장소는 어디인가?' }], 'model');
      const w0Block = requestBlock(w0Positive);
      assert.ok(w0Block.includes(placements.W0.factText), `${mode}: registered W0 beforeRequest must inject its drawer fact`);
      assert.ok(!w0Block.includes(placements.W1.factText), `${mode}: W0 message must not contain W1's vault fact`);
      report.positive.W0 = { scopeKey: findBundleCanonical(storageBundle(fixture, worlds.w0.id)).manifest.scopeKey, fact: placements.W0.factText, registeredHook: true };

      worlds.select(worlds.child);
      const w1Positive = await fixture.f.control.hooks.beforeRequest([{ role: 'user', content: '은빛 열쇠의 현재 보관 장소는 어디인가?' }], 'model');
      const w1Block = requestBlock(w1Positive);
      assert.ok(w1Block.includes(placements.W1.factText), `${mode}: registered W1 beforeRequest must inject its vault fact`);
      assert.ok(!w1Block.includes(placements.W0.factText), `${mode}: W1 message must not contain W0's drawer fact`);
      const w0Before = findBundleCanonical(storageBundle(fixture, worlds.w0.id));
      const w1Before = findBundleCanonical(storageBundle(fixture, worlds.child.id));
      const w0BytesBefore = parentByteSnapshot(w0Before);
      const w1StateBefore = liveChatState(fixture);
      assert.equal(w1StateBefore.injectionScopeKey, w1Before.manifest.scopeKey, `${mode}: W1 positive diagnostics scope`);
      report.positive.W1 = { scopeKey: w1Before.manifest.scopeKey, fact: placements.W1.factText, registeredHook: true };

      const targetMemoryKey = w0Before.ref.key;
      let releaseGate;
      let entered = false;
      let gateRecord = null;
      const held = new Promise(resolve => { releaseGate = resolve; });
      const pause = async (sourceName, key, url = '') => {
        if (entered || key !== targetMemoryKey) return;
        entered = true;
        gateRecord = { source: sourceName, key, url, method: 'GET' };
        await held;
      };
      const originalGetItem = fixture.backend.getItem;
      fixture.backend.getItem = async key => {
        await pause('local', String(key));
        return originalGetItem(key);
      };
      fixture.hooks.beforeServerRequest = async (url, init) => {
        const parsed = new URL(url);
        if ((init?.method || 'GET').toUpperCase() === 'GET') {
          await pause('server', parsed.searchParams.get('key') || '', url);
        }
      };
      worlds.select(worlds.w0);
      const w0LatePromise = fixture.f.control.hooks.beforeRequest([{ role: 'user', content: '은빛 열쇠의 현재 보관 장소는 어디인가?' }], 'model');
      await waitFor(() => entered, 10000);
      assert.deepEqual(gateRecord && { key: gateRecord.key, method: gateRecord.method }, { key: targetMemoryKey, method: 'GET' }, `${mode}: barrier must hold the exact W0 canonical memory read`);
      report.barrier = { ...gateRecord };

      worlds.select(worlds.child);
      const w1DuringLate = await fixture.f.control.hooks.beforeRequest([{ role: 'user', content: '은빛 열쇠의 현재 보관 장소는 어디인가?' }], 'model');
      const w1DuringBlock = requestBlock(w1DuringLate);
      assert.ok(w1DuringBlock.includes(placements.W1.factText), `${mode}: W1 request while W0 canonical GET is pending`);
      assert.ok(!w1DuringBlock.includes(placements.W0.factText), `${mode}: W1 request must exclude late W0 fact`);
      const w1BeforeRelease = liveChatState(fixture);
      assert.equal(w1BeforeRelease.injectionScopeKey, w1Before.manifest.scopeKey, `${mode}: W1 state before release`);
      releaseGate();
      const w0LateMessages = await w0LatePromise;
      fixture.backend.getItem = originalGetItem;
      fixture.hooks.beforeServerRequest = null;
      report.barrier.w0OwnReturnHadInjection = !!requestBlock(w0LateMessages);

      const afterLate = liveChatState(fixture);
      assert.equal(afterLate.injectionScopeKey, w1Before.manifest.scopeKey,
        `${mode}: a late W0 response must not replace the observable W1 injection scope; before=${JSON.stringify(w1BeforeRelease)} after=${JSON.stringify(afterLate)}`);
      assert.equal(afterLate.viewerScopeKey, w1Before.manifest.scopeKey,
        `${mode}: a late W0 response must not replace the observable W1 recall viewer; before=${JSON.stringify(w1BeforeRelease)} after=${JSON.stringify(afterLate)}`);
      assert.equal(afterLate.lastInjection, w1BeforeRelease.lastInjection,
        `${mode}: a late W0 response must not clear/replace W1's model injection; before=${JSON.stringify(w1BeforeRelease)} after=${JSON.stringify(afterLate)}`);
      assert.equal(afterLate.viewerInjected, 1, `${mode}: W1 viewer remains a successful delivery after W0 completes`);
      const currentLineageAfterRelease = await fixture.f.r.api.getHostLineageStatus();
      assert.equal(currentLineageAfterRelease.hostChatId, worlds.child.id, `${mode}: current host scope remains W1 after W0 release`);
      assert.equal(currentLineageAfterRelease.scopeKey, w1Before.manifest.scopeKey, `${mode}: observable host-lineage scope remains W1 after W0 release`);
      assert.ok(w1BeforeRelease.lastInjection.includes(placements.W1.factText), `${mode}: W1 injection was present before release`);
      assert.ok(afterLate.lastInjection.includes(placements.W1.factText), `${mode}: W1 injection remains observable after release`);
      assert.equal(afterLate.viewerError, '', `${mode}: W1 viewer remains successful after late W0 completes`);
      report.barrier.diagnosticsBeforeRelease = diagnosticSummary(w1BeforeRelease, placements.W1.factText);
      report.barrier.diagnosticsAfterRelease = diagnosticSummary(afterLate, placements.W1.factText);
      report.barrier.currentHostLineageAfterRelease = { hostChatId: currentLineageAfterRelease.hostChatId, scopeKey: currentLineageAfterRelease.scopeKey };

      const w0After = findBundleCanonical(storageBundle(fixture, worlds.w0.id));
      const w1After = findBundleCanonical(storageBundle(fixture, worlds.child.id));
      assert.deepEqual(parentByteSnapshot(w0After), w0BytesBefore, `${mode}: selected W0 canonical/evidence/vector bytes remain unchanged`);
      assert.deepEqual(worldlineScopeSnapshot(w1After), worldlineScopeSnapshot(w1Before), `${mode}: late W0 must not alter W1 canonical identity or revision`);

      worlds.select(worlds.child);
      const w1AfterLate = await fixture.f.control.hooks.beforeRequest([{ role: 'user', content: '은빛 열쇠의 현재 보관 장소는 어디인가?' }], 'model');
      const w1AfterBlock = requestBlock(w1AfterLate);
      assert.ok(w1AfterBlock.includes(placements.W1.factText), `${mode}: fresh registered W1 beforeRequest after late W0 completion`);
      assert.ok(!w1AfterBlock.includes(placements.W0.factText), `${mode}: fresh W1 model messages exclude W0's late fact`);
      report.afterLate = {
        freshW1Fact: placements.W1.factText,
        W0ParentBytesUnchanged: true,
        W1CanonicalIdentityUnchanged: true,
        observableScopeKey: liveChatState(fixture).injectionScopeKey
      };

      // G09: cancel a W0 canonical analysis while its actual model result is held,
      // switch to W1, then release the old provider response and inspect its owner.
      worlds.w0.message.push(...source.sourceRows.map(row => ({
        role: row.role, chatId: row.ref.replace(/^t(\d+)/, (_match, turn) => `t${Number(turn) + 5}`), data: row.text
      })));
      worlds.w0.messages = worlds.w0.message;
      const lateArtifact = shiftedArtifact(artifact());
      fixture.f.control.artifact = lateArtifact;
      let providerEntered = false;
      let releaseProvider;
      const providerHeld = new Promise(resolve => { releaseProvider = resolve; });
      let providerArgs = null;
      fixture.f.control.onCall = async args => {
        if (!providerEntered) {
          providerEntered = true;
          providerArgs = clone(args);
          await providerHeld;
        }
        return { type: 'success', result: JSON.stringify(lateArtifact) };
      };
      worlds.select(worlds.w0);
      const parentJobPromise = fixture.f.r.api.runManualColdStart();
      await waitFor(() => providerEntered, 15000);
      assert.equal(JSON.stringify(providerArgs).includes('t6-u'), true, `${mode}: held provider request must be W0's second canonical batch (T6), args=${JSON.stringify(providerArgs).slice(0, 700)}`);
      const cancellation = await fixture.f.r.api.cancelCanonicalJob({});
      assert.equal(cancellation.ok, true, `${mode}: W0 canonical cancellation request: ${JSON.stringify(cancellation)}`);
      assert.equal(cancellation.cancelRequested, true, `${mode}: cancellation arrives before the held model response`);
      const cancelJobKey = `libra:v1:scope:${w0Before.manifest.scopeKey}:canonical-job:${cancellation.jobId}`;
      const jobBeforeRelease = findStoredKey(fixture, cancelJobKey);
      assert.equal(jobBeforeRelease?.value?.state, 'cancel_requested', `${mode}: W0 job is cancel_requested before provider release`);
      worlds.select(worlds.child);
      const w1DuringCancel = await fixture.f.control.hooks.beforeRequest([{ role: 'user', content: '은빛 열쇠의 현재 보관 장소는 어디인가?' }], 'model');
      const w1DuringCancelBlock = requestBlock(w1DuringCancel);
      assert.ok(w1DuringCancelBlock.includes(placements.W1.factText), `${mode}: W1 final model message while cancelled W0 provider call is pending`);
      assert.ok(!w1DuringCancelBlock.includes(placements.W0.factText), `${mode}: W1 final model message excludes W0 source fact`);
      releaseProvider();
      let cancelledRun;
      try { cancelledRun = await parentJobPromise; } finally { fixture.f.control.onCall = null; }
      const jobAfterRelease = findStoredKey(fixture, cancelJobKey);
      assert.equal(cancelledRun.state, 'cancelled', `${mode}: late W0 analysis remains cancelled: ${JSON.stringify(cancelledRun)}`);
      assert.equal(jobAfterRelease?.value?.state, 'cancelled', `${mode}: durable W0 job state is cancelled after late provider response`);
      assert.equal(jobAfterRelease?.value?.cancelRequested, true, `${mode}: W0 cancel flag survives provider release`);
      const w0AfterCancel = findBundleCanonical(storageBundle(fixture, worlds.w0.id));
      const w1AfterCancel = findBundleCanonical(storageBundle(fixture, worlds.child.id));
      assert.deepEqual(Object.keys(w0AfterCancel.manifest.memories || {}), ['1'], `${mode}: cancelled W0 response created no second canonical memory`);
      assert.deepEqual(parentByteSnapshot(w0AfterCancel), w0BytesBefore, `${mode}: W0 parent canonical/evidence/vector bytes survive cancellation`);
      assert.deepEqual(worldlineScopeSnapshot(w1AfterCancel), worldlineScopeSnapshot(w1Before), `${mode}: W1 canonical identity survives cancelled W0 response`);
      const w1AfterCancelOutput = await fixture.f.control.hooks.beforeRequest([{ role: 'user', content: '은빛 열쇠의 현재 보관 장소는 어디인가?' }], 'model');
      const w1AfterCancelBlock = requestBlock(w1AfterCancelOutput);
      assert.ok(w1AfterCancelBlock.includes(placements.W1.factText), `${mode}: post-cancellation W1 final injection remains its own fact`);
      assert.ok(!w1AfterCancelBlock.includes(placements.W0.factText), `${mode}: post-cancellation W1 final injection excludes W0 fact`);
      report.cancellation = {
        boundary: 'runLLMModel response held by a controllable Promise after W0 cancellation request',
        providerCallCount: fixture.f.control.calls.length,
        promptContainsW0Turn6: JSON.stringify(providerArgs).includes('t6-u'),
        cancellation, jobBeforeRelease: jobBeforeRelease.value.state,
        lateRunState: cancelledRun.state, durableJobState: jobAfterRelease.value.state,
        W0SecondCanonicalCreated: Object.keys(w0AfterCancel.manifest.memories || {}).includes('6'),
        W0ParentBytesUnchanged: true, W1CanonicalIdentityUnchanged: true,
        postCancelW1Fact: placements.W1.factText
      };

      const serverCalls = fixture.requests.filter(request => request.url.startsWith(fixture.url + '/'));
      const parentRows = Object.fromEntries(['server', 'local'].map(name => [
        name, [worlds.w0.id, worlds.child.id].map(chatId => canonical(fixture, chatId, name)).map(value => !!value)
      ]));
      report.stores = { serverCalls: serverCalls.length, parentAndChildCanonicalInServerAndLocal: parentRows };
      if (mode === 'plugin_only') {
        assert.equal(serverCalls.length, 0, 'plugin_only performs zero Librarian server calls');
        assert.ok(parentRows.local.every(Boolean), 'plugin_only canonical records live in local plugin storage');
      } else if (mode === 'mirror') {
        assert.ok(parentRows.server.every(Boolean) && parentRows.local.every(Boolean), 'mirror replicates both W0 and W1 canonical records');
        for (const chatId of [worlds.w0.id, worlds.child.id]) {
          assert.equal(canonical(fixture, chatId, 'server').memoryRow.raw, canonical(fixture, chatId, 'local').memoryRow.raw,
            `${mode}: mirrored canonical payload matches for ${chatId}`);
        }
      } else {
        assert.ok(parentRows.server.every(Boolean), 'server_only keeps both canonical records on the server');
        assert.deepEqual(parentRows.local, [false, false], 'server_only has no local canonical fallback');
      }
      reports[mode] = report;
    } finally {
      await fixture.cleanup();
    }
  }
  const semanticProjection = mode => ({
    worldline: reports[mode].worldline,
    W0: reports[mode].positive.W0,
    W1: reports[mode].positive.W1,
    afterLateFact: reports[mode].afterLate.freshW1Fact,
    afterCancelFact: reports[mode].cancellation.postCancelW1Fact
  });
  assert.deepEqual(semanticProjection('server_only'), semanticProjection('plugin_only'), 'server_only preserves the same worldline facts and injection meaning');
  console.log(JSON.stringify({ test: 'libra_worldline_async_isolation_current_modes', modes: reports, embeddingResponder: 'fixed synthetic 256D', host: 'synthetic RisuAI fixture; registered beforeRequest callback' }, null, 2));
  console.log('libra_worldline_async_isolation_current_modes_test: PASS');
})().catch(error => {
  console.error(error?.stack || error);
  console.log('libra_worldline_async_isolation_current_modes_test: FAIL');
  process.exitCode = 1;
});
