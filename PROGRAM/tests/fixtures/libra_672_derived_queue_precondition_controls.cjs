'use strict';
// Finite helper-only controls. No VM, product, HTTP, SQLite or provider imports.
const assert = require('node:assert/strict');
const { prepare672DerivedQueue } = require('./libra_672_derived_queue_precondition.cjs');
const { readActualCanonicalDelivery } = require('./libra_actual_canonical_delivery.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const scope = 'fixture-672-scope';
const prefix = `libra:v1:scope:${scope}:`;
const manifestKey = prefix + 'manifest';
const headKey = prefix + 'continuity-state';
const memoryKey = start => prefix + `memory:${start}:r1`;

function fixture({ pending = 2, timerWins = false, mutate = null, resultMutate = null } = {}) {
  const memories = [1, 6].map(start => ({
    memoryId: `mem_${start}`, revision: 1, scopeKey: scope,
    sourceDigest: `source-${start}`, artifactDigest: `artifact-${start}`,
    artifactSchema: 'libra.canonical_artifact.v5', status: 'committed',
    turnRange: { start, end: start + 4 },
    canonicalArtifact: { schema: 'libra.canonical_artifact.v5', facts: [
      { text: '민아는 민트차를 좋아한다.' }, { text: '열쇠 반환 약속이 이행되었다.' }
    ] },
    embedding: start === 1 && pending < 2 || pending === 0
      ? { status: 'disabled', reason: 'API Key', vectorCount: 0 }
      : { status: 'pending' }
  }));
  const manifest = { scopeKey: scope, characterId: 'char', chatId: 'chat',
    memories: Object.fromEntries(memories.map(memory => [memory.turnRange.start, {
      memoryId: memory.memoryId, key: memoryKey(memory.turnRange.start),
      revision: memory.revision, sourceDigest: memory.sourceDigest,
      artifactDigest: memory.artifactDigest, artifactSchema: memory.artifactSchema,
      status: memory.status, turnRange: memory.turnRange,
      embeddingStatus: memory.embedding.status, vectorCount: 0
    }])), frontiers: { committedTurn: 10 } };
  const head = { schema: 'libra.continuity_state.v2', scopeKey: scope,
    status: 'ready', throughTurn: 10, domainStatus: { narrative: { status: 'ready', throughTurn: 10 } } };
  const local = new Map([[manifestKey, JSON.stringify(manifest)], [headKey, JSON.stringify(head)],
    ...memories.map(memory => [memoryKey(memory.turnRange.start), JSON.stringify(memory)])]);
  const server = new Map([...local].map(([key, raw]) => [key, { key, raw, value: JSON.parse(raw), revision: 1 }]));
  const settings = { enabled: true, key: '', provider: 'voyageai', model: 'voyage-4-lite' };
  const snapshot = { local, server, url: 'http://127.0.0.1:12345', requests: [],
    storedRows: () => [...server.values()].map(copy),
    f: { chat: { id: 'chat', chatId: 'chat', message: [{ data: 'synthetic source' }] },
      character: { id: 'char', chaId: 'char', chatPage: 0 },
      control: { calls: [], hooks: {} }, r: { api: {} } } };
  const write = (key, value) => {
    const raw = JSON.stringify(value); local.set(key, raw);
    server.set(key, { key, raw, value: copy(value), revision: (server.get(key)?.revision || 0) + 1 });
  };
  const change = (key, fn) => { const value = JSON.parse(local.get(key)); fn(value); write(key, value); };
  let queueCalls = 0;
  snapshot.f.r.api = {
    getEmbeddingSettings: async () => copy(settings),
    getUnifiedStateReadProjection: value => ({ status: value.status, throughTurn: value.throughTurn, domainStatus: value.domainStatus }),
    retryPendingUnifiedVectors: async () => {
      queueCalls++;
      const selected = memories.filter(memory => memory.embedding.status === 'pending');
      for (const memory of selected) {
        change(memoryKey(memory.turnRange.start), value => { value.embedding = { status: 'disabled', reason: 'API Key', vectorCount: 0 }; });
        change(manifestKey, value => { value.memories[memory.turnRange.start].embeddingStatus = 'disabled'; });
      }
      const result = { ok: true, attempted: timerWins ? 0 : selected.length,
        completed: timerWins ? 0 : selected.length,
        results: timerWins ? [] : selected.map(memory => ({ memoryId: memory.memoryId, status: 'disabled', diagnostic: null })) };
      if (mutate) mutate({ snapshot, write, change, settings, memories });
      if (resultMutate) resultMutate(result);
      return result;
    }
  };
  return { snapshot, memories: copy(memories), queueCalls: () => queueCalls };
}

const negatives = [
  ['failed queue', { resultMutate: result => { result.ok = false; } }],
  ['stale queue', { resultMutate: result => { result.staleDiscarded = true; } }],
  ['failed result diagnostic', { resultMutate: result => { result.results[0].diagnostic = { ok: false }; } }],
  ['stale result diagnostic', { resultMutate: result => { result.results[0].diagnostic = { staleDiscarded: true }; } }],
  ['partial queue', { resultMutate: result => { result.completed = 1; } }],
  ['unbounded attempt count', { resultMutate: result => { result.attempted = 3; result.completed = 3; } }],
  ['unknown returned identity', { resultMutate: result => { result.results[0].memoryId = 'unexpected'; } }],
  ['duplicate returned identity', { resultMutate: result => { result.results[1].memoryId = result.results[0].memoryId; } }],
  ['wrong returned status', { resultMutate: result => { result.results[0].status = 'ready'; } }],
  ['no progress', { mutate: ({ change }) => {
    change(manifestKey, value => { for (const ref of Object.values(value.memories)) ref.embeddingStatus = 'pending'; });
    for (const start of [1, 6]) change(memoryKey(start), value => { value.embedding = { status: 'pending' }; });
  } }],
  ['retry pending ref', { mutate: ({ change }) => { change(manifestKey, value => { value.memories[6].embeddingStatus = 'retry_pending'; }); } }],
  ['pending memory', { mutate: ({ change }) => { change(memoryKey(6), value => { value.embedding.status = 'pending'; }); } }],
  ['leftover transaction with successful zero-attempt result', { pending: 0, mutate: ({ write, memories }) => {
    write(prefix + 'entity-registry:v2:unified-vector-tx:mem_6:1:config', {
      schema: 'libra.unified_server_vector_tx.v1', scopeKey: scope,
      memoryKey: memoryKey(6), artifactDigest: memories[1].artifactDigest
    });
  } }],
  ['new identity', { mutate: ({ change }) => { change(manifestKey, value => { value.memories[11] = copy(value.memories[6]); }); } }],
  ['changed memory identity', { mutate: ({ change }) => { change(memoryKey(6), value => { value.memoryId = 'new-memory'; }); } }],
  ['changed source digest', { mutate: ({ change }) => { change(memoryKey(6), value => { value.sourceDigest = 'new-source'; }); } }],
  ['changed canonical bytes', { mutate: ({ change }) => { change(memoryKey(6), value => { value.canonicalArtifact.facts[0].text += 'changed'; }); } }],
  ['changed Head bytes', { mutate: ({ change }) => { change(headKey, value => { value.domainStatus.narrative.status = 'stale'; }); } }],
  ['changed Head physical revision only', { mutate: ({ snapshot }) => { snapshot.server.get(headKey).revision++; } }],
  ['changed source text', { mutate: ({ snapshot }) => { snapshot.f.chat.message[0].data += 'changed'; } }],
  ['wrong chat identity', { mutate: ({ snapshot }) => { snapshot.f.chat.chatId = 'other'; } }],
  ['changed manifest authority', { mutate: ({ change }) => { change(manifestKey, value => { value.frontiers.committedTurn = 11; }); } }],
  ['unexpected canonical provider', { mutate: ({ snapshot }) => { snapshot.f.control.calls.push(['LIBRA LONG-TERM MEMORY EXTRACTION']); } }],
  ['unexpected Micro provider', { mutate: ({ snapshot }) => { snapshot.f.control.calls.push(['LIBRA MICRO SOURCE CONTRACT']); } }],
  ['unexpected other provider', { mutate: ({ snapshot }) => { snapshot.f.control.calls.push(['other']); } }],
  ['unexpected embedding/network request', { mutate: ({ snapshot }) => { snapshot.requests.push({ url: 'https://example.invalid/embeddings' }); } }],
  ['changed embedding configuration', { mutate: ({ settings }) => { settings.model = 'other'; } }],
  ['wrong disabled reason', { mutate: ({ change }) => { change(memoryKey(6), value => { value.embedding.reason = 'other'; }); } }],
  ['nonzero vector count', { mutate: ({ change }) => { change(memoryKey(6), value => { value.embedding.vectorCount = 1; }); } }],
  ['wrong scope', { mutate: ({ change }) => { change(manifestKey, value => { value.scopeKey = 'other'; }); } }]
];

async function rejectHookMutationAfterPreparation(kind) {
  const x = fixture();
  await prepare672DerivedQueue(x.snapshot, { expectedMemories: x.memories });
  const memory = x.memories[1], query = 'fixture-query';
  const text = memory.canonicalArtifact.facts.map(fact => fact.text).join('\n');
  const ref = { key: memoryKey(6), memoryId: memory.memoryId, revision: memory.revision,
    sourceDigest: memory.sourceDigest, artifactDigest: memory.artifactDigest };
  const context = { requestId: 'new', route: 'classic', scopeKey: scope,
    contextDigest: 'seal', canonicalRefs: [ref], values: { currentInput: query } };
  const viewer = { scopeKey: scope, queryText: query, responseContextRequestId: 'new',
    responseContextDigest: 'seal', rows: [{ ...ref, memoryKey: ref.key, scopeKey: scope,
      kind: 'canonical', classicUsed: true, injected: true, selectedText: text }] };
  let published = false;
  Object.assign(x.snapshot.f.r.api, { getLastResponseContext: () => published ? context : { requestId: 'old' },
    getLastMemoryRecallViewer: () => viewer, validateResponseContext: async () => ({ ok: true, current: true }) });
  x.snapshot.f.control.hooks.beforeRequest = async () => {
    published = true;
    if (kind === 'physical_revision') {
      // Semantic bytes can remain identical; physical revision alone must fail.
      x.snapshot.server.get(memoryKey(6)).revision++;
    } else if (kind === 'derived_memory_bytes') {
      // Derived fields permitted during preparation remain protected in the hook.
      const changed = JSON.parse(x.snapshot.local.get(memoryKey(6)));
      changed.embedding.reason += 'changed';
      x.snapshot.local.set(memoryKey(6), JSON.stringify(changed));
    } else if (kind === 'transaction_row') {
      x.snapshot.local.set(prefix + 'entity-registry:v2:unified-vector-tx:unexpected', '{"unexpected":true}');
    } else {
      throw new Error('unknown negative control');
    }
    return [{ role: 'system', content: '[LIBRA CLASSIC RECALL]\n' + text }];
  };
  await assert.rejects(readActualCanonicalDelivery(x.snapshot, query, { expectedMemory: memory }),
    /preserves canonical\/ref\/Head\/registry\/transaction bytes and physical owner revisions/);
}

(async () => {
  const positives = [{ pending: 2 }, { pending: 1 }, { pending: 0 }, { pending: 2, timerWins: true }];
  for (const options of positives) {
    const x = fixture(options);
    const receipt = await prepare672DerivedQueue(x.snapshot, { expectedMemories: x.memories });
    assert.equal(x.queueCalls(), 1, 'exactly one bounded public queue call');
    assert.equal(receipt.pendingAfter, 0);
    assert.equal(receipt.transactionsAfter, 0);
  }
  for (const [name, options] of negatives) {
    const x = fixture(options);
    await assert.rejects(prepare672DerivedQueue(x.snapshot, { expectedMemories: x.memories }), assert.AssertionError, name);
    assert.equal(x.queueCalls(), 1, name + ': no repeated until-green retry');
  }
  const rejected = fixture();
  rejected.snapshot.f.r.api.retryPendingUnifiedVectors = async () => { throw new Error('queue rejection'); };
  await assert.rejects(prepare672DerivedQueue(rejected.snapshot, { expectedMemories: rejected.memories }), /queue rejection/);
  const hookMutations = ['physical_revision', 'derived_memory_bytes', 'transaction_row'];
  for (const kind of hookMutations) await rejectHookMutationAfterPreparation(kind);
  console.log(JSON.stringify({ status: 'PASS', kind: '672-precondition-helper-controls-only',
    positive: positives.length, rejectedPreparationWitnesses: negatives.length,
    propagatedQueueRejection: 1, unchangedHookMutationsRejected: hookMutations.length, productExecuted: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });
