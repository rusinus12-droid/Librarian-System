'use strict';

// A13: four independent source-backed branches of one promise, exercised through
// the deployed canonical pipeline in each storage mode. History is read back via
// the public API and passed to the shipped production detail renderer.
const assert = require('node:assert/strict');
const {actualClassicPacket,deliveredClosureRows,assertNoForbiddenClosure}=require('./fixtures/libra_actual_classic_request.cjs');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
const { cases } = require('./fixtures/acceptance_scenarios.json');

const ACTION = cases.find(row => row.id === 'A13').action;
const MODES = ['plugin_only', 'mirror', 'server_only'];
const TITLE = '10월 1일 푸른 편지 전달 약속';
const OUTCOMES = [
  { id: 'fulfilled', resolution: 'fulfilled', status: 'resolved', link: 'resolve',
    source: '지호는 10월 1일 푸른 편지 전달 약속대로 편지를 민아에게 전달했다. 민아는 편지를 받았다고 확인했다.' },
  { id: 'broken', resolution: 'broken', status: 'resolved', link: 'resolve',
    source: '지호는 10월 1일 푸른 편지 전달 약속을 지키지 못해 민아에게 편지를 전달하지 않았고 약속을 어겼다.' },
  { id: 'cancelled', resolution: 'cancelled', status: 'closed', link: 'resolve',
    source: '지호와 민아는 10월 1일 푸른 편지 전달 약속에 서로 동의해 취소했다.' },
  { id: 'obstacle', resolution: '', status: 'blocked', link: 'reaffirm',
    source: '폭우 때문에 지호는 10월 1일 푸른 편지 전달 약속의 편지를 오늘 민아에게 전달하지 못했다. 약속은 아직 남아 있다.' }
];
const clone = value => JSON.parse(JSON.stringify(value));
const turns = [
  { turn: 1, user: '지호는 민아에게 10월 1일 푸른 편지 전달 약속을 했다.', assistant: '민아는 약속을 기억했다.' },
  { turn: 2, user: '두 사람은 편지를 준비하기로 했다.', assistant: '약속한 날은 10월 1일이었다.' },
  { turn: 3, user: '지호는 봉투를 준비했다.', assistant: '민아는 전달을 기다렸다.' },
  { turn: 4, user: '두 사람은 약속을 바꾸지 않았다.', assistant: '편지는 아직 전달되지 않았다.' },
  { turn: 5, user: '약속은 계속 열려 있었다.', assistant: '그날 대화가 끝났다.' },
  ...OUTCOMES.map(outcome => ({ turn: 6, user: outcome.source, assistant: '이 기록은 해당 약속의 현재 결과를 남긴다.' })),
  { turn: 7, user: '두 사람은 기록을 정리했다.', assistant: '대화는 차분하게 이어졌다.' },
  { turn: 8, user: '민아는 서재로 이동했다.', assistant: '지호는 도서관에 남았다.' },
  { turn: 9, user: '주변은 조용했다.', assistant: '새로운 약속은 기록되지 않았다.' },
  { turn: 10, user: '그날 기록이 마무리되었다.', assistant: '대화가 끝났다.' }
];
const outcomeById = new Map(OUTCOMES.map(row => [row.id, row]));
const rowsForTurns = selected => selected.flatMap(row => [
  { role: 'user', chatId: `t${row.turn}-u`, data: row.user },
  { role: 'assistant', chatId: `t${row.turn}-a`, data: row.assistant }
]);
const makeChat = selected => ({ id: 'unified-chat', chatId: 'unified-chat', name: 'A13 four outcomes', message: rowsForTurns(selected) });
const quote = (turn, role = 'user', source = null) => {
  const row = source || turns.find(item => item.turn === turn);
  assert.ok(row, `source turn ${turn} exists`);
  return { ref: `t${turn}-${role === 'assistant' ? 'a' : 'u'}`, quote: row[role] };
};
const sourceBatch = selected => selected.map(row => ({ turn: row.turn, user: { text: row.user }, assistant: { text: row.assistant } }));
const sourceRows = selected => new Map(selected.flatMap(row => [
  [`t${row.turn}-u`, row.user], [`t${row.turn}-a`, row.assistant]
]));
const candidatesFromCall = args => {
  const user = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '';
  const match = user.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
  return match ? JSON.parse(match[1]) : [];
};
const candidateForPromise = rows => rows.find(row => row.summary === TITLE
  && JSON.stringify(row.participants) === JSON.stringify([
    { role: 'owner', name: '지호' }, { role: 'target', name: '민아' }
  ]));

const openingArtifact = () => ({
  schema: 'libra.canonical_artifact.v5',
  entities: [
    { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', evidenceSpans: [quote(1)] },
    { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: [quote(1)] },
    { tempId: 'promise', name: '10월 1일 푸른 편지 전달 약속', type: 'world', kind: 'thread', evidenceSpans: [quote(1)] }
  ],
  facts: [{
    tempFactId: 'promise_open', domain: 'narrative', subjectTempRef: 'promise', claimKind: 'thread',
    values: { thread: { summary: TITLE, status: 'open', kind: 'promise', participants: [
      { role: 'owner', personTempRef: 'jiho' }, { role: 'target', personTempRef: 'mina' }
    ] } },
    text: turns[0].user, temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: [quote(1)]
  }]
});

const outcomeArtifact = (outcome, alias) => {
  const row = outcomeById.get(outcome.id);
  const sourceTurn = { turn: 6, user: row.source, assistant: '이 기록은 해당 약속의 현재 결과를 남긴다.' };
  return {
    schema: 'libra.canonical_artifact.v5',
    entities: [
      { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', evidenceSpans: [quote(6, 'user', sourceTurn)] },
      { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: [quote(6, 'user', sourceTurn)] },
      { tempId: 'promise_outcome', name: '10월 1일 푸른 편지 전달 약속', type: 'world', kind: 'thread', evidenceSpans: [quote(6, 'user', sourceTurn)] }
    ],
    facts: [{
      tempFactId: `promise_${outcome.id}`, domain: 'narrative', subjectTempRef: 'promise_outcome', claimKind: 'thread',
      values: { thread: {
        summary: TITLE, status: row.status, kind: 'promise', link: row.link,
        participants: [ { role: 'owner', personTempRef: 'jiho' }, { role: 'target', personTempRef: 'mina' } ],
        ...(row.resolution ? { resolution: row.resolution } : {}),
        interpretation: row.source,
        linkCandidateAlias: alias
      } },
      text: row.source, temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: [quote(6, 'user', sourceTurn)]
    }]
  };
};

const parseJson = raw => {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
};
const rowsAcrossStores = server => {
  const local = [...server.local.entries()].map(([key, raw]) => ({ key, raw, value: parseJson(raw), source: 'plugin' }));
  const remote = server.storedRows().map(row => ({ key: row.key, raw: row.raw, value: row.value, source: 'server' }));
  return [...local, ...remote];
};
const fieldDiffs = (left, right, pathName = '') => {
  if (Object.is(left, right)) return [];
  const leftArray = Array.isArray(left), rightArray = Array.isArray(right);
  if (leftArray && rightArray) {
    const diffs = [];
    if (left.length !== right.length) diffs.push({ path: `${pathName}.$length`, plugin: left.length, server: right.length });
    for (let index = 0; index < Math.min(left.length, right.length); index += 1)
      diffs.push(...fieldDiffs(left[index], right[index], `${pathName}[${index}]`));
    return diffs;
  }
  const leftObject = left !== null && typeof left === 'object' && !leftArray;
  const rightObject = right !== null && typeof right === 'object' && !rightArray;
  if (leftObject && rightObject) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap(key => {
      const child = pathName ? `${pathName}.${key}` : key;
      const l = Object.hasOwn(left, key), r = Object.hasOwn(right, key);
      if (!l || !r) return [{ path: child, pluginPresent: l, serverPresent: r, ...(l ? { plugin: left[key] } : {}), ...(r ? { server: right[key] } : {}) }];
      return fieldDiffs(left[key], right[key], child);
    });
  }
  return [{ path: pathName || '$', plugin: left, server: right }];
};
const AUDIT_TIME_PATHS = new Set(['updatedAt', 'branchGuard.lastFullAuditAt', 'branchGuard.updatedAt']);
const manifestIdentity = value => ({ schema: value.schema, scopeKey: value.scopeKey, characterId: value.characterId, chatId: value.chatId,
  memories: value.memories, inheritedMemories: value.inheritedMemories, worldlineMeta: value.worldlineMeta });
const manifestForChat = (server, chatId, mode) => {
  const matches = rowsAcrossStores(server).filter(row => row.key.endsWith(':manifest')
    && row.value?.schema === 'libra.manifest.v1' && row.value.chatId === chatId);
  assert.ok(matches.length, `${mode} ${chatId} canonical manifest is readable`);
  if (matches.length > 1) {
    assert.equal(new Set(matches.map(row => row.key)).size, 1, 'mirror reads the same manifest key');
    const plugin = matches.find(row => row.source === 'plugin')?.value;
    const remote = matches.find(row => row.source === 'server')?.value;
    assert.ok(plugin && remote, 'mirror readback contains both manifest rows');
    const differences = fieldDiffs(plugin, remote);
    const unexpected = differences.filter(row => !AUDIT_TIME_PATHS.has(row.path));
    console.log(JSON.stringify({ schema: 'a13.mirror_manifest_field_diff.v1', chatId, key: matches[0].key,
      differences, allowedAuditTimePaths: differences.filter(row => AUDIT_TIME_PATHS.has(row.path)).map(row => row.path),
      unexpectedDifferences: unexpected.map(row => row.path), canonicalRefs: Object.entries(plugin.memories || {}).map(([start, ref]) => ({ start, ...ref })),
      rawByteEqual: matches.every(row => row.raw === matches[0].raw) }));
    assert.deepEqual(unexpected, [], `mirror parsed manifest differs outside approved audit timestamps: ${JSON.stringify(unexpected)}`);
    assert.deepEqual(manifestIdentity(plugin), manifestIdentity(remote), 'mirror manifest identity, refs and digests agree');
    assert.equal(typeof plugin.updatedAt, 'string');
    assert.equal(typeof remote.updatedAt, 'string');
    assert.equal(typeof plugin.branchGuard?.lastFullAuditAt, 'number');
    assert.equal(typeof remote.branchGuard?.lastFullAuditAt, 'number');
    assert.equal(typeof plugin.branchGuard?.updatedAt, 'string');
    assert.equal(typeof remote.branchGuard?.updatedAt, 'string');
  }
  return matches[0].value;
};
const rawForKey = (server, key, mode) => {
  const matches = rowsAcrossStores(server).filter(row => row.key === key);
  assert.ok(matches.length, `${mode} canonical bytes for ${key} are readable`);
  assert.ok(matches.every(row => typeof row.raw === 'string'), 'stored raw is text bytes');
  const byteEqual = matches.length < 2 || matches.every(row => row.raw === matches[0].raw);
  console.log(JSON.stringify({ schema: 'a13.canonical_raw_readback.v1', mode, key, sources: matches.map(row => row.source),
    byteEqualAcrossStores: byteEqual, rawByteLength: Buffer.byteLength(matches[0].raw, 'utf8'),
    rawSha256: crypto.createHash('sha256').update(matches[0].raw, 'utf8').digest('hex') }));
  if (matches.length > 1) assert.equal(byteEqual, true, `${mode} mirrored canonical raw bytes agree for ${key}`);
  return matches[0].raw;
};
const memoryForChat = (server, chatId, start, mode) => {
  const manifest = manifestForChat(server, chatId, mode);
  const ref = manifest.memories?.[String(start)];
  assert.ok(ref?.key && ref.memoryId && ref.sourceDigest && ref.artifactDigest, `${mode} manifest has canonical ref/digests at T${start}`);
  const raw = rawForKey(server, ref.key, mode);
  const memory = parseJson(raw);
  assert.equal(memory?.memoryId, ref.memoryId, 'canonical memory id agrees with manifest ref');
  assert.equal(memory?.sourceDigest, ref.sourceDigest, 'canonical source digest agrees with manifest ref');
  assert.equal(memory?.artifactDigest, ref.artifactDigest, 'canonical artifact digest agrees with manifest ref');
  return { memory, ref, raw };
};
const publicThreads = async api => {
  const replay = await api.rebuildWorldManagerState();
  assert.equal(replay.ok, true, JSON.stringify({ code: replay.code, error: replay.error }));
  assert.ok(replay.head?.narrative, 'public State exposes the canonical narrative Head');
  return Array.isArray(replay.head.narrative.threads) ? replay.head.narrative.threads : [];
};
const packetRows = packet => Object.values(packet?.evidencePacket?.layers || {}).flatMap(rows => Array.isArray(rows) ? rows : []);

const pluginSource = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const between = (a, b) => {
  const start = pluginSource.indexOf(a), end = pluginSource.indexOf(b, start);
  assert.ok(start >= 0 && end > start, `production GUI source anchors exist: ${a} .. ${b}`);
  return pluginSource.slice(start, end);
};
const el = (tag, attrs = {}, children = []) => ({ tag, ...attrs, children: children.filter(Boolean) });
const flat = node => [node, ...(node.children || []).flatMap(flat)];
const textOf = node => flat(node).map(item => String(item.text ?? '')).join(' ');
const byData = (node, attr) => flat(node).filter(item => item.dataset && item.dataset[attr] !== undefined);
const guiContext = () => {
  const ctx = vm.createContext({
    guiEl: el,
    guiAsArray: value => Array.isArray(value) ? value : [],
    guiAsObject: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    guiLazyDetails: (attrs, summary, render) => el('details', attrs, [summary, ...render()]),
    text: value => String(value ?? '').trim(), String, Number, JSON
  });
  vm.runInContext(`${between('const worldManagerHistoryStatusCopy =', 'const worldManagerHistoryAuthorityCopy =')}
    ${between('const worldManagerHistoryAuthorityCopy =', 'const worldManagerHistoryStateDomain =')}
    ${between('const worldManagerHistoryStateDomain =', 'const buildWorldManagerHistoryDetailView =')}
    ${between('const buildWorldManagerHistoryDetailView =', 'const worldManagerHeadContainsCorrection =')}
    Object.assign(globalThis, { buildWorldManagerHistoryDetailView });`, ctx);
  return ctx;
};
const renderedOutcomeText = new Map([
  ...OUTCOMES.map(outcome => [outcome.id, outcome.source])
]);
const renderedOutcomeReason = new Map([
  ['fulfilled', '종결 사유 · 약속 이행'], ['broken', '종결 사유 · 약속 파기'], ['cancelled', '종결 사유 · 합의 취소'],
  ['obstacle', '현재 상태 · 장애로 막힘 · 미종결']
]);

const observations = [];
const failures = [];
const recordCheck = (label, fn) => {
  try { fn(); return true; }
  catch (error) { failures.push({ label, message: String(error?.message || error) }); return false; }
};

const runBranch = async (mode, outcome) => {
  const openingTurns = turns.slice(0, 5);
  const branchTurns = [...openingTurns,
    { turn: 6, user: outcome.source, assistant: '이 기록은 해당 약속의 현재 결과를 남긴다.' },
    ...turns.filter(row => row.turn >= 7)];
  const server = await serverFixture({ mode, snapshot: { chat: makeChat(openingTurns) } });
  try {
    const { f } = server;
    const opening = openingArtifact();
    const openingAdmission = f.r.api.debugPrepareUnifiedMemoryArtifact(opening, sourceBatch(openingTurns));
    recordCheck(`${mode}/${outcome.id} opening evidence admission`, () => {
      assert.equal(openingAdmission.admission?.status, 'complete', JSON.stringify(openingAdmission.admission));
      assert.equal(openingAdmission.admission?.rejected?.length, 0);
      assert.equal(openingAdmission.admission?.droppedFields?.length, 0);
      assert.equal(openingAdmission.artifact?.facts?.filter(row => row.claimKind === 'thread').length, 1);
    });
    console.log(JSON.stringify({ schema: 'a13.source_evidence_admission.v1', mode, branch: outcome.id, phase: 'opening',
      status: openingAdmission.admission?.status || '', admittedThreads: openingAdmission.artifact?.facts?.filter(row => row.claimKind === 'thread').length || 0,
      rejected: openingAdmission.admission?.rejected || [], droppedEvidence: openingAdmission.admission?.droppedFields || [] }));

    let candidateRows = [];
    let outcomeAdmission = null;
    f.control.onCall = args => {
      const calls = f.control.calls.length;
      const candidates = candidatesFromCall(args);
      if (calls === 1) {
        assert.equal(candidates.length, 0, 'new branch does not receive fabricated prior candidates');
        return { type: 'success', result: JSON.stringify(opening) };
      }
      assert.equal(calls, 2, 'one later source batch is analyzed');
      candidateRows = candidates;
      const target = candidateForPromise(candidates);
      assert.ok(target?.alias, 'request-local candidate alias identifies the original promise');
      const artifact = outcomeArtifact(outcome, target.alias);
      const nextTurns = branchTurns.filter(row => row.turn >= 6);
      outcomeAdmission = f.r.api.debugPrepareUnifiedMemoryArtifact(artifact, sourceBatch(nextTurns));
      console.log(JSON.stringify({ schema: 'a13.source_evidence_admission.v1', mode, branch: outcome.id, phase: 'outcome',
        status: outcomeAdmission.admission?.status || '', admittedThreads: outcomeAdmission.artifact?.facts?.filter(row => row.claimKind === 'thread').length || 0,
        rejected: outcomeAdmission.admission?.rejected || [], droppedEvidence: outcomeAdmission.admission?.droppedFields || [] }));
      return { type: 'success', result: JSON.stringify(artifact) };
    };
    const firstRun = await f.r.api.runManualColdStart();
    recordCheck(`${mode}/${outcome.id} opening action`, () => {
      assert.equal(firstRun.completed, 1, JSON.stringify(firstRun));
      assert.equal(countCalls(f.control).canonical,1);
    });
    f.chat.message.push(...rowsForTurns(branchTurns.filter(row => row.turn >= 6)));
    f.chat.messages = f.chat.message;
    const outcomeRun = await f.r.api.runManualColdStart();
    recordCheck(`${mode}/${outcome.id} outcome action`, () => {
      assert.equal(outcomeRun.completed, 1, JSON.stringify(outcomeRun));
      assert.equal(countCalls(f.control).canonical,2);
      assert.equal(candidateRows.length, 1, 'the branch presents the same source-backed promise as one candidate');
      assert.equal(outcomeAdmission.admission?.status, 'complete', JSON.stringify(outcomeAdmission.admission));
      assert.equal(outcomeAdmission.admission?.rejected?.length, 0);
      assert.equal(outcomeAdmission.admission?.droppedFields?.length, 0);
    });

    const initialRead = memoryForChat(server, 'unified-chat', 1, mode);
    const outcomeRead = memoryForChat(server, 'unified-chat', 6, mode);
    const initialFact = initialRead.memory.canonicalArtifact.facts.find(row => row.tempFactId === 'promise_open');
    const finalFact = outcomeRead.memory.canonicalArtifact.facts.find(row => row.tempFactId === `promise_${outcome.id}`);
    const beforeThread = initialFact?.values?.thread;
    const finalThread = finalFact?.values?.thread;
    const expected = outcomeById.get(outcome.id);
    recordCheck(`${mode}/${outcome.id} canonical identity/reason`, () => {
      assert.ok(beforeThread?.lifecycleId, 'opening canonical promise has a durable lifecycle id');
      assert.equal(finalThread?.lifecycleId, beforeThread.lifecycleId, 'outcome targets the original lifecycle');
      assert.equal(finalThread?.linkStatus, 'accepted', 'outcome link is accepted by the real canonical pipeline');
      assert.equal(finalThread?.link, expected.link);
      assert.equal(finalThread?.status, expected.status);
      assert.equal(finalThread?.resolution || '', expected.resolution, 'canonical resolution distinguishes all three terminal reasons');
      assert.equal(finalThread?.linkTarget?.factId, 'promise_open');
      assert.equal(finalFact?.evidenceSpans?.[0]?.ref, 't6-u');
      assert.equal(finalFact?.evidenceSpans?.[0]?.quote, expected.source);
      assert.ok(!Object.hasOwn(finalThread || {}, 'linkCandidateAlias'), 'request-local alias is not retained in canonical memory');
    });

    const currentThreads = await publicThreads(f.r.api);
    const current = currentThreads.find(row => row.lifecycleId === beforeThread?.lifecycleId);
    recordCheck(`${mode}/${outcome.id} public State`, () => {
      if (outcome.id === 'obstacle') {
        assert.ok(current, 'obstacle branch leaves its obligation in current Head');
        assert.ok(['open', 'blocked'].includes(current.status), `obstacle remains open/blocked, got ${current.status}`);
      } else assert.equal(current, undefined, `${outcome.id} leaves no open obligation in current Head`);
    });

    const history = await f.r.api.getWorldManagerHistoryDetail({ memoryId: outcomeRead.ref.memoryId, revision: outcomeRead.ref.revision });
    const timelineEvents = history.semanticTimeline?.events || [];
    const lifecycleEvents = timelineEvents.filter(event => event.threadLifecycleId === beforeThread?.lifecycleId);
    const finalEvent = lifecycleEvents.find(event => event.evidenceSpans?.some(span => span.ref === 't6-u'));
    const expectedEventType = outcome.id === 'obstacle' ? 'reaffirmed' : 'resolved';
    recordCheck(`${mode}/${outcome.id} public History`, () => {
      assert.equal(history.recordMode, 'state_pipeline_v3');
      assert.equal(history.canonicalMemory?.memoryId, outcomeRead.ref.memoryId);
      assert.ok(finalEvent, 'History contains the source-backed outcome transition');
      assert.equal(finalEvent.type, expectedEventType);
      assert.equal(finalEvent.evidenceSpans?.[0]?.quote, expected.source);
      assert.equal(Number(finalEvent.canonicalCursor?.turnRange?.start || 0), 6, 'History retains the outcome evidence time');
      assert.equal(finalEvent.item?.status, expected.status);
      assert.equal(finalEvent.item?.resolution || '', expected.resolution);
    });

    const settings = await f.r.api.getLibraMemorySettings();
    await f.r.api.saveLibraMemorySettings({ ...(settings?.settings || settings || {}), recallMaxMemories: 4 });
    const query = expected.source;
    const recall = await f.r.api.previewUnifiedMemoryRecall(query);
    const recallFacts = recall.diagnostics?.recallContinuityClosure?.facts || [];
    const recallSelectedRows = Array.isArray(recall.memories) ? recall.memories : [];
    // Unified Recall selects individual canonical assertion units (one row per fact) rather than
    // whole canonical records, so the exact outcome fact is the selected unit of the T6 record
    // whose text is the outcome assertion.
    const outcomeUnits = recallSelectedRows.filter(row => row?.memory?.memoryId === outcomeRead.ref.memoryId
      && Number(row?.memory?.revision || 0) === Number(outcomeRead.ref.revision || 0));
    const selectedOutcomeRow = outcomeUnits.find(row => row?.memory?.semanticRole === 'canonical_assertion'
      && (row?.memory?.text === expected.source || row?.excerpt === expected.source)) || outcomeUnits[0] || null;
    const selectedOutcomeFact = selectedOutcomeRow && (selectedOutcomeRow.memory?.text === expected.source
      || selectedOutcomeRow.excerpt === expected.source) ? selectedOutcomeRow.memory : null;
    const closureOutcome = recallFacts.find(row => row.memoryId === outcomeRead.ref.memoryId
      && Number(row.revision || 0) === Number(outcomeRead.ref.revision || 0));
    const recallReachedOutcome = Boolean(selectedOutcomeRow || closureOutcome);
    const selectedRecallRefs = recallSelectedRows.map(row => ({
      memoryId: row?.memory?.memoryId || '', revision: Number(row?.memory?.revision || 0),
      turnRange: row?.memory?.turnRange || null, semanticRole: row?.memory?.semanticRole || '', text: row?.memory?.text || ''
    }));
    const closureRecallRefs = recallFacts.map(row => ({ memoryId: row.memoryId || '', revision: Number(row.revision || 0),
      turnRange: row.turnRange || null, claimKind: row.claimKind || '', text: row.text || '' }));
    console.log(JSON.stringify({ schema: 'a13.recall_selected_and_closure.v1', mode, branch: outcome.id,
      selectedRefs: selectedRecallRefs, selectedOutcomeFact: selectedOutcomeFact ? {
        nodeId: selectedOutcomeFact.nodeId, text: selectedOutcomeFact.text, turnRange: selectedOutcomeFact.turnRange || null
      } : null, closureRefs: closureRecallRefs, reachedOutcome: recallReachedOutcome,
      canonicalOutcome: { memoryId: outcomeRead.ref.memoryId, revision: outcomeRead.ref.revision,
        turnRange: outcomeRead.ref.turnRange, status: finalThread?.status || '', resolution: finalThread?.resolution || '',
        evidenceSpans: finalFact?.evidenceSpans || [] } }));
    recordCheck(`${mode}/${outcome.id} current Recall`, () => {
      assert.ok(recall.memories?.length > 0, 'public Recall returns source evidence');
      assert.ok(recallReachedOutcome, 'public Recall either selects the T6 canonical row or reports it as a closure addition');
      if (selectedOutcomeRow) assert.ok(selectedOutcomeFact, 'direct T6 selection exposes the exact outcome fact');
      if (selectedOutcomeFact) {
        // The unit carries the assertion text and its record's time; status, resolution and the
        // evidence ref are asserted on the durable T6 canonical fact below.
        assert.equal(selectedOutcomeFact.text, expected.source);
        assert.equal(selectedOutcomeFact.memoryKey, outcomeRead.ref.key, 'the selected unit is bound to the T6 canonical record');
        assert.ok(Number(selectedOutcomeFact.turnRange?.start || 0) <= 6 && Number(selectedOutcomeFact.turnRange?.end || 0) >= 6,
          'the selected outcome unit retains the T6 source time');
      }
      assert.equal(finalThread?.status, expected.status, 'reached T6 canonical fact retains its exact promise status');
      assert.equal(finalThread?.resolution || '', expected.resolution, 'reached T6 canonical fact retains its exact resolution');
      assert.equal(finalFact?.text, expected.source, 'reached T6 canonical fact retains its source text');
      assert.equal(finalFact?.evidenceSpans?.[0]?.ref, 't6-u', 'reached T6 canonical fact retains its evidence ref');
      assert.ok(Number(outcomeRead.ref.turnRange?.start || 0) <= 6 && Number(outcomeRead.ref.turnRange?.end || 0) >= 6,
        'reached T6 canonical fact retains its source time');
      if (outcome.id === 'obstacle') {
        assert.equal(finalThread?.status, 'blocked', 'obstacle Recall preserves blocked status');
        assert.equal(finalThread?.resolution || '', '', 'obstacle Recall does not invent a terminal reason');
      }
    });
    const scope = await f.r.api.getHostLineageStatus();
    const writer = await actualClassicPacket(f,query,scope.scopeKey);
    const writerRows = packetRows(writer).filter(row => writer.actualClassic.block.includes(row.text));
    const writerOutcome = writerRows.find(row => row.text?.includes(expected.source));
    recordCheck(`${mode}/${outcome.id} final actual Classic`, () => {
      assert.ok(writer.evidencePacket, 'public actual Classic exposes its final evidence packet');
      assert.ok(writerOutcome, 'actual Classic includes the exact source-backed outcome');
      assert.ok(Number(writerOutcome.turnRange?.start || 0) <= 6 && Number(writerOutcome.turnRange?.end || 0) >= 6,
        'actual Classic retains outcome evidence time T6');
    });

    const gui = guiContext().buildWorldManagerHistoryDetailView(history, 'narrative');
    const guiEvents = byData(gui, 'worldHistorySemanticEvent');
    const guiEvent = guiEvents.find(node => node.dataset.worldHistorySemanticEvent === expectedEventType);
    const guiEventText = guiEvent ? textOf(guiEvent) : '';
    const guiText = textOf(gui);
    const actualOutcomeText = renderedOutcomeText.get(outcome.id);
    const expectedReasonText = renderedOutcomeReason.get(outcome.id);
    const guiObservation = {
      mode, branch: outcome.id, eventType: expectedEventType, historyEventType: finalEvent?.type || '',
      displayedOutcomeText: guiEventText.includes(actualOutcomeText), renderedOutcomeText: actualOutcomeText,
      guiContainsOutcomeReason: guiEventText.includes(expectedReasonText), expectedReasonText,
      guiContainsEvidenceRef: guiEventText.includes('t6-u'), guiContainsProductionTimeline: guiEvents.length > 0,
      semanticEventText: guiEventText
    };
    console.log(JSON.stringify({ schema: 'a13.production_history_gui_observation.v1', ...guiObservation }));
    recordCheck(`${mode}/${outcome.id} production GUI detail`, () => {
      assert.equal(gui.dataset.worldHistoryProvenance, 'state_pipeline_v3');
      assert.ok(guiEvent, `production GUI renders actual History ${expectedEventType} detail`);
      assert.ok(guiEventText.includes('t6-u'), 'semantic event row shows the actual History evidence reference');
      assert.ok(guiEventText.includes(expectedReasonText), `semantic event row explicitly labels ${outcome.id}`);
      assert.ok(guiEventText.includes(actualOutcomeText), 'semantic event row displays this exact source-backed outcome');
      if (outcome.id === 'obstacle') {
        assert.ok(!guiEventText.includes('약속 이행') && !guiEventText.includes('약속 파기') && !guiEventText.includes('합의 취소'),
          'obstacle semantic event is not mislabeled as a terminal outcome');
      } else {
        const otherReasons = [...renderedOutcomeReason.entries()].filter(([id]) => id !== outcome.id && id !== 'obstacle').map(([, reason]) => reason);
        assert.ok(otherReasons.every(reason => !guiEventText.includes(reason)), 'terminal reason is not mislabeled as a different outcome');
      }
    });

    if (mode === 'server_only') {
      const persisted = server.storedRows().some(row => row.key === outcomeRead.ref.key);
      recordCheck(`${mode}/${outcome.id} SQLite readback`, () => assert.equal(persisted, true, 'server_only outcome canonical row is present in SQLite'));
    } else if (mode === 'mirror') {
      const stores = rowsAcrossStores(server).filter(row => row.key === outcomeRead.ref.key);
      recordCheck(`${mode}/${outcome.id} mirror readback`, () => {
        assert.deepEqual(new Set(stores.map(row => row.source)), new Set(['plugin', 'server']));
        assert.equal(stores[0]?.raw, stores[1]?.raw, 'mirror stores canonical raw bytes identically');
      });
    }
    const observation = {
      mode, branch: outcome.id, accepted: finalThread?.linkStatus || '', lifecycleId: finalThread?.lifecycleId || '',
      status: finalThread?.status || '', resolution: finalThread?.resolution || '', publicState: current?.status || 'absent',
      historyEvent: finalEvent?.type || '', historyEvidenceTurn: finalEvent?.canonicalCursor?.turnRange?.start || null,
      recallMemoryId: selectedOutcomeRow?.memory?.memoryId || closureOutcome?.memoryId || '',
      selectedRecallRefs, closureRecallRefs, inputWriterTurnRange: writerOutcome?.turnRange || null,
      guiDistinct: guiEventText.includes(expectedReasonText), guiEventCount: guiEvents.length,
      openingRef: { key: initialRead.ref.key, memoryId: initialRead.ref.memoryId, sourceDigest: initialRead.ref.sourceDigest, artifactDigest: initialRead.ref.artifactDigest },
      outcomeRef: { key: outcomeRead.ref.key, memoryId: outcomeRead.ref.memoryId, sourceDigest: outcomeRead.ref.sourceDigest, artifactDigest: outcomeRead.ref.artifactDigest },
      openingRawSha256: crypto.createHash('sha256').update(initialRead.raw).digest('hex'),
      outcomeRawSha256: crypto.createHash('sha256').update(outcomeRead.raw).digest('hex')
    };
    observations.push(observation);
    console.log(JSON.stringify({ schema: 'a13.branch_mode_observation.v1', action: ACTION, ...observation }));
  } catch (error) {
    failures.push({ label: `${mode}/${outcome.id} unhandled branch`, message: String(error?.stack || error) });
    console.error(JSON.stringify({ schema: 'a13.branch_mode_error.v1', mode, branch: outcome.id, error: String(error?.stack || error) }));
  } finally {
    await server.cleanup();
  }
};

(async () => {
  for (const mode of MODES) for (const outcome of OUTCOMES) await runBranch(mode, outcome);
  const guiTexts = observations.map(row => `${row.mode}/${row.branch}:${row.guiDistinct}`).join(',');
  recordCheck('A13 all four branches × three storage modes completed', () => {
    assert.equal(observations.length, 12, `expected 12 complete branch/mode observations, got ${observations.length}`);
    assert.equal(new Set(observations.map(row => row.mode)).size, 3);
    assert.equal(new Set(observations.map(row => row.branch)).size, 4);
  });
  console.log(JSON.stringify({ schema: 'a13.aggregate_observation.v1', observations: observations.length, guiTexts, failures }));
  assert.deepEqual(failures, [], `A13 current-source action checks failed: ${JSON.stringify(failures)}`);
  for (const mode of MODES) console.log(JSON.stringify({ schema: 'acceptance.action_result.v1', case_id: 'A13', mode,
    action: ACTION, assertion_result: true, branches: OUTCOMES.map(row => row.id) }));
  console.log(JSON.stringify({ test: 'libra_phase_d_a13_four_outcomes', passed: 1, modes: MODES, branches: OUTCOMES.map(row => row.id) }));
})().catch(error => { console.error(error); process.exitCode = 1; });
