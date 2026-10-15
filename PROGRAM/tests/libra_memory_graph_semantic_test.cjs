'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const createSemantic = require('../tools/libra_memory_graph_semantic.cjs');
const createPages = require('../tools/libra_memory_graph_pages.cjs'), createIndex = require('../tools/libra_memory_graph_index.cjs');
const createLane = require('../tools/libra_memory_graph_lane.cjs'), createQuery = require('../tools/libra_memory_graph_query.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const profile = { provider: 'fixture', model: 'model', profileId: 'profile', queryTask: 'search_query', documentTask: 'search_document',
  descriptor: { spaceId: 'space', dimension: 2, taskPair: 'search_query/search_document' } };
function fixture() {
  const graph = { schema: 'libra.memory_graph_projection.v1', scopeKey: 'scope',
    readerFrame: { owner: 'libra:plugin_only', scopeKey: 'scope', worldlineId: 'main', restoreEpoch: 0, view: { viewerId: 'owner_reader' } },
    coverage: {}, nodes: [], units: [], edges: [], bases: [] };
  const canonicalRows = [], records = new Map();
  for (const [id, vector] of [['one',[1,0]],['two',[0,1]]]) {
    const source = 'source-' + id, node = 'fact-' + id, key = 'memory-' + id, vectorKey = 'vector-' + id;
    graph.nodes.push({ id: source, bindingId: 'source-binding-' + id, layer: 'source', identityCoverage: 'revision_bound' }, { id: node, bindingId: 'fact-binding-' + id, layer: 'meaning', sourceId: source, identityCoverage: 'revision_bound' });
    graph.units.push({ nodeId: node, recordKey: key, family: 'canonical', semanticRole: 'canonical_assertion', turn: 2, text: 'original fact ' + id });
    graph.bases.push({ id: 'basis-' + id, bindingId: 'basis-binding-' + id, sourceId: source });
    graph.edges.push({ id: 'edge-' + id, bindingId: 'edge-binding-' + id, from: node, to: source, predicate: 'evidenced_by', basisId: 'basis-' + id, identityCoverage: 'revision_bound' });
    const hash = digest(id), vectorHash = digest(vector);
    canonicalRows.push({ key, record: { scopeKey: 'scope', memoryId: id, revision: 1, turnRange: { start: 1, end: 2 },
      embedding: { status: 'ready', vectorKey, profileId: 'profile', textHash: hash, vectorHash } } });
    records.set(vectorKey, { schema: 'libra.embedding_projection.v2', scopeKey: 'scope', memoryId: id, revision: 1,
      provider: 'fixture', model: 'model', profileId: 'profile', dimensions: 2, embeddingDescriptor: profile.descriptor,
      projectionVersion: 'projection', textHash: hash, vectorHash, entries: { global: { vector, textHash: hash } } });
  }
  let calls = 0;
  const semantic = createSemantic({ digest, profileFor: () => profile, projectionFor: memory => ({ version: 'projection', textHashes: { global: digest(memory.memoryId) } }) });
  const options = { graph, canonicalRows, config: { enabled: true }, queryText: 'unrelated synonyms', readVector: async key => records.get(key),
    embedQuery: async () => { calls++; return { provider: 'fixture', model: 'model', dimensions: 2, vectors: [[1,0]], metadata: { profileId: 'profile', requestCount: 1 } }; } };
  return { graph, canonicalRows, records, semantic, options, calls: () => calls };
}
const tests = [];
async function test(name, fn) { await fn(); tests.push(name); }
(async () => {
  await test('a compatible source representation retrieves a fact through its evidence edge in the single frontier', async () => {
    const f = fixture(), prepared = await f.semantic.prepare(f.options);
    assert.equal(prepared.diagnostics.status, 'available'); assert.equal(prepared.dependencies.length, 2);
    assert.deepEqual(Object.keys(prepared.queryInput.documentRepresentations).sort(), ['source-one','source-two']);
    assert.equal(prepared.queryInput.documentRepresentations['fact-one'], undefined, 'a projection is never copied to a fact');
    const pages = createPages({ fingerprint: digest }), index = createIndex({ pages, fingerprint: digest });
    const lane = createLane({ pages, index }), query = createQuery({ pages, index, lane, fingerprint: digest });
    const compiled = index.compile(f.graph, { partition: 'p', generation: 'a'.repeat(64) });
    const frame = query.sealQueryFrame({ ...prepared.queryInput, queryText: f.options.queryText,
      owner: f.graph.readerFrame.owner, scopeKey: 'scope', worldlineId: 'main' });
    const result = query.retrieve(query.openView(f.graph, compiled, frame));
    assert.equal(result.complete, true);
    assert.deepEqual(result.candidates.map(c => c.nodeId), ['fact-one']);
    assert.equal(result.candidates[0].winningWitness.seedNodeId, 'source-one');
    assert.equal(result.candidates[0].winningWitness.edgeChain[0].edgeId, 'edge-one');
    assert.deepEqual(result.candidates[0].winningWitness.sourceDependencies, ['source-one']);
  });
  await test('owner, space, projection, invalid payload and temporal mismatches skip provider submission', async () => {
    for (const mutate of [
      f => { for (const record of f.records.values()) record.scopeKey = 'foreign'; },
      f => { for (const record of f.records.values()) record.profileId = 'old-profile'; },
      f => { for (const record of f.records.values()) record.embeddingDescriptor = { ...profile.descriptor, taskPair: 'wrong' }; },
      f => { for (const record of f.records.values()) record.textHash = 'wrong'; },
      f => { for (const record of f.records.values()) record.vectorHash = 'wrong'; },
      f => { for (const record of f.records.values()) record.entries.global.vector = [0,0]; },
      f => { for (const record of f.records.values()) record.entries.global.vector = [1e308,1]; },
      f => { for (const record of f.records.values()) record.entries.global.vector = [1e-300,0]; },
      f => { f.options.asOfTurn = 1; },
      f => { f.options.maxBytes = 4096; for (const record of f.records.values()) { record.dimensions = 1024; record.entries.global.vector = Array(1024).fill(1); } }
    ]) {
      const f = fixture(); mutate(f);
      const result = await f.semantic.prepare(f.options);
      assert.equal(result.diagnostics.status, 'no_compatible_representations'); assert.equal(f.calls(), 0);
      assert.deepEqual(result.dependencies, []); assert.deepEqual(result.queryInput.documentRepresentations, {});
    }
  });
  await test('representation budget limits admitted numeric arrays without claiming complete semantic access', async () => {
    const f = fixture(), result = await f.semantic.prepare({ ...f.options, maxBytes: 4096 });
    assert.equal(result.diagnostics.admittedRepresentations, 1);
    assert.ok(result.diagnostics.representationBytes <= 4096);
    assert.ok(result.diagnostics.rejected.some(row => row.reason === 'representation_byte_budget'));
  });
  await test('query failure, dimension or provider-space mismatch leaves lexical/graph retrieval available', async () => {
    for (const embedQuery of [
      async () => { throw Error('provider_unavailable'); },
      async () => ({ provider: 'fixture', model: 'model', dimensions: 3, vectors: [[1,0,0]], metadata: { profileId: 'profile' } }),
      async () => ({ provider: 'fixture', model: 'other', dimensions: 2, vectors: [[1,0]], metadata: { profileId: 'profile' } })
    ]) {
      const f = fixture(), result = await f.semantic.prepare({ ...f.options, embedQuery });
      assert.equal(result.queryInput.semanticSpace, null); assert.deepEqual(result.dependencies, []);
      assert.equal(result.diagnostics.documentEmbeddingCalls, 0);
    }
    const f = fixture(); let active = true;
    await assert.rejects(() => f.semantic.prepare({ ...f.options, check() { if (!active) throw Error('owner_changed'); },
      embedQuery: async () => { active = false; throw Error('provider_failure'); } }), /owner_changed/);
  });
  await test('N02: additional representation admits valid multi-family vector and removes it from vectorlessFamilies', async () => {
    const f = fixture();
    const microNodeId = 'micro-fact-one';
    f.graph.nodes.push({ id: microNodeId, bindingId: 'micro-binding-1', layer: 'meaning', sourceId: null });
    f.graph.units.push({ nodeId: microNodeId, recordKey: 'micro-rec-1', family: 'micro', semanticRole: 'micro_candidate', turn: 2, text: 'silver key handed over' });
    const additionalRepresentations = [{
      family: 'micro',
      nodeId: microNodeId,
      recordKey: 'micro-rec-1',
      vectorKey: 'micro-vector-1',
      vectorRecord: { schema: 'libra.embedding_projection.v2', scopeKey: 'scope', dimensions: 2, vector: [1, 0], profileId: 'profile', vectorHash: digest([1, 0]) },
      textHash: digest('silver key handed over'),
      temporalEndTurn: 2
    }];
    const prepared = await f.semantic.prepare({ ...f.options, additionalRepresentations });
    assert.equal(prepared.diagnostics.status, 'available');
    assert.ok(prepared.diagnostics.admittedFamilies.includes('micro'), 'admittedFamilies must include micro');
    assert.ok(!prepared.diagnostics.vectorlessFamilies.includes('micro'), 'vectorlessFamilies must exclude micro');
    assert.ok(prepared.queryInput.documentRepresentations[microNodeId], 'microNodeId must be in documentRepresentations');

    const pages = createPages({ fingerprint: digest }), index = createIndex({ pages, fingerprint: digest });
    const lane = createLane({ pages, index }), query = createQuery({ pages, index, lane, fingerprint: digest });
    const compiled = index.compile(f.graph, { partition: 'p', generation: 'b'.repeat(64) });
    const frame = query.sealQueryFrame({
      ...prepared.queryInput,
      queryText: f.options.queryText,
      owner: f.graph.readerFrame.owner,
      scopeKey: 'scope',
      worldlineId: 'main'
    });
    const result = query.retrieve(query.openView(f.graph, compiled, frame));
    assert.equal(result.complete, true);
    const microCandidate = result.candidates.find(c => c.nodeId === microNodeId);
    assert.ok(microCandidate, 'microCandidate must be found in retrieval');
    assert.ok(microCandidate.score > 0, 'microCandidate must receive positive score from vector');
  });
  console.log(JSON.stringify({ suite: 'libra_memory_graph_semantic', passed: tests.length, tests }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
