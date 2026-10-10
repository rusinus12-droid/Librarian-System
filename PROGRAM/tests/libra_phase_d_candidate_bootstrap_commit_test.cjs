'use strict';

// A cold start with both transcript batches already present keeps the branch
// guard pending while it commits T1. That exact source-verified commit must be
// eligible as T6's candidate without promoting other bootstrap refs.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const exposeStorageBridge = source => {
  const anchor = '  const RisuCompat = (() => {';
  assert.ok(source.includes(anchor), 'storage bridge injection anchor must exist');
  return source.replace(anchor, '  globalThis.__phaseDStorageBridge = MemorySuiteStorageBridge;\n' + anchor);
};

const pairs = [
  ['민아는 지호에게 은빛 열쇠를 건넸다.', '지호는 오늘 열쇠 반환 약속을 했다.'],
  ['두 사람은 도서관에서 대화를 나눴다.', '대화가 끝났다.'],
  ['민아는 서재에 남았다.', '지호는 열쇠를 가지고 떠났다.'],
  ['준호는 공연실에 있었다.', '준호는 약속 내용에 관여하지 않았다.'],
  ['도서관은 문을 닫았다.', '아직 열쇠 반환은 확인되지 않았다.'],
  ['민아는 공연실에 들어갔다.', '민아는 준호에게 인사했다.'],
  ['지호는 서재에 왔다.', '지호는 민아를 찾았다.'],
  ['민아는 도서관을 나갔다.', '지호는 계속 기다렸다.'],
  ['준호는 열쇠를 보지 못했다.', '준호는 약속을 알지 못했다.'],
  ['지호가 은빛 열쇠를 민아에게 돌려주었다.', '오늘 열쇠 반환 다짐이 이행되었다.']
];
const rows = pairs.flatMap((pair, index) => [
  { turn: index + 1, role: 'user', text: pair[0] },
  { turn: index + 1, role: 'assistant', text: pair[1] }
]);
const chat = { id: 'bootstrap-verified-commit', chatId: 'bootstrap-verified-commit', name: 'Bootstrap verified commit',
  message: rows.map(row => ({ role: row.role, chatId: `t${row.turn}-${row.role === 'user' ? 'u' : 'a'}`, data: row.text })) };
const quote = (turn, role) => {
  const row = rows.find(item => item.turn === turn && item.role === role);
  return { ref: `t${turn}-${role === 'user' ? 'u' : 'a'}`, quote: row.text };
};
const artifact = ({ turn, summary, entityName = summary, status, link = '', resolution = '', alias = '', injectRuntimeFields = false }) => ({
  schema: 'libra.canonical_artifact.v5',
  entities: [
    { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: [quote(turn, 'user')] },
    { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', evidenceSpans: [quote(turn, 'user')] },
    { tempId: 'thread', name: entityName, type: 'world', kind: 'thread', evidenceSpans: [quote(turn, 'assistant')] }
  ],
  facts: [{
    tempFactId: `thread_${turn}`, domain: 'narrative', subjectTempRef: 'thread', claimKind: 'thread',
    values: { thread: { summary, status, kind: 'promise', participants: [
      { role: 'owner', personTempRef: 'jiho' }, { role: 'target', personTempRef: 'mina' }
    ], ...(link ? { link } : {}), ...(resolution ? { resolution } : {}), ...(alias ? { linkCandidateAlias: alias } : {}),
    ...(injectRuntimeFields ? { participantIds: [{ role: 'owner', personId: 'provider-id' }], lifecycleId: 'provider-id', linkStatus: 'accepted' } : {}) } },
    text: summary, temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: [quote(turn, 'assistant')]
  }]
});
const promptCandidates = call => {
  const user = call?.messages?.find(row => row.role === 'user')?.content || '';
  const match = user.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
  return match ? JSON.parse(match[1]) : [];
};

const runMode = async mode => {
  const server = await serverFixture({ mode, snapshot: { chat }, transformSource: exposeStorageBridge });
  const f = server.f;
  try {
    const bridge = f.r.context.__phaseDStorageBridge;
    assert.ok(bridge, `${mode}: production storage bridge is exposed to the test`);
    const scopeKey = (await f.r.api.getHostLineageStatus()).scopeKey;
    const scope = { scopeId: scopeKey, scopeKey, characterId: f.character.id, chatId: f.chat.id,
      aliases: [scopeKey, f.chat.id], label: f.chat.id };
    // A mirror fixture represents a persisted pre-retirement setting, not a new selection.
    if (mode !== 'mirror') await bridge.setScopeMode(scope, mode);
    const actualMode = await bridge.getScopeMode(scope);
    assert.equal(actualMode.mode, mode, `${mode}: scope routing confirms the requested storage mode`);
    const localManifest = () => {
      for (const [key, raw] of server.local.entries()) {
        if (!String(key).endsWith(':manifest')) continue;
        try { return JSON.parse(raw); } catch {}
      }
      return null;
    };
    const activeManifest = () => mode === 'server_only' ? server.getManifest() : localManifest();
    const activeMemory = start => {
      const manifest = activeManifest(), ref = manifest?.memories?.[String(start)];
      if (!ref) return null;
      if (mode !== 'server_only') {
        try { return JSON.parse(server.local.get(ref.key)); } catch { return null; }
      }
      return server.getMemory(start);
    };
    const localRecord = schema => {
      for (const [key, raw] of server.local.entries()) {
        try { const value=JSON.parse(raw); if(value?.schema===schema)return {key,value}; } catch {}
      }
      return null;
    };
    const activeHead = () => mode === 'server_only' ? server.getHead() : localRecord('libra.continuity_state.v2')?.value || null;
    const seen = [];
    let guardAtSecondDispatch = null;
    let guardVerifiedStartsAtSecondDispatch = [];
    f.control.onCall = args => {
      const index = f.control.calls.length - 1;
      const candidates = promptCandidates(args[0]);
      seen.push(candidates);
      if (index === 1) {
        guardAtSecondDispatch = activeManifest()?.branchGuard || null;
        guardVerifiedStartsAtSecondDispatch = [...(guardAtSecondDispatch?.verifiedStarts || [])];
      }
      const response = index === 0
        ? artifact({ turn: 1, summary: '오늘 열쇠 반환 약속', status: 'open', injectRuntimeFields: true })
        : artifact({ turn: 10, summary: '은빛 열쇠를 민아에게 돌려준 약속의 이행', entityName: '오늘 열쇠 반환 다짐',
          status: 'resolved', link: 'resolve', resolution: 'fulfilled', alias: candidates[0]?.alias });
      return { type: 'success', result: JSON.stringify(response) };
    };

    const result = await f.run();
    assert.equal(result.completed, 2, JSON.stringify(result));
    assert.equal(countCalls(f.control).canonical,2);
    assert.equal(seen[0].length, 0);
    assert.equal(seen[1].length, 1, 'the exact T1 commit is offered to the later T6 analysis');
    const durableManifest = server.getManifest();
    const first = activeMemory(1), second = activeMemory(6);
    assert.ok(first && second, `${mode}: committed memories are readable from the active backend (${JSON.stringify({keys:Object.keys(durableManifest?.memories||{}),serverRows:server.storedRows().map(row=>({key:row.key,schema:row.value?.schema})),localKeys:[...server.local.keys()].filter(key=>key.endsWith(':manifest')),calls:seen.map(rows=>rows.length),job:result})})`);
    if (mode === 'server_only') {
      assert.equal(localManifest(), null, 'server_only keeps the canonical manifest off the plugin-local store');
    } else {
      if (mode === 'plugin_only') assert.equal(durableManifest, undefined, 'plugin_only writes no canonical manifest to server');
    }
    const prior = first.canonicalArtifact.facts[0].values.thread;
    const successor = second.canonicalArtifact.facts[0].values.thread;
    assert.equal(prior.linkStatus, 'new');
    assert.equal(successor.linkStatus, 'accepted', 'the candidate alias is sealed after source-authorized selection');
    assert.equal(successor.lifecycleId, prior.lifecycleId);
    assert.equal(successor.linkTarget.factId, 'thread_1');
    assert.equal(successor.resolution, 'fulfilled');
    assert.equal(Object.hasOwn(successor, 'linkCandidateAlias'), false);
    assert.equal(guardAtSecondDispatch?.status, 'bootstrap_pending', `${mode}: natural cold-start state remains under bootstrap verification at T6`);
    assert.ok(guardVerifiedStartsAtSecondDispatch.includes(1), `${mode}: only the just-committed T1 source-verified start is enabled at T6`);
    const head = activeHead();
    assert.ok(head && Number(head.throughTurn) >= 10, `${mode}: State readback includes the T6 batch`);
    const history = await f.r.api.getWorldManagerHistoryDetail({ memoryId: second.memoryId, revision: second.revision });
    assert.equal(history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.linkStatus, 'accepted',
      `${mode}: public History preserves the accepted lifecycle result`);
    assert.equal(history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution, 'fulfilled');
    const historyEvents = history.semanticTimeline?.events?.filter(event => event.threadLifecycleId === prior.lifecycleId) || [];
    assert.equal(JSON.stringify(historyEvents.map(event => event.type)), JSON.stringify(['created', 'resolved']),
      `${mode}: History records the same lifecycle transition`);
    assert.equal(head.narrative?.threads?.some(thread => thread.summary === '오늘 열쇠 반환 약속'), false,
      `${mode}: State no longer exposes the fulfilled promise as open`);
    if (mode === 'mirror') {
      const serverHead = server.getHead();
      assert.equal(serverHead?.throughTurn, head.throughTurn, 'mirror durable State matches the plugin-local State');
    }
    return { mode, completed: result.completed,
      candidatesByBatch: seen.map(rows => rows.length), lifecycleStatus: [prior.linkStatus, successor.linkStatus],
      resolution: successor.resolution, guardStatusAtSecondDispatch: guardAtSecondDispatch?.status || null,
      verifiedStartsAtSecondDispatch: guardVerifiedStartsAtSecondDispatch,
      stateThroughTurn: head.throughTurn, historyLinkStatus: history.provenance.domains.narrative.canonicalAssertions[0].values.thread.linkStatus,
      semanticHistory: historyEvents.map(event => event.type),
      boundary: 'same cold-start scan, local controlled provider, exact source-verified commit only' };
  } finally {
    await server.cleanup();
  }
};

(async () => {
  const results = [];
  for (const mode of ['plugin_only', 'mirror', 'server_only']) results.push(await runMode(mode));
  for (const row of results) {
    assert.equal(row.completed, 2, `${row.mode}: both batches commit`);
    assert.deepEqual(row.candidatesByBatch, [0, 1], `${row.mode}: T6 receives exactly the newly verified T1 alias`);
    assert.deepEqual(row.lifecycleStatus, ['new', 'accepted'], `${row.mode}: accepted lifecycle follows the same chain`);
    assert.equal(row.resolution, 'fulfilled');
    assert.ok(Number(row.stateThroughTurn) >= 10, `${row.mode}: State includes the second batch`);
    assert.equal(row.historyLinkStatus, 'accepted', `${row.mode}: History includes the accepted relation`);
    assert.equal(JSON.stringify(row.semanticHistory), JSON.stringify(['created', 'resolved']));
    assert.ok(row.verifiedStartsAtSecondDispatch.includes(1), `${row.mode}: T1 gains targeted bootstrap eligibility before T6`);
  }
  console.log(JSON.stringify({ test: 'libra_phase_d_candidate_bootstrap_commit', passedModes: results.map(row => row.mode), results }));
})().catch(error => { console.error(error); process.exitCode = 1; });
