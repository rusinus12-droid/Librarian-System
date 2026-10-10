'use strict';

// Phase D3: the shipped plugin portable envelope across all nine
// source-mode -> destination-mode combinations. The source contains one v4
// batch and two v5 batches (open -> accepted/fulfilled lifecycle plus profile
// fields); every destination is a copied chat with a distinct chat identity.
const assert = require('node:assert/strict');
const { readActualCanonicalDelivery } = require('./fixtures/libra_actual_canonical_delivery.cjs');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const A39_ACTION = require('./fixtures/acceptance_scenarios.json').cases.find(row => row.id === 'A39').action;
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const sourceRows = require('./fixtures/unified_vertical_source.json').sourceRows;

const MODES = ['plugin_only', 'mirror', 'server_only'];
const clone = value => JSON.parse(JSON.stringify(value));
const parse = value => { try { return JSON.parse(value); } catch (_) { return null; } };
const PROFILE_QUOTE = '민아는 민트차를 좋아한다고 말했다.';
const BOUNDARY_QUOTE = '민아는 지호에게 오늘 편지를 열지 말라고 했다.';
const OPEN_THREAD_QUOTE = '오늘 열쇠를 반환하겠다는 약속은 아직 이행되지 않았다.';
const OPEN_THREAD_SOURCE = `서재에서 준호가 열쇠를 지호에게 건넸고, 지호가 그것을 민아에게 돌려주었다. ${OPEN_THREAD_QUOTE} 공연 허가를 누가 내주는지는 아직 밝혀지지 않았다.`;

const appendProfileEvidence = (chat, ref) => {
  const row = chat.message.find(message => message.chatId === ref || String(message.chatId).endsWith(`-${ref}`));
  assert.ok(row, `v5 source message exists: ${ref}`);
  const suffix = `${PROFILE_QUOTE} ${BOUNDARY_QUOTE}`;
  if (!String(row.data || '').includes(PROFILE_QUOTE)) row.data = `${row.data || ''} ${suffix}`.trim();
};

const makeChat = chatId => {
  const chat = {
    id: chatId,
    chatId,
    name: `Phase D portable ${chatId}`,
    message: sourceRows.map(row => ({ role: row.role, chatId: row.ref.replace(/^t/, `${chatId}-t`), data: row.text }))
  };
  chat.messages = chat.message;
  return chat;
};
const appendBatch = (chat, startTurn) => {
  for (const message of chat.message.slice(0, 10).map((message, index) => ({
    ...message, chatId: `t${startTurn + Math.floor(index / 2)}-${index % 2 ? 'a' : 'u'}`
  }))) chat.message.push(message);
  chat.messages = chat.message;
};

const shiftRefs = (value, offset) => {
  const out = clone(value);
  for (const row of [...out.entities, ...out.facts]) {
    for (const span of row.evidenceSpans || []) {
      span.ref = span.ref.replace(/^t(\d+)/, (_, turn) => `t${Number(turn) + offset}`);
    }
  }
  return out;
};

const v4Artifact = () => {
  const out = artifact();
  out.facts = out.facts.filter(fact => fact.tempFactId !== 'f12');
  out.stateBindings = out.stateBindings.filter(binding => binding.factTempId !== 'f12');
  return out;
};

const v5Artifact = ({ offset, resolved, alias = '' }) => {
  const out = shiftRefs(artifact(), offset);
  out.schema = 'libra.canonical_artifact.v5';
  const mina = out.entities.find(entity => entity.tempId === 'mina');
  const add = (tempFactId, claimKind, values, text, evidenceSpans) => out.facts.push({
    tempFactId, domain: 'character', subjectTempRef: mina.tempId, claimKind, values, text,
    temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans
  });
  add(`phase_d_preference_${offset}`, 'character_preference', {
    preferences: [{ content: '민트차를 좋아한다', topic: '민트차', kind: 'preference' }]
  }, PROFILE_QUOTE, [{ ref: `t${offset + 4}-a`, quote: PROFILE_QUOTE }]);
  add(`phase_d_boundary_${offset}`, 'character_boundary', {
    boundaries: [{
      content: '민아는 지호에게 오늘 편지를 열지 말라고 했다', topic: '편지 열기', kind: 'boundary',
      scope: { subjectRef: 'mina', targetRef: 'jiho', act: '편지 열기', when: '오늘' }
    }]
  }, BOUNDARY_QUOTE, [{ ref: `t${offset + 4}-a`, quote: BOUNDARY_QUOTE }]);
  const thread = out.facts.find(fact => fact.tempFactId === 'f12');
  thread.values.thread = {
    summary: '오늘 열쇠 반환 약속', status: resolved ? 'resolved' : 'open', kind: 'promise',
    participants: [{ role: 'owner', personTempRef: 'jiho' }, { role: 'target', personTempRef: 'mina' }],
    ...(resolved ? { link: 'resolve', resolution: 'fulfilled', linkCandidateAlias: alias } : {})
  };
  thread.text = resolved ? '오늘 열쇠 반환 약속이 이행되었다.' : '오늘 열쇠 반환 약속은 아직 이행되지 않았다.';
  if (!resolved) {
    for (const row of [...out.entities, ...out.facts]) {
      for (const span of row.evidenceSpans || []) if (span.ref === `t${offset + 5}-a`) span.quote = OPEN_THREAD_SOURCE;
    }
  }
  if (resolved) {
    const quote = '지호가 민아에게 열쇠를 돌려주어 오늘 열쇠 반환 약속이 이행되었다. 공연 허가자는 아직 밝혀지지 않았다.';
    for (const row of [...out.entities, ...out.facts]) {
      for (const span of row.evidenceSpans || []) if (span.ref === `t${offset + 5}-a`) span.quote = quote;
    }
  }
  return out;
};

const portableApi = async snapshot => {
  for (let i = 0; i < 500; i += 1) {
    if (snapshot.f.r.context.__LIBRAPortableMemoryBackup) return snapshot.f.r.context.__LIBRAPortableMemoryBackup;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('portable API unavailable');
};
const retryBusy = async operation => {
  let last;
  for (let i = 0; i < 60; i += 1) {
    try { return await operation(); } catch (error) {
      last = error;
      if (!/BUSY/.test(String(error?.code || ''))) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw last || new Error('portable operation stayed busy');
};

const ownerValue = (snapshot, mode, matcher) => {
  const localKey = [...snapshot.local.keys()].find(matcher);
  if (localKey) return parse(snapshot.local.get(localKey));
  return snapshot.storedRows().find(row => matcher(row.key))?.value || null;
};
const manifestOf = (snapshot, mode) => ownerValue(snapshot, mode, key => /:manifest$/.test(key));
const memoryOf = (snapshot, mode, start) => {
  const manifest = manifestOf(snapshot, mode);
  const ref = manifest?.memories?.[String(start)];
  if (!ref) return null;
  return parse(snapshot.local.get(ref.key)) || snapshot.storedRows().find(row => row.key === ref.key)?.value || null;
};
const memoryRawOf = (snapshot, mode, start) => {
  const manifest = manifestOf(snapshot, mode);
  const ref = manifest?.memories?.[String(start)];
  if (!ref) return null;
  const local = snapshot.local.get(ref.key);
  if (local != null) return String(local);
  return snapshot.storedRows().find(row => row.key === ref.key)?.raw || null;
};
const canonicalBytesFromRaw = raw => {
  const source = String(raw || '');
  const marker = '"canonicalArtifact"';
  const fieldAt = source.indexOf(marker);
  assert.ok(fieldAt >= 0, 'stored memory has canonicalArtifact field');
  const colonAt = source.indexOf(':', fieldAt + marker.length);
  let start = colonAt + 1;
  while (/\s/.test(source[start] || '')) start++;
  assert.equal(source[start], '{', 'stored canonicalArtifact is a JSON object');
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('stored canonicalArtifact JSON is unterminated');
};
const headOf = (snapshot, mode) => ownerValue(snapshot, mode, key => /:continuity-state$/.test(key));

const seedSource = async mode => {
  const snapshot = await serverFixture({ mode, snapshot: { chat: makeChat(`phase-d-source-${mode}`) } });
  const f = snapshot.f;
  const batches = [v4Artifact(), v5Artifact({ offset: 5, resolved: false }), null];
  f.control.onCall = args => {
    const callIndex = f.control.calls.length - 1;
    if (callIndex === 0) return { type: 'success', result: JSON.stringify(batches[0]) };
    if (callIndex === 1) return { type: 'success', result: JSON.stringify(batches[1]) };
    const out = clone(batches[2]);
    const prompt = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '';
    const match = prompt.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
    const candidates = match ? JSON.parse(match[1]) : [];
    const candidate = candidates.find(row => row.summary === '오늘 열쇠 반환 약속') || candidates[0];
    assert.ok(candidate?.alias, `${mode}: the resolved v5 batch receives a request-local alias`);
    out.facts.find(fact => fact.tempFactId === 'f12').values.thread.linkCandidateAlias = candidate.alias;
    return { type: 'success', result: JSON.stringify(out) };
  };
  try {
    f.control.artifact = batches[0];
    assert.equal((await f.run()).completed, 1, `${mode}: v4 source batch commits`);
    // `fiveMore` follows the production fixture convention and appends T6–T10.
    appendBatch(f.chat, 6);
    appendProfileEvidence(f.chat, 't9-a');
    f.chat.message.find(message => message.chatId === 't10-a').data = OPEN_THREAD_SOURCE;
    f.control.artifact = batches[1];
    assert.equal((await f.run()).completed, 1, `${mode}: v5 open source batch commits`);
    const acceptedQuote = '지호가 민아에게 열쇠를 돌려주어 오늘 열쇠 반환 약속이 이행되었다. 공연 허가자는 아직 밝혀지지 않았다.';
    appendBatch(f.chat, 11);
    appendProfileEvidence(f.chat, 't14-a');
    const acceptedSource = f.chat.message.find(message => message.chatId === 't15-a');
    assert.ok(acceptedSource, `${mode}: v5 resolved source message exists`);
    acceptedSource.data = acceptedQuote;
    batches[2] = v5Artifact({ offset: 10, resolved: true, alias: '' });
    f.control.artifact = batches[2];
    assert.equal((await f.run()).completed, 1, `${mode}: v5 resolved source batch commits`);
    const portable = await portableApi(snapshot);
    const envelope = await retryBusy(() => portable.exportCurrentScope());
    const validated = await portable.validateBackup(envelope);
    assert.equal(validated?.schema, envelope.schema, `${mode}: source envelope validates with the portable schema`);
    assert.equal(validated?.formatVersion, envelope.formatVersion, `${mode}: source envelope format is validated`);
    assert.equal(validated?.plugin?.id, 'libra', `${mode}: source envelope plugin identity is validated`);
    assert.equal(validated?.records?.length, envelope.records.length, `${mode}: source envelope record inventory is validated`);
    assert.equal(validated?.integrity?.digest || validated?.integrity?.fallbackDigest,
      envelope.integrity?.digest || envelope.integrity?.fallbackDigest, `${mode}: source envelope integrity is validated`);
    assert.equal(validated?.ok === false, false, `${mode}: validation did not return a failed result`);
    const tampered = clone(envelope);
    tampered.records[0].value = `${tampered.records[0].value} `;
    await assert.rejects(() => portable.validateBackup(tampered), /portable_backup_(?:envelope_|record_)digest_mismatch/,
      `${mode}: tampered envelope is rejected by integrity validation`);
    const manifest = manifestOf(snapshot, mode);
    assert.deepEqual(Object.keys(manifest.memories || {}).map(Number).sort((a, b) => a - b), [1, 6, 11]);
    const sourceHead = headOf(snapshot, mode);
    assert.ok(sourceHead, `${mode}: source State is readable before export`);
    assert.equal(sourceHead.status, 'ready', `${mode}: source State is ready before export`);
    assert.equal(Number(sourceHead.throughTurn), 15, `${mode}: source State covers the full 15-turn copy`);
    const sourceMina = sourceHead.characters?.find(character => character.name === '민아');
    const sourceJiho = sourceHead.characters?.find(character => character.name === '지호');
    assert.ok(sourceMina, `${mode}: source profile character is present`);
    assert.ok(sourceJiho, `${mode}: source target character is present`);
    assert.ok(sourceMina.state?.preferences?.some(item => item.topic === '민트차' && item.content === '민트차를 좋아한다'),
      `${mode}: source State retains the structured preference`);
    assert.ok(sourceMina.state?.boundaries?.some(item => item.topic === '편지 열기'
      && item.scope?.subjectRef === sourceMina.id && item.scope?.targetRef === sourceJiho.id
      && item.scope?.act === '편지 열기' && item.scope?.when === '오늘'),
      `${mode}: source State retains the structured boundary`);
    assert.equal(sourceHead.narrative?.threads?.some(thread => thread.summary === '오늘 열쇠 반환 약속'), false,
      `${mode}: resolved source lifecycle is absent from open current threads`);
    const sourceMemory = memoryOf(snapshot, mode, 11);
    const sourceHistory = await f.r.api.getWorldManagerHistoryDetail({ memoryId: sourceMemory.memoryId, revision: sourceMemory.revision });
    assert.equal(sourceHistory.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution, 'fulfilled',
      `${mode}: source History retains the fulfilled lifecycle`);
    assert.equal(sourceHistory.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.linkStatus, 'accepted',
      `${mode}: source History retains the accepted link`);
    const sourceCanonicalArtifacts = [1, 6, 11].map(start => memoryOf(snapshot, mode, start)?.canonicalArtifact);
    assert.ok(sourceCanonicalArtifacts.every(Boolean), `${mode}: all mixed v4/v5 source canonical artifacts are readable`);
    const sourceCanonicalBytes = [1, 6, 11].map(start => canonicalBytesFromRaw(memoryRawOf(snapshot, mode, start)));
    return { snapshot, sourceChat: clone(f.chat), envelope, sourceManifest: manifest, sourceMemory, sourceCanonicalArtifacts, sourceCanonicalBytes };
  } catch (error) {
    await snapshot.cleanup();
    throw error;
  }
};

const reconstructPair = async (sourceMode, destinationMode, envelope, sourceChat, sourceManifest, sourceMemory, sourceCanonicalArtifacts, sourceCanonicalBytes) => {
  const sourceChatId = String(envelope.source.chatId);
  const targetChat = makeChat(`phase-d-target-${sourceMode}-${destinationMode}`);
  // A native copy keeps the source text but has new message IDs and a new chat scope.
  const sourceSnapshot = clone(sourceChat);
  targetChat.message = sourceSnapshot.message.map((message, index) => ({
    ...message,
    chatId: message.chatId.replace(sourceChatId, targetChat.chatId)
  }));
  targetChat.messages = targetChat.message;
  const destination = await serverFixture({ destinationMode, mode: destinationMode, snapshot: { chat: targetChat } });
  try {
    const portable = await portableApi(destination);
    const preview = await retryBusy(() => portable.previewImport(envelope));
    assert.equal(preview.modes.reconstruct_native_copy.available, true,
      `${sourceMode}->${destinationMode}: copied chat mode is available`);
    const copied = await retryBusy(() => portable.reconstructCopiedChat(envelope));
    assert.equal(copied.ok, true, `${sourceMode}->${destinationMode}: copied archive is adopted`);
    const manifest = manifestOf(destination, destinationMode);
    const copiedMemory = memoryOf(destination, destinationMode, 11);
    const sourceRef = sourceManifest.memories?.['11'];
    const copiedRef = manifest.memories?.['11'];
    assert.ok(copiedMemory, `${sourceMode}->${destinationMode}: copied v5 memory exists`);
    assert.notEqual(manifest.scopeKey, sourceManifest.scopeKey,
      `${sourceMode}->${destinationMode}: reconstructed chat has a distinct destination scope`);
    assert.equal(manifest.chatId, targetChat.chatId,
      `${sourceMode}->${destinationMode}: restored manifest is bound to the new chat`);
    assert.equal(copiedMemory.scopeKey, manifest.scopeKey,
      `${sourceMode}->${destinationMode}: copied memory is stored under the destination scope`);
    assert.equal(copiedMemory.nativeCopiedFromScopeKey, sourceManifest.scopeKey,
      `${sourceMode}->${destinationMode}: origin scope is retained`);
    assert.equal(Number(copiedRef?.sessionEpoch), Number(sourceRef?.sessionEpoch),
      `${sourceMode}->${destinationMode}: session epoch is retained`);
    assert.ok(Number.isInteger(Number(copiedRef?.sessionEpoch)), `${sourceMode}->${destinationMode}: session epoch is explicit`);
    for (const start of [1, 6, 11]) {
      const copied = memoryOf(destination, destinationMode, start);
      const originalRef = sourceManifest.memories?.[String(start)];
      const destinationRef = manifest.memories?.[String(start)];
      assert.ok(copied?.canonicalArtifact, `${sourceMode}->${destinationMode}: copied canonical artifact ${start} exists`);
      assert.equal(copied.scopeKey, manifest.scopeKey,
        `${sourceMode}->${destinationMode}: copied ref ${start} resolves in destination scope`);
      assert.notEqual(destinationRef?.key, originalRef?.key,
        `${sourceMode}->${destinationMode}: copied ref ${start} is remapped to a distinct destination key`);
      assert.equal(copied.memoryId, destinationRef?.memoryId,
        `${sourceMode}->${destinationMode}: destination manifest ref ${start} identifies the stored copy`);
      assert.equal(JSON.stringify(copied.canonicalArtifact), JSON.stringify(sourceCanonicalArtifacts[[1, 6, 11].indexOf(start)]),
        `${sourceMode}->${destinationMode}: canonical artifact JSON for ${start} survives rebind`);
      assert.equal(canonicalBytesFromRaw(memoryRawOf(destination, destinationMode, start)), sourceCanonicalBytes[[1, 6, 11].indexOf(start)],
        `${sourceMode}->${destinationMode}: stored canonicalArtifact bytes for ${start} survive rebind`);
    }
    const head = headOf(destination, destinationMode);
    assert.ok(head, `${sourceMode}->${destinationMode}: State is readable after copy`);
    assert.equal(head.status, 'ready', `${sourceMode}->${destinationMode}: State is ready after copy`);
    assert.equal(Number(head.throughTurn), 15, `${sourceMode}->${destinationMode}: State covers the full copied scope`);
    const mina = head.characters?.find(character => character.name === '민아');
    const jiho = head.characters?.find(character => character.name === '지호');
    assert.ok(jiho, `${sourceMode}->${destinationMode}: copied target character is present`);
    assert.ok(mina?.state?.preferences?.some(item => item.topic === '민트차' && item.content === '민트차를 좋아한다'),
      `${sourceMode}->${destinationMode}: copied State keeps the structured preference`);
    assert.ok(mina?.state?.boundaries?.some(item => item.topic === '편지 열기'
      && item.scope?.subjectRef === mina.id && item.scope?.targetRef === jiho.id
      && item.scope?.act === '편지 열기' && item.scope?.when === '오늘'),
      `${sourceMode}->${destinationMode}: copied State keeps the structured boundary`);
    assert.equal(head.narrative?.threads?.some(thread => thread.summary === '오늘 열쇠 반환 약속'), false,
      `${sourceMode}->${destinationMode}: copied open lifecycle excludes the fulfilled thread`);
    const history = await destination.f.r.api.getWorldManagerHistoryDetail({ memoryId: copiedMemory.memoryId, revision: copiedMemory.revision });
    assert.equal(history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution, 'fulfilled',
      `${sourceMode}->${destinationMode}: History keeps fulfilled lifecycle`);
    assert.equal(history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.linkStatus, 'accepted',
      `${sourceMode}->${destinationMode}: History resolves the transferred linked lifecycle`);
    const recall = await destination.f.r.api.previewUnifiedMemoryRecall('민아 민트차 열쇠 반환 약속');
    const recallText = JSON.stringify(recall);
    assert.match(recallText, /민트차를 좋아한다/, `${sourceMode}->${destinationMode}: Recall keeps profile meaning`);
    assert.match(recallText, /이행되었다/, `${sourceMode}->${destinationMode}: Recall keeps resolved linked thread meaning`);
    const packet = await readActualCanonicalDelivery(destination, '민아 민트차 열쇠 반환 약속', { expectedMemory: copiedMemory });
    const packetText = packet.canonicalText;
    assert.match(packetText, /민트차를 좋아한다/, `${sourceMode}->${destinationMode}: Classic delivered canonical evidence keeps profile meaning`);
    assert.match(packetText, /이행되었다/, `${sourceMode}->${destinationMode}: Classic delivered canonical evidence keeps resolved lifecycle meaning`);
    return {
      sourceMode, destinationMode, copiedStarts: Object.keys(manifest.memories || {}).map(Number).sort((a, b) => a - b),
      origin: copiedMemory.nativeCopiedFromScopeKey, sessionEpoch: Number(copiedRef.sessionEpoch),
      memoryId: copiedMemory.memoryId, headThroughTurn: Number(head.throughTurn),
      historyResolution: history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution,
      recallMemories: recall.memories.length
    };
  } finally {
    await destination.cleanup();
  }
};

(async () => {
  const results = [];
  const sources = [];
  try {
    for (const sourceMode of MODES) sources.push({ sourceMode, ...(await seedSource(sourceMode)) });
    for (const source of sources) {
      for (const destinationMode of MODES) {
        results.push(await reconstructPair(source.sourceMode, destinationMode, source.envelope, source.sourceChat, source.sourceManifest, source.sourceMemory, source.sourceCanonicalArtifacts, source.sourceCanonicalBytes));
      }
    }
    assert.equal(results.length, 9);
    assert.deepEqual(results.map(row => row.copiedStarts), Array.from({ length: 9 }, () => [1, 6, 11]));
    for (const mode of MODES) {
      const destinationRows = results.filter(row => row.destinationMode === mode);
      assert.equal(destinationRows.length, 3, `${mode}: all three source modes were restored here`);
      assert.deepEqual(destinationRows.map(row => row.sourceMode).sort(), [...MODES].sort(), `${mode}: every source mode is represented`);
      console.log(JSON.stringify({
        schema: 'acceptance.action_result.v1', case_id: 'A39', mode,
        action: A39_ACTION, assertion_result: true,
        observed: `All three source modes were exported, validated and reconstructed into ${mode}; destination scopes/keys were remapped, canonical bytes and origin/epoch were preserved, and State, History, Recall, Classic consumer and linked-reference resolution were checked.`
      }));
    }
    console.log(JSON.stringify({
      test: 'libra_phase_d_portable_nine_pairs', passed: results.length, results,
      boundary: 'actual __LIBRAPortableMemoryBackup; mixed v4/v5 synthetic provider artifacts; no server manager exporter'
    }));
  } finally {
    for (const source of sources) await source.snapshot.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
