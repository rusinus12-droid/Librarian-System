'use strict';
// D1: the tracked 105-pair gold transcript traverses the shipped Librarian,
// canonical storage, State, Recall, History, and Input Writer paths. The provider
// boundary is controlled and local; this is not a live-model quality claim.
const assert = require('node:assert/strict');
const transcriptFixture = require('./fixtures/acceptance_scenarios.json').gold_transcripts
  .find(row => row.id === 'LETTER-LIFECYCLE');
const A12_ACTION = require('./fixtures/acceptance_scenarios.json').cases.find(row => row.id === 'A12').action;
const A17_ACTION = require('./fixtures/acceptance_scenarios.json').cases.find(row => row.id === 'A17').action;
const A18_ACTION = require('./fixtures/acceptance_scenarios.json').cases.find(row => row.id === 'A18').action;
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { countCalls } = require('./fixtures/libra_provider_call_kinds.cjs');
const { branch } = require('./fixtures/native_branch_fixture.cjs');
const { createRootBoundary } = require('./fixtures/source_edit_root_boundary.cjs');

const MODES = process.env.LIBRA_LETTER_LIFECYCLE_MODE
  ? [process.env.LIBRA_LETTER_LIFECYCLE_MODE] : ['plugin_only', 'server_only'];
// This suite creates new native branches, which require completed endpoint storage.
// Retired mirror refusal and retained-data recovery run in storage_mirror_transition_retirement_test.
const REROLL = transcriptFixture.reroll_variant;
const FORK = transcriptFixture.fork_variant;
const SUMMARY = '붉은 봉투 편지 전달 약속';
const clone = value => JSON.parse(JSON.stringify(value));
const canonicalPacketRows = packet => Object.values(packet?.evidencePacket?.layers || {}).flatMap(rows => Array.isArray(rows) ? rows : []);
const turnFromRef = ref => Number(/^t(\d+)-/.exec(String(ref || ''))?.[1] || 0);
const storedJsonFieldBytes = (raw, field) => {
  const source = String(raw), marker = `\"${field}\"`;
  const fieldAt = source.indexOf(marker);
  assert.ok(fieldAt >= 0, `stored memory has ${field} field`);
  const colonAt = source.indexOf(':', fieldAt + marker.length);
  let start = colonAt + 1;
  while (/\s/.test(source[start] || '')) start++;
  assert.ok(source[start] === '{' || source[start] === '[', `stored ${field} is a JSON object or array`);
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '\"') quoted = false;
      continue;
    }
    if (char === '\"') { quoted = true; continue; }
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`stored ${field} JSON bytes are unterminated`);
};
const turns = transcriptFixture.turns;
assert.equal(turns.length, 105, 'the fixture is the original complete 105 U+A gold transcript');

const messagesForTurns = selected => selected.flatMap(turn => [
  { role: 'user', chatId: turn.user.ref, data: turn.user.text },
  { role: 'assistant', chatId: turn.assistant.ref, data: turn.assistant.text }
]);
const makeChat = (id, selected) => {
  const message = messagesForTurns(selected);
  return { id, chatId: id, name: id === 'unified-chat' ? 'LETTER-LIFECYCLE parent' : id, message, messages: message };
};
const quote = (turn, role = 'user', selectedTurns = turns) => {
  const row = selectedTurns.find(item => item.turn === turn);
  assert.ok(row, `source pair ${turn} exists in this lifecycle variant`);
  const item = role === 'assistant' ? row.assistant : row.user;
  return { ref: item.ref, quote: item.text };
};
const candidateRowsFromPrompt = args => {
  const user = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '';
  const match = user.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
  return match ? JSON.parse(match[1]) : [];
};
const candidateFor = rows => rows.find(row => row.summary === SUMMARY && JSON.stringify(row.participants) === JSON.stringify([
  { role: 'owner', name: '민아' }, { role: 'target', name: '지호' }
]));
const quotedTurns = args => {
  const content = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '';
  return [...content.matchAll(/\[t(\d+)-u\]/g)].map(match => Number(match[1]));
};

const makeArtifact = (selectedTurns, { candidateRows = [], childCancellation = false } = {}) => {
  const entities = new Map();
  const facts = [];
  const putEntity = (entity, turn, role) => {
    if (!entities.has(entity.tempId)) entities.set(entity.tempId, {
      tempId: entity.tempId, name: entity.name, type: entity.type, kind: entity.kind,
      evidenceSpans: [quote(turn, role, selectedTurns)]
    });
  };
  for (const row of selectedTurns) {
    const turn = row.turn;
    const rerolled105 = turn === 105 && row.user.text === REROLL.user;
    const isMilestone = turn === 5 || turn === 40 || (turn === 105 && !rerolled105)
      || (turn === FORK.child_at_turn && childCancellation);
    if (!isMilestone) {
      // Neutral gold pairs are represented by their own source-backed dialogue event.
      // The reroll's blocked attempt is also retained as an event, without a closure link.
      if (rerolled105) {
        putEntity({ tempId: 'drawer', name: '서랍', type: 'world', kind: 'object' }, turn, 'assistant');
        facts.push({
          tempFactId: `reroll_event_${turn}`, domain: 'event', subjectTempRef: 'drawer', claimKind: 'event',
          values: { event: { detail: row.assistant.text } }, text: row.assistant.text,
          temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: [quote(turn, 'assistant', selectedTurns)]
        });
      } else {
        putEntity({ tempId: 'record_room', name: '기록실', type: 'world', kind: 'location' }, turn, 'user');
        facts.push({
          tempFactId: `gold_dialogue_${turn}`, domain: 'event', subjectTempRef: 'record_room', claimKind: 'event',
          values: { event: { detail: row.user.text } }, text: row.user.text,
          temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: [quote(turn, 'user', selectedTurns)]
        });
      }
      continue;
    }

    const cancelled = turn === FORK.child_at_turn && childCancellation;
    const reaffirmed = turn === 40;
    const fulfilled = turn === 105 && !rerolled105;
    const evidenceRole = turn === 5 ? 'user' : 'assistant';
    const candidate = reaffirmed || fulfilled || cancelled ? candidateFor(candidateRows) : null;
    if (reaffirmed || fulfilled || cancelled) {
      assert.ok(candidate?.alias, `turn ${turn} has the exact active lifecycle candidate in the current provider request`);
      assert.deepEqual(Object.keys(candidate).sort(), ['alias', 'participants', 'summary'],
        'the provider sees only request-local alias, short summary, and role-labeled participant names');
      assert.doesNotMatch(JSON.stringify(candidate), /memoryId|factId|cursor|personId|lifecycleId|sourceDigest/);
    }
    const participantEvidenceRole = 'user';
    const threadEntityEvidenceRole = cancelled ? 'assistant' : 'user';
    putEntity({ tempId: 'mina', name: '민아', type: 'person', kind: 'person' }, turn, participantEvidenceRole);
    putEntity({ tempId: 'jiho', name: '지호', type: 'person', kind: 'person' }, turn, participantEvidenceRole);
    putEntity({ tempId: 'thread', name: '붉은 봉투', type: 'world', kind: 'thread' }, turn, threadEntityEvidenceRole);
    const status = fulfilled ? 'resolved' : cancelled ? 'closed' : 'open';
    const link = reaffirmed ? 'reaffirm' : fulfilled || cancelled ? 'resolve' : '';
    const resolution = fulfilled ? 'fulfilled' : cancelled ? 'cancelled' : '';
    const factText = turn === 5
      ? '민아는 지호에게 붉은 봉투의 편지를 직접 전달하기로 약속했다.'
      : turn === 40
        ? '민아는 붉은 봉투의 편지를 아직 전달하지 못했다고 재확인했다.'
        : turn === 105
          ? '민아는 붉은 봉투의 편지 전달 약속을 이행했다.'
          : '민아와 지호는 붉은 봉투 편지 전달 약속을 취소하기로 합의했다.';
    const thread = {
      summary: SUMMARY, status, kind: 'promise',
      participants: [
        { role: 'owner', personTempRef: 'mina' },
        { role: 'target', personTempRef: 'jiho' }
      ],
      ...(link ? { link } : {}), ...(resolution ? { resolution } : {}),
      ...(candidate?.alias ? { linkCandidateAlias: candidate.alias } : {})
    };
    facts.push({
      tempFactId: `letter_lifecycle_${turn}`, domain: 'narrative', subjectTempRef: 'thread', claimKind: 'thread',
      values: { thread }, text: factText, temporalRole: 'current_sequence', certainty: 'confirmed',
      evidenceSpans: [quote(turn, evidenceRole, selectedTurns)]
    });
  }
  return { schema: 'libra.canonical_artifact.v5', entities: [...entities.values()], facts };
};

const parseJson = raw => {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
};
const manifestRows = server => {
  const local = [...server.local.entries()].map(([key, raw]) => ({ key, raw, value: parseJson(raw), source: 'plugin' }));
  const remote = server.storedRows().map(row => ({ key: row.key, raw: row.raw, value: row.value, source: 'server' }));
  return [...local, ...remote].filter(row => row.key.endsWith(':manifest') && row.value?.schema === 'libra.manifest.v1');
};
const manifestForChat = (server, chatId) => {
  const rows = manifestRows(server).filter(row => row.value.chatId === chatId);
  assert.ok(rows.length, `durable ${chatId} manifest exists`);
  if (rows.length > 1) assert.equal(rows.at(-1).raw, rows[0].raw, `${chatId} mirror manifest bytes agree`);
  return rows[0].value;
};
const rawForKey = (server, key) => {
  if (server.local.has(key)) return server.local.get(key);
  const row = server.storedRows().find(item => item.key === key);
  return row?.raw;
};
const memoryForChat = (server, chatId, startTurn) => {
  const manifest = manifestForChat(server, chatId);
  const ref = manifest.memories?.[String(startTurn)];
  return ref ? parseJson(rawForKey(server, ref.key)) : null;
};
const committedBytesForChat = (server, chatId) => {
  const manifest = manifestForChat(server, chatId);
  const refs = Object.values(manifest.memories || {}).filter(ref => ref?.status === 'committed')
    .sort((a, b) => Number(a.turnRange?.start || 0) - Number(b.turnRange?.start || 0));
  const bytes = new Map(refs.map(ref => [ref.key, rawForKey(server, ref.key)]));
  assert.ok(refs.length, `${chatId} has committed canonical refs`);
  assert.ok([...bytes.values()].every(value => typeof value === 'string'), `${chatId} canonical source bytes are observable`);
  return { manifest, refs, bytes };
};
const readHead = async api => {
  const replay = await api.rebuildWorldManagerState();
  assert.equal(replay.ok, true, JSON.stringify({ code: replay.code, error: replay.error }));
  assert.ok(replay.head?.narrative, 'State readback returns the authority-derived narrative head');
  return replay.head;
};
const appendTurns = (chat, selected) => {
  chat.message.push(...messagesForTurns(selected));
  chat.messages = chat.message;
};
const branchAt40 = (parentChat, id, selected, cancellation) => {
  const child = branch(parentChat, 40, id);
  const forkTurns = selected.slice(40, 44).map(row => clone(row));
  if (cancellation) {
    forkTurns.push({
      turn: 45,
      user: { ref: 't45-u', text: FORK.user },
      assistant: { ref: 't45-a', text: FORK.assistant }
    });
  } else {
    forkTurns.push(clone(selected.find(row => row.turn === 45)));
  }
  appendTurns(child, forkTurns);
  return child;
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
const runBatchJob = async (api, expected, label, warningLedger) => {
  const result = await api.runManualColdStart();
  assert.equal(result.completed, expected, `${label} committed its contiguous batch range: ${JSON.stringify(result)}`);
  warningLedger.push({ label, rows: clone(result.stateWarnings || []) });
  return result;
};

(async () => {
  const outcomes = [];
  const startedAt = Date.now();
  const progress = (mode, phase, detail = {}) => console.log(JSON.stringify({
    record: 'fr_l4_letter_lifecycle_progress', mode, phase, elapsedMs: Date.now() - startedAt, ...detail
  }));
  for (const mode of MODES) {
    progress(mode, 'mode_start');
    const mainChat = makeChat('unified-chat', turns.slice(0, 5));
    const state = { current: mainChat, chats: [mainChat], character: null };
    state.character = { id: 'unified-char', chaId: 'unified-char', name: '민아', chatPage: 0, chats: state.chats };
    const rootBoundary = createRootBoundary();
    const server = await serverFixture({ mode, snapshot: { chat: mainChat }, host: { ...makeHost(state), getRootDocument: async () => rootBoundary.root } });
    progress(mode, 'server_fixture_ready');
    const f = server.f;
    try {
      const sourceRowsByTurn = new Map(turns.map(row => [row.turn, clone(row)]));
      const providerBatches = [];
      const providerCandidates = [];
      const stateWarningLedger = [];
      // The Micro producer runs its own provider job once per completed U+A, so this stub now
      // receives two prompt kinds. Only the Librarian/Canonical call is the five-pair batch the
      // assertions below track; a Micro call is answered with a source-only envelope so it does not
      // pollute `providerBatches` (that mistake is what made the reroll assertion see []).
      const providerMicroCalls = [];
      const isMicroCall = args => JSON.stringify(args || '').includes('LIBRA MICRO SOURCE CONTRACT');
      const microEnvelope = args => {
        const input = JSON.parse((args?.[0]?.messages || []).find(row => row.role === 'user')?.content || '{}');
        const assistant = String(input?.assistant?.text || '');
        const quote = assistant.slice(0, Math.min(2, assistant.length));
        const claims = quote ? [{
          changeKind: 'world', text: quote + '이다.', actor: '', target: '',
          temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'none',
          evidence: { role: 'assistant', messageId: input.assistant?.messageId || '',
            startOffset: 0, endOffset: quote.length, exactQuote: quote }
        }] : [];
        const envelope = { schema: 'libra.micro_producer_envelope.v1',
          personCandidates: { spans: [], relations: [] },
          micro: { schema: 'libra.micro_memory.v1', ...(input.binding || {}), claims } };
        return { type: 'success', result: JSON.stringify(envelope) };
      };
      f.control.onCall = args => {
        if (isMicroCall(args)) {
          providerMicroCalls.push(Number(quotedTurns(args)[0] || 0));
          return microEnvelope(args);
        }
        const batchTurns = quotedTurns(args);
        assert.equal(batchTurns.length, 5, `one provider call receives exactly five source pairs (${batchTurns.join(',')})`);
        const start = batchTurns[0];
        assert.deepEqual(batchTurns, [start, start + 1, start + 2, start + 3, start + 4]);
        const candidates = candidateRowsFromPrompt(args);
        providerBatches.push(start);
        providerCandidates.push(candidates);
        const childCancellation = state.current.id === 'thread-lifecycle-child-cancel' && start === 41;
        const selectedTurns = batchTurns.map(turn => {
          const source = clone(sourceRowsByTurn.get(turn));
          if (childCancellation && turn === FORK.child_at_turn) {
            source.user.text = FORK.user;
            source.assistant.text = FORK.assistant;
          }
          return source;
        });
        return { type: 'success', result: JSON.stringify(makeArtifact(selectedTurns, { candidateRows: candidates, childCancellation })) };
      };

      let phaseAt = Date.now();
      progress(mode, 'batch_T1_T5_start');
      await runBatchJob(f.r.api, 1, `${mode} T1–T5`, stateWarningLedger);
      progress(mode, 'batch_T1_T5_done', { phaseElapsedMs: Date.now() - phaseAt, batches: providerBatches.length });
      assert.deepEqual(providerBatches, [1]);
      const at5 = await readHead(f.r.api);
      assert.equal(at5.throughTurn, 5);
      assert.equal(at5.narrative.threads.length, 1, JSON.stringify({ at5, memory: memoryForChat(server, 'unified-chat', 1)?.canonicalArtifact, warnings: stateWarningLedger }));
      const firstThread = at5.narrative.threads[0];
      assert.equal(firstThread.status, 'open');
      const at5Memory = memoryForChat(server, 'unified-chat', 1);
      assert.equal(at5Memory.canonicalArtifact.facts.find(row => row.claimKind === 'thread')?.values.thread.linkStatus, 'new');

      appendTurns(mainChat, turns.slice(5, 40));
      phaseAt = Date.now();
      progress(mode, 'batch_T6_T40_start', { batchesBefore: providerBatches.length });
      await runBatchJob(f.r.api, 7, `${mode} T6–T40`, stateWarningLedger);
      progress(mode, 'batch_T6_T40_done', { phaseElapsedMs: Date.now() - phaseAt, batches: providerBatches.length });
      assert.deepEqual(providerBatches, [1, 6, 11, 16, 21, 26, 31, 36]);
      const at40 = await readHead(f.r.api);
      assert.equal(at40.throughTurn, 40);
      assert.equal(at40.narrative.threads.length, 1);
      assert.equal(at40.narrative.threads[0].lifecycleId, firstThread.lifecycleId);
      assert.equal(at40.narrative.threads[0].status, 'open');
      const at40Memory = memoryForChat(server, 'unified-chat', 36);
      const reaffirmed = at40Memory.canonicalArtifact.facts.find(row => row.claimKind === 'thread')?.values.thread;
      assert.equal(reaffirmed.linkStatus, 'accepted');
      assert.equal(reaffirmed.link, 'reaffirm');
      assert.equal(reaffirmed.lifecycleId, firstThread.lifecycleId);
      assert.equal(reaffirmed.linkTarget.cursor.turnRange.start, 1);

      appendTurns(mainChat, turns.slice(40));
      phaseAt = Date.now();
      progress(mode, 'batch_T41_T105_start', { batchesBefore: providerBatches.length });
      await runBatchJob(f.r.api, 13, `${mode} T41–T105`, stateWarningLedger);
      progress(mode, 'batch_T41_T105_done', { phaseElapsedMs: Date.now() - phaseAt, batches: providerBatches.length });
      assert.deepEqual(providerBatches, Array.from({ length: 21 }, (_, index) => 1 + index * 5));
      // Micro issues its own provider job per completed U+A, so the total grows; the guarantee here is
      // that the Canonical/Librarian pass still runs exactly once per real batch.
      assert.equal(countCalls(f.control).canonical, 21, `${mode} used one controlled existing-provider call per real batch`);
      assert.equal(providerBatches.at(-1), 101, `${mode} did not skip the prefix before T105`);
      const parentBytes = committedBytesForChat(server, 'unified-chat');
      assert.equal(parentBytes.refs.length, 21);
      assert.deepEqual(parentBytes.refs.map(ref => ref.turnRange.start), Array.from({ length: 21 }, (_, index) => 1 + index * 5));
      const at105 = await readHead(f.r.api);
      assert.equal(at105.throughTurn, 105);
      assert.equal(at105.narrative.threads.length, 0, 'the fulfilled promise is absent from current obligations');
      const fulfillmentMemory = memoryForChat(server, 'unified-chat', 101);
      const fulfillment = fulfillmentMemory.canonicalArtifact.facts.find(row => row.claimKind === 'thread')?.values.thread;
      assert.equal(fulfillment.linkStatus, 'accepted');
      assert.equal(fulfillment.link, 'resolve');
      assert.equal(fulfillment.resolution, 'fulfilled');
      assert.equal(fulfillment.lifecycleId, firstThread.lifecycleId);

      // Public History must derive T5 → T40 → T105 from canonical evidence, not dates.
      const history = await f.r.api.getWorldManagerHistoryDetail({
        memoryId: fulfillmentMemory.memoryId, revision: fulfillmentMemory.revision
      });
      const lifecycleEvents = history.semanticTimeline?.events?.filter(event => event.threadLifecycleId === firstThread.lifecycleId) || [];
      assert.deepEqual(Array.from(lifecycleEvents, event => event.type), ['created', 'reaffirmed', 'resolved']);
      assert.deepEqual(Array.from(lifecycleEvents, event => event.canonicalCursor?.turnRange?.start), [1, 36, 101]);
      assert.deepEqual(Array.from(lifecycleEvents, event => event.evidenceSpans?.[0]?.ref), ['t5-u', 't40-a', 't105-a']);
      assert.ok(lifecycleEvents.every(event => event.evidenceSpans?.length > 0 && event.itemIdentity),
        'each semantic transition points to direct canonical source evidence and one item identity');

      const settings = await f.r.api.getLibraMemorySettings();
      await f.r.api.saveLibraMemorySettings({ ...(settings?.settings || settings || {}), recallMaxMemories: 1 });
      const pastQuery = transcriptFixture.queries[0].text;
      const pastRecall = await f.r.api.previewUnifiedMemoryRecall(pastQuery);
      const pastPacket = await f.r.api.prepareInputWriterEvidence(pastQuery);
      progress(mode, 'historical_recall_and_packet_readback');
      const pastRows = canonicalPacketRows(pastPacket);
      const t5PromiseText = at5Memory.canonicalArtifact.facts.find(fact => fact.claimKind === 'thread').text;
      assert.equal(pastRecall.diagnostics?.temporalAnchor?.status, 'resolved',
        'an explicit T5 historical request resolves to one active canonical cursor');
      assert.equal(pastRecall.diagnostics?.temporalAnchor?.requestedTurn, 5);
      assert.ok(pastRecall.memories.some(row => row.memory.turnRange?.start === 1),
        `the historical T5 question selects the original canonical promise memory: ${JSON.stringify({ memories: pastRecall.memories.map(row => ({ start: row.memory.turnRange?.start, text: row.text || row.excerpt })), diagnostics: pastRecall.diagnostics, packet: pastRows.map(row => ({ start: row.turnRange?.start, text: row.text, closure: row.closure })) })}`);
      assert.ok(pastRows.some(row => row.text.includes(t5PromiseText)),
        `the historical Input Writer packet contains the T5 promise fact: ${JSON.stringify({ anchor: pastPacket.evidencePacket?.temporal_scope, recall: pastRecall.memories.map(row => ({ start: row.memory.turnRange?.start, excerpt: row.text || row.excerpt })), rows: pastRows.map(row => ({ start: row.turnRange?.start, layer: row.section, text: row.text, closure: row.closure })) })}`);
      assert.equal(pastRecall.diagnostics?.recallContinuityClosure?.asOfTurn, 5,
        'cross-artifact closure keeps the requested historical cursor');
      assert.equal(pastRecall.diagnostics?.recallContinuityClosure?.diagnostics?.closureCount, 0,
        'a later fulfillment is not attached to the historical T5 answer');
      assert.equal(pastRows.some(row => row.closure === true && row.text.includes(fulfillmentMemory.canonicalArtifact.facts.find(fact => fact.claimKind === 'thread').text)), false,
        'the historical Input Writer packet does not re-inject the T105 fulfillment as closure');
      assert.equal(pastPacket.evidencePacket?.temporal_scope?.status, 'resolved',
        'the requested T5 scope reaches the final Input Writer packet');
      assert.equal(pastPacket.evidencePacket?.temporal_scope?.sourceEvidenceCutoffTurn, 5);
      assert.ok(pastPacket.evidencePacket?.temporal_scope?.turnRange?.start === 1
        && pastPacket.evidencePacket?.temporal_scope?.turnRange?.end === 5,
      'the packet carries the canonical batch cursor without exposing persistent identity fields');

      // A turn inside a five-pair canonical batch is bounded by source evidence spans,
      // not by the containing batch end. T17 must not inherit T18–T20 facts.
      const midBatchQuery = 'T17 당시 기록실에서 이어진 대화 내용을 알려줘.';
      const midBatchRecall = await f.r.api.previewUnifiedMemoryRecall(midBatchQuery);
      assert.equal(midBatchRecall.diagnostics?.temporalAnchor?.status, 'resolved');
      assert.equal(midBatchRecall.diagnostics?.temporalAnchor?.requestedTurn, 17);
      assert.equal(JSON.stringify(midBatchRecall.diagnostics?.temporalAnchor?.turnRange), JSON.stringify({ start: 16, end: 20 }));
      const midBatchText = midBatchRecall.memories.map(row => row.text || row.excerpt || '').join('\n');
      assert.match(midBatchText, /대화 17/);
      assert.doesNotMatch(midBatchText, /대화 (?:18|19|20)/,
        'same-artifact fact selection, closure dependencies, and final excerpts honor exact source-turn cutoff');
      const midBatchPacket = await f.r.api.prepareInputWriterEvidence(midBatchQuery);
      const midBatchRows = canonicalPacketRows(midBatchPacket);
      assert.equal(midBatchPacket.evidencePacket?.temporal_scope?.sourceEvidenceCutoffTurn, 17);
      assert.doesNotMatch(midBatchRows.map(row => row.text).join('\n'), /대화 (?:18|19|20)/);
      const currentQuery = transcriptFixture.queries[1].text;
      const currentRecall = await f.r.api.previewUnifiedMemoryRecall(currentQuery);
      const currentPacket = await f.r.api.prepareInputWriterEvidence(currentQuery);
      progress(mode, 'current_recall_and_packet_readback');
      const currentRows = canonicalPacketRows(currentPacket);
      assert.ok(currentRecall.memories.length > 0, 'the current-status question returns actual Recall evidence');
      assert.ok(currentRows.some(row => row.text.includes(fulfillmentMemory.canonicalArtifact.facts.find(fact => fact.claimKind === 'thread').text)),
        'the current Input Writer packet includes the fulfilled successor, whether Recall selects it directly or closure adds it');
      assert.ok(currentRecall.diagnostics?.recallContinuityClosure?.currentness === 'current'
        || currentRecall.diagnostics?.recallContinuityClosure?.currentness === 'last-known',
        'Recall reports observed currentness or its honest last-known limit');

      // Cold replay reads the same stored canonical bytes and makes no provider call.
      const initialCanonicalArtifactBytes = new Map(parentBytes.refs.map(ref => [
        ref.key, storedJsonFieldBytes(parentBytes.bytes.get(ref.key), 'canonicalArtifact')
      ]));
      let settleAttempts = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        settleAttempts = attempt + 1;
        const pendingEmbedding = parentBytes.refs.some(ref => ['pending', 'retry_pending'].includes(
          String(parseJson(rawForKey(server, ref.key))?.embedding?.status || '')
        ));
        if (!pendingEmbedding) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      progress(mode, 'bounded_settle_poll_done', { attempts: settleAttempts });
      const fullMemoryBeforeReplay = parentBytes.refs.map(ref => ({
        key: ref.key,
        turnStart: Number(ref.turnRange?.start || 0),
        raw: rawForKey(server, ref.key),
        value: parseJson(rawForKey(server, ref.key))
      }));
      const canonicalArtifactBytesBeforeReplay = new Map(fullMemoryBeforeReplay.map(row => [
        row.key, storedJsonFieldBytes(row.raw, 'canonicalArtifact')
      ]));
      assert.deepEqual(Array.from(canonicalArtifactBytesBeforeReplay), Array.from(initialCanonicalArtifactBytes),
        'Recall and read operations preserve exact canonicalArtifact bytes before replay');
      const wrapperChangesBeforeReplay = parentBytes.refs.flatMap(ref => {
        const before = parentBytes.bytes.get(ref.key), after = rawForKey(server, ref.key);
        if (before === after) return [];
        const beforeValue = parseJson(before), afterValue = parseJson(after);
        const fields = [...new Set([...Object.keys(beforeValue || {}), ...Object.keys(afterValue || {})])]
          .filter(field => JSON.stringify(beforeValue?.[field]) !== JSON.stringify(afterValue?.[field])).sort();
        return [{ turnStart: Number(ref.turnRange?.start || 0), fields,
          embeddingBefore: String(beforeValue?.embedding?.status || ''), embeddingAfter: String(afterValue?.embedding?.status || '') }];
      });
      const bytesBeforeReplay = new Map(fullMemoryBeforeReplay.map(row => [row.key, row.raw]));
      const callsBeforeReplay = f.control.calls.length;
      const replay = await f.r.api.rebuildWorldManagerState();
      progress(mode, 'cold_replay_done');
      assert.equal(replay.ok, true, JSON.stringify({ code: replay.code, error: replay.error }));
      assert.equal(replay.providerCalls, 0);
      assert.equal(f.control.calls.length, callsBeforeReplay);
      const canonicalArtifactBytesAfterReplay = new Map(parentBytes.refs.map(ref => [
        ref.key, storedJsonFieldBytes(rawForKey(server, ref.key), 'canonicalArtifact')
      ]));
      assert.deepEqual(Array.from(canonicalArtifactBytesAfterReplay), Array.from(canonicalArtifactBytesBeforeReplay),
        `${mode} cold replay preserves exact canonicalArtifact bytes`);
      const wrapperChangesDuringReplay = parentBytes.refs.flatMap(ref => {
        const before = bytesBeforeReplay.get(ref.key), after = rawForKey(server, ref.key);
        if (before === after) return [];
        const beforeValue = parseJson(before), afterValue = parseJson(after);
        const fields = [...new Set([...Object.keys(beforeValue || {}), ...Object.keys(afterValue || {})])]
          .filter(field => JSON.stringify(beforeValue?.[field]) !== JSON.stringify(afterValue?.[field])).sort();
        return [{ turnStart: Number(ref.turnRange?.start || 0), fields,
          embeddingBefore: String(beforeValue?.embedding?.status || ''), embeddingAfter: String(afterValue?.embedding?.status || '') }];
      });
      assert.equal(replay.head?.throughTurn, 105);
      assert.equal(replay.head?.narrative?.threads?.length, 0);

      // A native child forked at T40 cancels only its own inherited promise.
      const child = branchAt40(mainChat, 'thread-lifecycle-child-cancel', turns, true);
      state.chats.push(child);
      state.character.chats = state.chats;
      state.current = child;
      const lineage = await f.r.api.getHostLineageStatus();
      assert.equal(lineage.status, 'verified', `${mode} child branch has a verified native prefix`);
      assert.equal(lineage.commonPrefixPairs, 40);
      const copy = await f.r.api.debugNativeChatCopy({ force: true });
      assert.equal(copy.result?.ok, true, JSON.stringify(copy.result));
      const childJob = await runBatchJob(f.r.api, 1, `${mode} native child T41–T45 cancellation`, stateWarningLedger);
      progress(mode, 'child_branch_batch_done');
      assert.equal(childJob.completed, 1);
      const childMemory = committedBytesForChat(server, child.id);
      const childOutcome = JSON.parse(rawForKey(server, childMemory.refs.at(-1).key)).canonicalArtifact.facts
        .find(row => row.claimKind === 'thread')?.values.thread;
      assert.equal(childOutcome.linkStatus, 'accepted', JSON.stringify({ childOutcome, childFacts: parseJson(rawForKey(server, childMemory.refs.at(-1).key))?.canonicalArtifact?.facts, candidates: providerCandidates.at(-1) }));
      assert.equal(childOutcome.resolution, 'cancelled');
      const childHead = await readHead(f.r.api);
      assert.equal(childHead.narrative.threads.length, 0, 'the child cancellation closes the inherited obligation in the child State');

      // A sibling copied from the same T40 prefix remains open; the parent remains fulfilled.
      const sibling = branchAt40(mainChat, 'thread-lifecycle-sibling-open', turns, false);
      state.chats.push(sibling);
      state.current = sibling;
      const siblingLineage = await f.r.api.getHostLineageStatus();
      assert.equal(siblingLineage.status, 'verified');
      assert.equal(siblingLineage.commonPrefixPairs, 40);
      const siblingCopy = await f.r.api.debugNativeChatCopy({ force: true });
      assert.equal(siblingCopy.result?.ok, true, JSON.stringify(siblingCopy.result));
      await runBatchJob(f.r.api, 1, `${mode} native sibling T41–T45 neutral continuation`, stateWarningLedger);
      progress(mode, 'sibling_branch_batch_done');
      const siblingHead = await readHead(f.r.api);
      assert.equal(siblingHead.narrative.threads.length, 1);
      assert.equal(siblingHead.narrative.threads[0].status, 'open');
      assert.equal(siblingHead.narrative.threads[0].lifecycleId, firstThread.lifecycleId);

      state.current = mainChat;
      const parentAfterBranches = await readHead(f.r.api);
      assert.equal(parentAfterBranches.narrative.threads.length, 0, 'native child/sibling work did not alter parent fulfillment');
      for (const [key, bytes] of bytesBeforeReplay) assert.equal(rawForKey(server, key), bytes, `${mode} branch operations preserve parent canonical bytes`);

      // Replace only T105's source pair. The old fulfilled revision stays byte-identical;
      // replay of the selected new revision returns the promise to its open state.
      sourceRowsByTurn.set(105, {
        turn: 105,
        user: { ref: 't105-u', text: REROLL.user },
        assistant: { ref: 't105-a', text: REROLL.assistant }
      });
      const user105 = mainChat.message.find(row => row.chatId === 't105-u');
      const assistant105 = mainChat.message.find(row => row.chatId === 't105-a');
      user105.data = REROLL.user;
      assistant105.data = REROLL.assistant;
      const oldFulfillmentRef = parentBytes.manifest.memories['101'];
      const oldFulfillmentBytes = bytesBeforeReplay.get(oldFulfillmentRef.key);
      providerBatches.length = 0;
      const callsBeforeReroll = countCalls(f.control).canonical;
      await f.r.sourceEditBoundary();
      progress(mode, 'source_edit_revision_readback_done');
      assert.deepEqual(providerBatches, [101], 'reroll reprocesses only the changed contiguous final five-pair batch');
      assert.equal(countCalls(f.control).canonical, callsBeforeReroll + 1,
        'the approved source-edit boundary uses exactly one existing-provider call for T101–T105');
      const rerolledHead = await readHead(f.r.api);
      assert.equal(rerolledHead.throughTurn, 105);
      assert.equal(rerolledHead.narrative.threads.length, 1);
      assert.equal(rerolledHead.narrative.threads[0].lifecycleId, firstThread.lifecycleId);
      assert.equal(rerolledHead.narrative.threads[0].status, 'open');
      assert.equal(rawForKey(server, oldFulfillmentRef.key), oldFulfillmentBytes,
        'the inactive fulfilled canonical revision remains byte-identical after the reroll');
      const rerollManifest = manifestForChat(server, 'unified-chat');
      assert.ok(rerollManifest.memories['101'].revision > oldFulfillmentRef.revision,
        'the active final batch advances the slot revision for the reroll');
      assert.notEqual(rerollManifest.memories['101'].sourceDigest, oldFulfillmentRef.sourceDigest,
        'the active final batch binds the changed reroll source');
      assert.equal(JSON.parse(rawForKey(server, rerollManifest.memories['101'].key)).canonicalArtifact.facts
        .some(row => row.claimKind === 'thread' && row.values.thread.resolution === 'fulfilled'), false,
        'the failed delivery artifact does not retain an active fulfillment');

      // A repeated local turn number in a distinct active session epoch is ambiguous:
      // do not select one cursor as T5 or certify an unconstrained closure as the answer.
      const manifestKey = [...server.local.keys()].find(key => key.endsWith(':manifest'))
        || server.storedRows().find(row => row.key.endsWith(':manifest') && row.value?.chatId === 'unified-chat')?.key;
      assert.ok(manifestKey, `${mode} manifest key is available for the local cursor-ambiguity fixture`);
      const ambiguousManifest = clone(manifestForChat(server, 'unified-chat'));
      const activeT5Ref = clone(ambiguousManifest.memories['1']);
      const duplicateEpochMemoryId = `mem_prior_session_t5_${mode}`;
      const duplicateEpochRevision = 2;
      const duplicateEpochKey = `libra:v1:scope:${ambiguousManifest.scopeKey}:memory:1:r${duplicateEpochRevision}`;
      const duplicateEpochRef = {
        ...activeT5Ref,
        key: duplicateEpochKey,
        memoryId: duplicateEpochMemoryId,
        revision: duplicateEpochRevision,
        sessionEpoch: -1,
        inheritedSessionHistory: true,
        inherited: true
      };
      const duplicateEpochMemory = {
        ...clone(parseJson(rawForKey(server, activeT5Ref.key))),
        memoryId: duplicateEpochMemoryId,
        revision: duplicateEpochRevision,
        sessionEpoch: -1,
        inheritedSessionHistory: true,
        inherited: true
      };
      if (mode !== 'plugin_only') await server.mutate(duplicateEpochKey, duplicateEpochMemory);
      if (mode !== 'server_only') server.local.set(duplicateEpochKey, JSON.stringify(duplicateEpochMemory));
      ambiguousManifest.inheritedMemories = [...(ambiguousManifest.inheritedMemories || []), duplicateEpochRef];
      if (mode !== 'plugin_only') await server.mutate(manifestKey, ambiguousManifest);
      if (server.local.has(manifestKey)) server.local.set(manifestKey, JSON.stringify(ambiguousManifest));
      const ambiguousRecall = await f.r.api.previewUnifiedMemoryRecall(pastQuery);
      assert.equal(ambiguousRecall.diagnostics?.temporalAnchor?.status, 'ambiguous');
      assert.equal(ambiguousRecall.diagnostics?.temporalAnchor?.candidateCount, 2);
      assert.equal(ambiguousRecall.diagnostics?.recallContinuityClosure?.currentness, 'unknown');
      assert.equal(ambiguousRecall.diagnostics?.recallContinuityClosure?.closureComplete, false);
      assert.ok(ambiguousRecall.diagnostics?.recallContinuityClosure?.diagnostics?.reasons?.includes('temporal_anchor_ambiguous'));
      const ambiguousPacket = await f.r.api.prepareInputWriterEvidence(pastQuery);
      progress(mode, 'ambiguity_guard_readback_done');
      assert.equal(ambiguousPacket.evidencePacket?.temporal_scope?.status, 'ambiguous');
      assert.equal(ambiguousPacket.evidencePacket?.temporal_scope?.candidateCount, 2);

      const finalBytes = committedBytesForChat(server, 'unified-chat');
      const summary = {
        mode,
        actualBatches: { t5: 1, t6To40: 7, t41To105: 13, total: 21, starts: Array.from({ length: 21 }, (_, i) => 1 + i * 5) },
        milestones: { t5: 'open/new', t40: 'same lifecycle/reaffirmed/open', t105: 'same lifecycle/fulfilled/closed' },
        queryEvidence: { historical: 'T5 direct promise in Recall/Input Writer', current: 'T105 fulfilled closure in Input Writer' },
        semanticHistory: Array.from(lifecycleEvents, event => ({ type: event.type, start: event.canonicalCursor.turnRange.start })),
        coldReplay: {
          providerCalls: replay.providerCalls,
          canonicalArtifactBytesUnchanged: true,
          fullWrapperBytesUnchanged: wrapperChangesDuringReplay.length === 0,
          wrapperChangesDuringBackgroundSettle: wrapperChangesBeforeReplay,
          wrapperChangesDuringReplay
        },
        child: { resolution: 'cancelled', parentUnchanged: true, siblingStatus: siblingHead.narrative.threads[0].status },
        reroll: { finalState: 'open', oldFulfillmentBytesPreserved: true, activeFulfillment: false },
        historicalScope: {
          t5: { status: pastRecall.diagnostics.temporalAnchor.status, sourceCutoffTurn: pastPacket.evidencePacket.temporal_scope.sourceEvidenceCutoffTurn, laterFulfillmentClosure: false },
          t17: { status: midBatchRecall.diagnostics.temporalAnchor.status, sourceCutoffTurn: midBatchPacket.evidencePacket.temporal_scope.sourceEvidenceCutoffTurn, laterSameBatchFactsExcluded: true },
          duplicateEpoch: { status: ambiguousRecall.diagnostics.temporalAnchor.status, candidateCount: ambiguousRecall.diagnostics.temporalAnchor.candidateCount, currentness: ambiguousRecall.diagnostics.recallContinuityClosure.currentness }
        },
        currentBatchCountAfterReroll: Object.keys(rerollManifest.memories || {}).length,
        activeCanonicalBytesAfterReroll: finalBytes.bytes.size,
        stateWarnings: stateWarningLedger
      };
      outcomes.push(summary);
    } finally {
      await server.cleanup();
      progress(mode, 'mode_cleanup_done');
    }
  }
  for (const row of outcomes) console.log(JSON.stringify({
    schema: 'acceptance.action_result.v1', case_id: 'A12', mode: row.mode,
    action: A12_ACTION, assertion_result: true,
    observed: 'T5 lifecycle was selected by the T40 request-local alias, validated as the same accepted lifecycle, and recorded as reaffirmed in canonical History.'
  }));
  for (const row of outcomes) console.log(JSON.stringify({
    schema: 'acceptance.action_result.v1', case_id: 'A17', mode: row.mode,
    action: A17_ACTION, assertion_result: true,
    observed: 'All 21 consecutive five-pair batches reached T105; the promise opened at T5, reaffirmed at T40, fulfilled at T105, rerolled to open, and cancelled only on the native T40 child while parent and sibling stayed unchanged.'
  }));
  for (const row of outcomes) console.log(JSON.stringify({
    schema: 'acceptance.action_result.v1', case_id: 'A18', mode: row.mode,
    action: A18_ACTION, assertion_result: true,
    observed: 'Historical T5 Recall/Input Writer preserved the original promise without later fulfillment; current Recall/Input Writer included the T105 fulfillment with its evidence-time cutoff.'
  }));
  console.log(JSON.stringify({ test: 'libra_main_memory_letter_lifecycle_105turn', sourcePairs: turns.length,
    modes: outcomes, liveProviderCalls: 0, liveHostTrial: false }));
})().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
