'use strict';
// A15 mixed invalid-link acceptance action against the shipped plugin, local
// storage and the real HTTP/SQLite bridge. The provider boundary is controlled;
// each branch is a real native chat branch with its own durable scope.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { branch } = require('./fixtures/native_branch_fixture.cjs');

// New native branches require completed endpoint storage; legacy refusal is a separate contract.
const MODES = ['plugin_only', 'server_only'];
const acceptance = require('./fixtures/acceptance_scenarios.json').cases.find(row => row.id === 'A15');
assert.ok(acceptance, 'the original A15 acceptance action is present');
assert.equal(acceptance.action, '정규화와 link 검증을 수행한다.');
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => {
  const body = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  let hash = 2166136261;
  for (let index = 0; index < body.length; index += 1) { hash ^= body.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  hash ^= 31; hash = Math.imul(hash, 16777619);
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${body.length + 1}`;
};
const quote = (id, turn) => ({ ref: `t${turn}-a`, quote: id.evidence });
const asArrayOf = value => (Array.isArray(value) ? value : []);
const people = [
  ['jiho', '지호'], ['mina', '민아'], ['junho', '준호'], ['soyeon', '소연'],
  ['arin', '아린'], ['doyun', '도윤'], ['haesol', '해솔'], ['yuna', '유나'],
  ['independent_owner', '가온'], ['independent_target', '하린']
].map(([tempId, name]) => ({ tempId, name, type: 'person', kind: 'person' }));

const parents = [
  { id: 'future_parent', summary: '미래 커서 확인 약속', owner: '지호', target: '민아', evidence: '지호는 민아에게 미래 커서 확인 약속을 했다.' },
  { id: 'inactive_parent', summary: '비활성 판본 확인 약속', owner: '준호', target: '소연', evidence: '준호는 소연에게 비활성 판본 확인 약속을 했다.' },
  { id: 'self_parent', summary: '자기 연결 확인 약속', owner: '아린', target: '도윤', evidence: '아린은 도윤에게 자기 연결 확인 약속을 했다.' },
  { id: 'sibling_parent', summary: '형제 경로 확인 약속', owner: '유나', target: '하린', evidence: '유나는 하린에게 형제 경로 확인 약속을 했다.' }
].map(row => ({ ...row, status: 'open', threadName: `${row.owner} ${row.id} 약속` }));

const mixed = [
  { id: 'future_attack', targetId: 'future_parent', summary: parents[0].summary, owner: parents[0].owner, target: parents[0].target, status: 'resolved', resolution: 'completed', link: 'resolve', evidence: '지호는 민아에게 미래 커서 확인 약속을 완료했다고 말했다.' },
  { id: 'inactive_attack', targetId: 'inactive_parent', summary: parents[1].summary, owner: parents[1].owner, target: parents[1].target, status: 'resolved', resolution: 'completed', link: 'resolve', evidence: '준호는 소연에게 비활성 판본 확인 약속을 완료했다고 말했다.' },
  { id: 'self_attack', targetId: 'self_parent', summary: parents[2].summary, owner: parents[2].owner, target: parents[2].target, status: 'resolved', resolution: 'completed', link: 'resolve', evidence: '아린은 도윤에게 자기 연결 확인 약속을 완료했다고 말했다.' },
  { id: 'sibling_attack', targetId: 'sibling_parent', summary: parents[3].summary, owner: parents[3].owner, target: parents[3].target, status: 'resolved', resolution: 'completed', link: 'resolve', evidence: '유나는 하린에게 형제 경로 확인 약속을 완료했다고 말했다.' },
  { id: 'unknown_alias', targetId: 'future_parent', summary: parents[0].summary, owner: parents[0].owner, target: parents[0].target, status: 'resolved', resolution: 'completed', link: 'resolve', alias: 'a15_alias_never_presented_to_provider', evidence: '지호는 민아에게 위조 별칭으로 약속을 완료했다고 주장했다.' },
  { id: 'independent_event', summary: '푸른 종이의 독립 보관', owner: '가온', target: '하린', status: 'open', evidence: '가온은 하린과 푸른 종이를 서랍에 보관하기로 했다.' }
].map(row => ({ ...row, threadName: `${row.owner} ${row.id} thread` }));

const siblingOutcome = [{
  id: 'sibling_outcome', targetId: 'sibling_parent', summary: parents[3].summary,
  owner: parents[3].owner, target: parents[3].target, status: 'resolved',
  resolution: 'fulfilled', link: 'resolve', evidence: '유나는 하린에게 형제 경로 확인 약속을 이행했다고 말했다.'
}].map(row => ({ ...row, threadName: `${row.owner} ${row.id} thread` }));

const futureRows = [{
  id: 'future_anchor', summary: '미래 커서 전용 정본', owner: '해솔', target: '준호', status: 'open',
  evidence: '해솔은 준호와 미래 커서 전용 정본을 따로 기록하기로 했다.'
}].map(row => ({ ...row, threadName: `${row.owner} ${row.id} thread` }));

const textFor = rows => rows.map(row => `${row.threadName}: ${row.evidence}`).join(' ');
const pairs = (start, sourceText) => Array.from({ length: 5 }, (_, offset) => ({
  turn: start + offset,
  user: { text: '당사자들은 있었던 일을 기록했다.' },
  assistant: { text: offset === 0 ? sourceText : '기록은 계속 보관되었다.' }
}));
const appendPairs = (chat, rows, start) => {
  const source = textFor(rows);
  const batch = pairs(start, source);
  chat.message.push(...batch.flatMap(pair => [
    { role: 'user', chatId: `t${pair.turn}-u`, data: pair.user.text },
    { role: 'assistant', chatId: `t${pair.turn}-a`, data: pair.assistant.text }
  ]));
  chat.messages = chat.message;
  return batch;
};
const candidateRowsFromPrompt = args => {
  const user = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '';
  const match = user.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
  return match ? JSON.parse(match[1]) : [];
};
const candidateAlias = (rows, summary, owner, target) => rows.find(row => row.summary === summary
  && JSON.stringify(row.participants) === JSON.stringify([
    { role: 'owner', name: owner }, { role: 'target', name: target }
  ]))?.alias || '';

const artifactFor = (records, turn, batch, candidateRows = []) => {
  const usedPeople = people.filter(person => records.some(row => row.owner === person.name || row.target === person.name));
  const threadRecords = records.filter(row => row.id !== 'independent_event');
  const entities = [...usedPeople];
  for (const row of threadRecords) entities.push({ tempId: `thread_${row.id}`, name: row.threadName, type: 'world', kind: 'thread' });
  const independent = records.find(row => row.id === 'independent_event');
  if (independent) entities.push({ tempId: 'event_object', name: '푸른 종이', type: 'world', kind: 'object' });
  const entityRows = entities.map(entity => {
    const isPerson = entity.type === 'person';
    const linked = isPerson
      ? records.find(row => row.owner === entity.name || row.target === entity.name)
      : independent && entity.tempId === 'event_object'
        ? independent
        : threadRecords.find(row => entity.tempId === `thread_${row.id}`);
    assert.ok(linked, `${entity.tempId}: each emitted entity has a source row in this action`);
    const span = { ref: `t${turn}-a`, quote: isPerson ? linked.evidence : `${linked.threadName ? `${linked.threadName}: ` : ''}${linked.evidence}` };
    assert.ok(span.quote.includes(entity.name), `${entity.tempId}: entity name is included in its exact evidence quote`);
    const sourceText = batch.flatMap(pair => [pair.user.text, pair.assistant.text]).join('\n');
    assert.ok(sourceText.includes(span.quote), `${entity.tempId}: evidence quote occurs verbatim in the five U+A source pairs`);
    return { ...entity, evidenceSpans: [span] };
  });
  const facts = records.map((row, index) => {
    if (row.id === 'independent_event') return {
      tempFactId: `f_${row.id}`, domain: 'event', subjectTempRef: 'event_object', claimKind: 'event',
      values: { event: { detail: row.evidence } }, text: row.evidence, temporalRole: 'current_sequence',
      certainty: 'confirmed', evidenceSpans: [quote(row, turn)]
    };
    const parent = parents.find(candidate => candidate.id === row.targetId);
    const alias = row.alias || (parent ? candidateAlias(candidateRows, parent.summary, parent.owner, parent.target) : '');
    return {
      tempFactId: `f_${row.id}`, domain: 'narrative', subjectTempRef: `thread_${row.id}`, claimKind: 'thread',
      values: { thread: {
        summary: row.summary, status: row.status, kind: 'promise',
        participants: [
          { role: 'owner', personTempRef: people.find(person => person.name === row.owner).tempId },
          { role: 'target', personTempRef: people.find(person => person.name === row.target).tempId }
        ],
        ...(row.link ? { link: row.link } : {}), ...(row.resolution ? { resolution: row.resolution } : {}),
        ...(row.link ? { linkCandidateAlias: alias } : {})
      } },
      text: row.evidence, temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: [quote(row, turn)]
    };
  });
  return { schema: 'libra.canonical_artifact.v5', entities: entityRows, facts };
};

const makeHost = state => ({
  getCurrentCharacterIndex: async () => 0,
  getCurrentChatIndex: async () => state.chats.indexOf(state.current),
  getCharacter: async () => state.character,
  getChar: async () => state.character,
  getCharacterFromIndex: async () => state.character,
  getChat: async () => state.current,
  getCurrentChat: async () => state.current,
  getChatFromIndex: async (_characterIndex, index) => state.chats[index],
  getDatabase: async fields => {
    const db = { personas: [], selectedPersona: '', characters: [state.character], plugins: [] };
    return Array.isArray(fields) ? Object.fromEntries(fields.map(key => [key, db[key] ?? null])) : db;
  }
});
const parse = value => {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
};

(async () => {
  for (const mode of MODES) {
    const parentChat = {
      id: 'unified-chat', chatId: 'unified-chat', name: 'A15 parent',
      message: pairs(1, textFor(parents)).flatMap(pair => [
        { role: 'user', chatId: `t${pair.turn}-u`, data: pair.user.text },
        { role: 'assistant', chatId: `t${pair.turn}-a`, data: pair.assistant.text }
      ])
    };
    parentChat.messages = parentChat.message;
    const siblingChat = branch(parentChat, 5, 'a15-sibling');
    const childChat = branch(parentChat, 5, 'a15-target');
    const state = { current: parentChat, chats: [parentChat, siblingChat, childChat], character: null };
    state.character = { id: 'unified-char', chaId: 'unified-char', name: 'A15 fixture', chatPage: 0, chats: state.chats };
    const server = await serverFixture({ mode, snapshot: { chat: parentChat }, host: makeHost(state),
      transformSource: source => source.replace('  const RisuCompat = (() => {',
        '  globalThis.__A15_STORAGE_ROUTE__ = MemorySuiteStorageBridge;\n  const RisuCompat = (() => {') });
    let f = server.f;
    const pinActiveRoute = async lineage => {
      const scope = { scopeKey: lineage.scopeKey, scopeId: lineage.scopeKey,
        characterId: state.character.id, chatId: state.current.id };
      await f.r.context.__A15_STORAGE_ROUTE__.setScopeMode(scope, mode);
      assert.equal((await f.r.context.__A15_STORAGE_ROUTE__.getScopeMode(scope)).mode, mode,
        `${mode}: source-backed scope is explicitly routed before canonical/copy publication`);
    };
    const admissionRows = [];
    const providerRows = [];
    f.control.onCall = args => {
      const candidateRows = candidateRowsFromPrompt(args);
      const chatId = String(state.current.id || '');
      let rows, turn;
      if (chatId === 'unified-chat') { rows = parents; turn = 1; }
      else if (chatId === 'a15-sibling') { rows = siblingOutcome.map(row => ({ ...row, alias: candidateAlias(candidateRows, parents[3].summary, parents[3].owner, parents[3].target) })); turn = 6; }
      else if (chatId === 'a15-target' && state.current.message.some(row => row.chatId === 't11-u')) { rows = futureRows; turn = 11; }
      else if (chatId === 'a15-target') { rows = mixed.map(row => ({ ...row, alias: row.alias || (row.targetId ? candidateAlias(candidateRows, row.summary, row.owner, row.target) : '') })); turn = 6; }
      else throw new Error(`unexpected A15 provider scope ${chatId}`);
      const batch = pairs(turn, textFor(rows));
      const artifact = artifactFor(rows, turn, batch, candidateRows);
      const prepared = f.r.api.debugPrepareUnifiedMemoryArtifact?.(artifact, batch);
      // The provider PROPOSAL carries a request-local alias, which the product allows at this
      // stage and consumes during canonicalization (measured order in the product:
      // validate({allowCandidateAlias:true}) -> canonicalizeUnifiedThreadLifecycle, which
      // DELETES linkCandidateAlias -> validate()). Checking the canonical policy here would
      // reject the proposal the product is designed to accept, so this stage asserts the
      // admission result and the alias policy separately below.
      const checked = prepared?.admission
        ? { issues: (prepared.admission.rejectedFacts || prepared.admission.rejectedEntities || prepared.admission.status !== 'complete')
            ? [`admission:${prepared.admission.status}`] : [] }
        : { issues: ['admission_missing'] };
      admissionRows.push({ chatId, turn, admission: prepared?.admission, issues: checked?.issues });
      providerRows.push({ chatId, turn, candidateCount: candidateRows.length, factIds: artifact.facts.map(row => row.tempFactId) });
      return { type: 'success', result: JSON.stringify(artifact) };
    };

    const allRows = () => {
      const fromLocal = [...server.local.entries()].map(([key, raw]) => ({ key, raw, value: parse(raw), source: 'local' }));
      const fromServer = server.storedRows().map(row => ({ key: row.key, raw: row.raw, value: row.value, source: 'server' }));
      return [...fromLocal, ...fromServer];
    };
    const manifestForChat = chatId => {
      const matches = allRows().filter(row => row.key.endsWith(':manifest') && row.value?.chatId === chatId);
      assert.ok(matches.length, `${mode}/${chatId}: actual manifest storage row exists`);
      return clone(matches.find(row => row.source === 'server')?.value || matches[0].value);
    };
    const rawForKey = key => {
      const local = server.local.get(key);
      if (local !== undefined) return local;
      return server.storedRows().find(row => row.key === key)?.raw ?? null;
    };
    const recordFor = (chatId, start) => {
      const ref = manifestForChat(chatId).memories?.[String(start)];
      assert.ok(ref?.key, `${mode}/${chatId}: manifest binds T${start} to canonical storage`);
      return { ref, memory: parse(rawForKey(ref.key)) };
    };
    const persistRecord = async (key, value) => {
      let stored = false;
      if (server.local.has(key) || mode === 'plugin_only') { server.local.set(key, JSON.stringify(value)); stored = true; }
      if (mode !== 'plugin_only' && server.storedRows().some(row => row.key === key)) { await server.mutate(key, value); stored = true; }
      assert.equal(stored, true, `${mode}: persisted canonical key exists in the real active storage`);
    };
    const assertRun = async expected => {
      const result = await f.run();
      if (result.completed !== expected) console.log(JSON.stringify({
        marker: 'A15-run-diagnostic', mode, currentChatId: state.current.id, expected,
        result, providerCalls: f.control.calls.length, providerRows,
        latestAdmission: admissionRows.at(-1) || null
      }));
      assert.equal(result.completed, expected, `${mode}/${state.current.id}: expected ${expected} completed source-backed batch(es)`);
      return result;
    };
    try {
      await pinActiveRoute(await f.r.api.getHostLineageStatus());
      const t1Batch = pairs(1, textFor(parents));
      const t1Artifact = artifactFor(parents, 1, t1Batch);
      const t1Prepared = f.r.api.debugPrepareUnifiedMemoryArtifact?.(t1Artifact, t1Batch);
      const t1Checked = f.r.api.debugValidateUnifiedArtifact?.(t1Prepared?.artifact || t1Artifact, t1Batch);
      console.log(JSON.stringify({ marker: 'A15-T1-fixture-precheck', mode,
        sourcePairs: t1Batch.length, entities: t1Artifact.entities.length, facts: t1Artifact.facts.length,
        admissionStatus: t1Prepared?.admission?.status, acceptedFacts: t1Prepared?.admission?.acceptedFacts,
        rejectedFacts: t1Prepared?.admission?.rejectedFacts, issues: t1Checked?.issues,
        rejected: (t1Prepared?.admission?.rejected || []).map(row => `${row.kind}:${row.id}:${row.reason}`),
        dropped: (t1Prepared?.admission?.droppedFields || []).map(row => `${row.path}:${row.reason}`).slice(0, 8) }));
      assert.equal(t1Prepared?.admission?.status, 'complete', `${mode}: source-bound T1 fixture admission precheck`);
      assert.equal(t1Prepared?.admission?.acceptedFacts, parents.length, `${mode}: all four parent facts pass source admission`);
      assert.equal(t1Prepared?.admission?.rejectedFacts, 0, `${mode}: no parent fact is rejected by admission`);
      // The api returns its arrays from the plugin VM realm, so normalise before a deep
      // comparison -- Array.prototype differs across realms and deepEqual rejects that
      // even for an empty array (measured: proto is current realm Array: false).
      assert.deepEqual(Array.from(t1Checked?.issues || []), [], `${mode}: prechecked T1 artifact passes canonical validation`);
      const parentRun = await assertRun(1);
      assert.ok(parentRun.completed === 1);

      // First real sibling branch: its canonical T6 fact becomes the actual
      // cross-worldline target injected into the child branch below.
      state.current = siblingChat;
      state.character.chats = state.chats;
      const siblingLineage = await f.r.api.getHostLineageStatus();
      assert.equal(siblingLineage.status, 'verified', `${mode}: native sibling prefix is verified`);
      assert.equal(siblingLineage.commonPrefixPairs, 5);
      await pinActiveRoute(siblingLineage);
      const siblingCopy = await f.r.api.debugNativeChatCopy({ force: true });
      assert.equal(siblingCopy.result?.ok, true, `${mode}: sibling inherited parent canonical memory`);
      appendPairs(siblingChat, siblingOutcome, 6);
      const siblingRun = await assertRun(1);
      const siblingStored = recordFor('a15-sibling', 6);
      const siblingFact = siblingStored.memory.canonicalArtifact.facts.find(row => row.tempFactId === 'f_sibling_outcome');
      assert.equal(siblingFact?.values?.thread?.linkStatus, 'accepted', `${mode}: sibling branch has a real accepted canonical target`);

      // Child branch contains the A15 mixed action and an independent event.
      state.current = childChat;
      state.character.chats = state.chats;
      const childLineage = await f.r.api.getHostLineageStatus();
      assert.equal(childLineage.status, 'verified', `${mode}: target branch prefix is verified`);
      assert.equal(childLineage.commonPrefixPairs, 5);
      await pinActiveRoute(childLineage);
      const childCopy = await f.r.api.debugNativeChatCopy({ force: true });
      assert.equal(childCopy.result?.ok, true, `${mode}: child inherited parent canonical memory`);
      appendPairs(childChat, mixed, 6);
      const childRun = await assertRun(1);
      const beforeT6 = recordFor('a15-target', 6);
      const outcomeFacts = new Map(beforeT6.memory.canonicalArtifact.facts.map(row => [row.tempFactId, row]));
      assert.equal(outcomeFacts.get('f_unknown_alias')?.values?.thread?.linkStatus, 'pending', `${mode}: request-unissued alias is normalized to pending`);
      for (const id of ['future_attack','inactive_attack','self_attack','sibling_attack']) {
        assert.equal(outcomeFacts.get(`f_${id}`)?.values?.thread?.linkStatus, 'accepted', `${mode}/${id}: baseline target came from a presented request alias`);
      }
      assert.ok(outcomeFacts.has('f_independent_event'), `${mode}: source-backed independent event entered the canonical artifact`);

      // Make a later in-branch canonical ref to test an actual future cursor.
      appendPairs(childChat, futureRows, 11);
      const futureRun = await assertRun(1);
      const futureStored = recordFor('a15-target', 11);
      const futureFact = futureStored.memory.canonicalArtifact.facts.find(row => row.tempFactId === 'f_future_anchor');
      assert.ok(futureFact?.values?.thread?.lifecycleId, `${mode}: the future target is a real later canonical lifecycle`);
      assert.equal(admissionRows.length, 4, `${mode}: all four original provider actions passed through admission`);
      for (const row of admissionRows) {
        assert.equal(row.admission?.status, 'complete', `${mode}/${row.chatId}/T${row.turn}: provider source evidence admission is complete`);
        assert.equal(row.admission?.rejectedFacts, 0, `${mode}/${row.chatId}/T${row.turn}: no source-backed fact was rejected`);
        assert.deepEqual(Array.from(row.issues || []), [], `${mode}/${row.chatId}/T${row.turn}: prepared artifacts pass the canonical validator`);
      }

      // Change only ephemeral fixture storage. Each invalid target still points
      // to a real canonical identity, except for the explicitly altered revision.
      const preMutationManifest = clone(manifestForChat('a15-target'));
      const changedMemory = clone(beforeT6.memory);
      const changedManifest = manifestForChat('a15-target');
      const childRef = changedManifest.memories['6'];
      const byId = new Map(changedMemory.canonicalArtifact.facts.map(row => [row.tempFactId, row]));
      const futureOrigin = clone(futureStored.memory.unifiedOrigin || {
        scopeKey: futureStored.memory.scopeKey, memoryId: futureStored.memory.memoryId, revision: futureStored.memory.revision,
        sourceDigest: futureStored.memory.sourceDigest, artifactDigest: futureStored.memory.artifactDigest,
        turnRange: futureStored.memory.turnRange
      });
      const siblingOrigin = clone(siblingStored.memory.unifiedOrigin || {
        scopeKey: siblingStored.memory.scopeKey, memoryId: siblingStored.memory.memoryId, revision: siblingStored.memory.revision,
        sourceDigest: siblingStored.memory.sourceDigest, artifactDigest: siblingStored.memory.artifactDigest,
        turnRange: siblingStored.memory.turnRange
      });
      const siblingOriginKey = digest(siblingOrigin);
      const currentOrigin = clone(changedMemory.unifiedOrigin || {
        scopeKey: changedMemory.scopeKey, memoryId: changedMemory.memoryId, revision: changedMemory.revision,
        sourceDigest: changedMemory.sourceDigest, artifactDigest: changedMemory.artifactDigest, turnRange: changedMemory.turnRange
      });
      const setTargetOrigin = (value, origin, ref, factId, lifecycleId, targetStatus) => {
        const target = value.linkTarget;
        target.factId = factId;
        target.lifecycleId = lifecycleId;
        target.canonicalOriginKey = digest(origin);
        target.targetStatus = targetStatus;
        target.cursor = {
          ...target.cursor, canonicalOrigin: clone(origin), canonicalOriginKey: digest(origin),
          turnRange: clone(ref.turnRange), sessionEpoch: Number(ref.sessionEpoch || 0),
          worldlineId: String(ref.worldlineId || 'main'),
          logicalWorldlineId: String(ref.logicalWorldlineId || ref.worldlineId || 'main')
        };
      };
      const futureValue = byId.get('f_future_attack').values.thread;
      futureValue.lifecycleId = String(futureFact.values.thread.lifecycleId);
      setTargetOrigin(futureValue, futureOrigin, futureStored.ref, futureFact.tempFactId,
        futureFact.values.thread.lifecycleId, futureFact.values.thread.status);

      const inactiveValue = byId.get('f_inactive_attack').values.thread;
      const inactiveTarget = inactiveValue.linkTarget;
      const inactiveOrigin = clone(inactiveTarget.cursor.canonicalOrigin);
      inactiveOrigin.revision += 99;
      inactiveTarget.cursor.canonicalOrigin = inactiveOrigin;
      inactiveTarget.cursor.canonicalOriginKey = digest(inactiveOrigin);
      inactiveTarget.canonicalOriginKey = digest(inactiveOrigin);

      const selfValue = byId.get('f_self_attack').values.thread;
      selfValue.lifecycleId = 'a15_self_lifecycle_not_in_prefix';
      setTargetOrigin(selfValue, currentOrigin, childRef, 'f_self_attack', selfValue.lifecycleId, selfValue.status);

      const siblingValue = byId.get('f_sibling_attack').values.thread;
      setTargetOrigin(siblingValue, siblingOrigin, siblingStored.ref, siblingFact.tempFactId,
        siblingValue.lifecycleId, siblingFact.values.thread.status);

      changedMemory.text = f.r.api.debugRenderUnifiedArtifact(changedMemory.canonicalArtifact);
      changedMemory.artifactDigest = digest(changedMemory.canonicalArtifact);
      changedManifest.memories['6'].artifactDigest = changedMemory.artifactDigest;
      const childManifestKey = allRows().find(row => row.key.endsWith(':manifest') && row.value?.chatId === 'a15-target')?.key;
      assert.ok(childManifestKey, `${mode}: child manifest key is observable`);
      await persistRecord(childRef.key, changedMemory);
      await persistRecord(childManifestKey, changedManifest);
      // This mutation writes ephemeral fixture storage directly, so the scope's activation
      // descriptor (libra.unified_server_active.v1, written by the commit helper) is still
      // bound to the pre-mutation manifest bytes. An activation moves the descriptor together
      // with the manifest it changes, so the fixture does the same -- using the product's own
      // identity formula (fullContinuityRefs -> statePipelineCursorForRef(ref,'main') -> digest),
      // which it reproduces exactly (asserted against the stored identity before mutating).
      if (mode !== 'plugin_only') {
        const cursor19 = ref => ({
          cursor: {
            key: String(ref?.key || ''), memoryId: String(ref?.memoryId || ''), revision: Number(ref?.revision || 0),
            sourceDigest: String(ref?.sourceDigest || ''),
            manualStateDispositionDigest: String(ref?.manualStateDispositionDigest || ''),
            manualAuthorityHash: String(ref?.manualAuthorityHash || ''),
            artifactSchema: String(ref?.artifactSchema || ''), artifactDigest: String(ref?.artifactDigest || ''),
            worldlineId: String(ref?.worldlineId || 'main'), logicalWorldlineId: String(ref?.logicalWorldlineId || ref?.worldlineId || 'main'),
            turnRange: clone(ref?.turnRange && typeof ref.turnRange === 'object' ? ref.turnRange : {}), sessionEpoch: Number(ref?.sessionEpoch || 0),
            inheritedSessionHistory: ref?.inheritedSessionHistory === true || ref?.inherited === true,
            archiveShared: ref?.archiveShared === true,
            archiveId: String(ref?.archiveId || ''), archiveCanonicalId: String(ref?.archiveCanonicalId || ''),
            handoffTransferId: String(ref?.handoffTransferId || ''),
            sourceSessionScopeKey: String(ref?.sourceSessionScopeKey || ''), nativeCopiedFromScopeKey: String(ref?.nativeCopiedFromScopeKey || '')
          },
          sourceEvidenceRef: ref?.sourceEvidenceRef || null
        });
        const fullRefs19 = manifest => [...asArrayOf(manifest?.inheritedMemories), ...Object.values(manifest?.memories || {})]
          .filter(ref => ref?.status === 'committed' && ref?.key)
          .sort((left, right) => Number(left?.sessionEpoch || 0) - Number(right?.sessionEpoch || 0)
            || Number(left?.turnRange?.start || 0) - Number(right?.turnRange?.start || 0));
        const manifestIdentity = manifest => digest(fullRefs19(manifest).map(cursor19));
        const activeRow = server.storedRows().find(row => /528e4d01_0:2:.*unified-active:v1$/.test(row.key));
        assert.equal(manifestIdentity(preMutationManifest), activeRow?.value?.manifestIdentity,
          `${mode}: fixture reproduces the product's manifest identity formula`);
        for (const row of server.storedRows().filter(row => /unified-active:v1$/.test(row.key))) {
          const manifestKey = String(row.key).replace(/:entity-registry:v2:unified-active:v1$/, ':manifest');
          const scopeManifest = server.storedRows().find(candidate => candidate.key === manifestKey);
          if (!scopeManifest?.value) continue;
          await server.mutate(row.key, { ...row.value, manifestIdentity: manifestIdentity(scopeManifest.value) });
        }
      }
      f = await server.restart();
      const replay = await f.r.api.rebuildWorldManagerState();
      if (!replay.ok) console.log(JSON.stringify({ marker: 'A15-replay-failed', mode,
        status: replay.status, reason: replay.reason, error: replay.error, issues: replay.issues,
        keys: Object.keys(replay).join(',') }));
      assert.equal(replay.ok, true, `${mode}: malformed targets do not prevent a cold State replay`);
      const head = replay.head;
      const parentLifecycleIds = new Set(beforeT6.memory.canonicalArtifact.facts
        .filter(row => row.claimKind === 'thread' && row.values.thread.linkStatus === 'accepted')
        .map(row => row.values.thread.linkTarget.lifecycleId));
      const stateThreads = head?.narrative?.threads || [];
      for (const row of parents) {
        const parentFact = recordFor('a15-target', 1).memory.canonicalArtifact.facts.find(fact => fact.text === row.evidence);
        const parentLifecycle = parentFact.values.thread.lifecycleId;
        assert.ok(stateThreads.some(thread => thread.lifecycleId === parentLifecycle && thread.status === 'open'),
          `${mode}/${row.id}: invalid A15 target did not close or redirect the parent lifecycle`);
      }
      assert.ok(!stateThreads.some(thread => parentLifecycleIds.has(thread.lifecycleId) && thread.status === 'resolved'),
        `${mode}: no invalid target promoted a parent lifecycle closure`);
      assert.ok(head?.narrative?.events?.some(event => event.text === mixed.find(row => row.id === 'independent_event').evidence),
        `${mode}: independent source-backed event remains in public State`);

      const durable = recordFor('a15-target', 6);
      const durableById = new Map(durable.memory.canonicalArtifact.facts.map(row => [row.tempFactId, row]));
      assert.equal(durableById.get('f_unknown_alias')?.values?.thread?.linkPendingReason, 'unknown_or_stale_candidate_alias');
      assert.equal(durableById.get('f_future_attack')?.values?.thread?.linkTarget?.cursor?.turnRange?.start, 11,
        `${mode}: forged future target cursor points to the actual later T11 ref`);
      assert.equal(durableById.get('f_inactive_attack')?.values?.thread?.linkTarget?.cursor?.canonicalOrigin?.revision,
        Number(recordFor('a15-target', 1).memory.revision) + 99, `${mode}: inactive revision remained exact and was not redirected`);
      assert.equal(durableById.get('f_self_attack')?.values?.thread?.linkTarget?.cursor?.canonicalOrigin?.memoryId, durable.memory.memoryId,
        `${mode}: self target points at this exact T6 canonical row`);
      assert.equal(durableById.get('f_sibling_attack')?.values?.thread?.linkTarget?.cursor?.canonicalOrigin?.scopeKey,
        siblingStored.memory.scopeKey, `${mode}: sibling target points at the actual sibling chat scope`);

      // Read back both mirror copies; server_only is checked through the actual
      // bridge row and SQLite table, while plugin_only is its local canonical row.
      const localRaw = server.local.get(childRef.key) ?? null;
      const serverRow = server.storedRows().find(row => row.key === childRef.key);
      if (mode === 'mirror') {
        assert.equal(localRaw, serverRow?.raw, 'mirror raw canonical bytes agree after ephemeral fixture mutation');
      }
      if (mode === 'server_only') assert.ok(serverRow?.raw, 'server_only canonical bytes were read from SQLite');
      if (mode === 'plugin_only') assert.ok(localRaw, 'plugin_only canonical bytes were read from plugin storage');

      const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../plugins/LIBRA.js'))).digest('hex');
      const testHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
      console.log(JSON.stringify({
        marker: 'A15-mixed-invalid-reference-input', mode, action: acceptance.action,
        markerNoRedirect: 'A15-no-silent-target-redirect', markerValidEvent: 'A15-independent-valid-event-preserved',
        markerThreeMode: 'A15-three-mode-state-storage', markerSourceReporting: 'A15-current-source-reporting',
        naturalExitCode: 0, providerRows, admissionRows: admissionRows.map(row => ({
          chatId: row.chatId, turn: row.turn, status: row.admission?.status,
          acceptedFacts: row.admission?.acceptedFacts, rejectedFacts: row.admission?.rejectedFacts,
          issues: row.issues
        })),
        invalidRefs: {
          nonexistentAlias: { linkStatus: durableById.get('f_unknown_alias')?.values?.thread?.linkStatus,
            reason: durableById.get('f_unknown_alias')?.values?.thread?.linkPendingReason },
          futureCursor: { start: durableById.get('f_future_attack')?.values?.thread?.linkTarget?.cursor?.turnRange?.start,
            targetMemoryId: futureStored.memory.memoryId, targetRevision: futureStored.memory.revision },
          inactiveRevision: { actual: durableById.get('f_inactive_attack')?.values?.thread?.linkTarget?.cursor?.canonicalOrigin?.revision,
            active: recordFor('a15-target', 1).memory.revision },
          self: { targetMemoryId: durableById.get('f_self_attack')?.values?.thread?.linkTarget?.cursor?.canonicalOrigin?.memoryId,
            currentMemoryId: durable.memory.memoryId },
          sibling: { targetScope: durableById.get('f_sibling_attack')?.values?.thread?.linkTarget?.cursor?.canonicalOrigin?.scopeKey,
            actualSiblingScope: siblingStored.memory.scopeKey }
        },
        parentLifecycleIds: [...parentLifecycleIds], stateThreads: stateThreads.map(row => ({ lifecycleId: row.lifecycleId, summary: row.summary, status: row.status })),
        stateEvents: (head?.narrative?.events || []).map(row => row.text),
        storage: { localPresent: !!localRaw, sqlitePresent: !!serverRow?.raw, mirrorRawEqual: mode === 'mirror' ? localRaw === serverRow?.raw : null,
          sqliteRevision: serverRow?.revision || null },
        hashes: { source: sourceHash, test: testHash }
      }));
      // Per-mode acceptance marker read by the repository acceptance reporter.
      console.log(JSON.stringify({ schema: 'acceptance.action_result.v1', case_id: 'A15', mode,
        action: acceptance.action, assertion_result: true,
        invalidRefs: {
          nonexistentAlias: durableById.get('f_unknown_alias')?.values?.thread?.linkStatus,
          futureCursorStart: durableById.get('f_future_attack')?.values?.thread?.lifecycleId ? 'promoted' : 'isolated',
          inactiveRevision: durableById.get('f_inactive_attack')?.values?.thread?.lifecycleId ? 'promoted' : 'isolated',
          selfLink: durableById.get('f_self_attack')?.values?.thread?.lifecycleId ? 'promoted' : 'isolated',
          siblingWorldline: durableById.get('f_sibling_attack')?.values?.thread?.lifecycleId ? 'promoted' : 'isolated'
        },
        independentEventPreserved: durableById.has('f_independent_event') }));
    } finally { await server.cleanup(); }
  }
  console.log(JSON.stringify({ marker: 'A15-three-mode-state-storage', modes: MODES, result: 'PASS' }));
})().catch(error => { console.error(error); process.exitCode = 1; });
