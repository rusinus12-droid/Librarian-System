'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const createSemantic = require('../tools/libra_memory_graph_semantic.cjs');
const createPages = require('../tools/libra_memory_graph_pages.cjs'), createIndex = require('../tools/libra_memory_graph_index.cjs');
const createLane = require('../tools/libra_memory_graph_lane.cjs'), createQuery = require('../tools/libra_memory_graph_query.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const profile = { provider: 'fixture', model: 'model', profileId: 'profile', queryTask: 'search_query', documentTask: 'search_document',
  descriptor: { spaceId: 'space', dimension: 2, taskPair: 'search_query/search_document' } };
function fixture(vectors = [['one',[1,0]],['two',[0,1]]]) {
  const graph = { schema: 'libra.memory_graph_projection.v1', scopeKey: 'scope',
    readerFrame: { owner: 'libra:plugin_only', scopeKey: 'scope', worldlineId: 'main', restoreEpoch: 0, view: { viewerId: 'owner_reader' } },
    coverage: {}, nodes: [], units: [], edges: [], bases: [] };
  const canonicalRows = [], records = new Map();
  for (const [id, vector] of vectors) {
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
  await test('six maintenance representations share default read admission without dropping a vector', async () => {
    const f=fixture(Array.from({length:6},(_,i)=>['item'+i,[1,i%2]]));
    const pages=createPages({fingerprint:digest});
    const resources=require('../tools/libra_memory_graph_resources.cjs')({measure:pages.measure,encodedSize:pages.encodedSize,stageCost:pages.stageCost}).openMaintenance();
    let active=0,peak=0;
    try {
      const directory=await f.semantic.buildDirectory({...f.options,writeRepresentation:async()=>{
        await resources.read(async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setImmediate(resolve));active--;return '[]';},{kind:'durable'});
        return {};
      }});
      assert.equal(directory.entries.length,6);assert.equal(peak,1);assert.equal(f.calls(),0);
      assert.equal(resources.inspect().failure,null);assert.equal(resources.inspect().durableBytes,12);
    } finally {resources.close();}
  });
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
  await test('lazy owner vectors are read only by Lane, with exact routing, common cache and the same eager witnesses', async () => {
    const f=fixture(),fingerprint=text=>crypto.createHash('sha256').update(text).digest('hex');
    const pages=createPages({fingerprint}),index=createIndex({pages,fingerprint}),lane=createLane({index,pages}),query=createQuery({index,lane,pages,fingerprint});
    let reads=0;const options={...f.options,readVector:async key=>{reads++;return f.records.get(key);},pages,fingerprint,evaluate:query.evaluateRepresentation};
    const directory=await f.semantic.buildDirectory(options);assert.equal(f.calls(),0,'maintenance never embeds a query/document');assert.equal(reads,2);
    reads=0;const prepared=await f.semantic.prepareLazy({...options,routingDirectory:directory});assert.equal(reads,0,'opening metadata reads no vectors');
    assert.deepEqual(prepared.queryInput.semanticReferences,['source-one'],'orthogonal zero-score source is pruned by an exact bound');
    const partition='semantic',generation=pages.generation(f.graph,{partition,restoreEpoch:0,view:f.graph.readerFrame});
    const base=index.compile(f.graph,{partition,generation}),compiled=index.withSemanticReader(base,prepared.readPage);
    const frame=query.sealQueryFrame({...prepared.queryInput,queryText:f.options.queryText,owner:f.graph.readerFrame.owner,scopeKey:'scope',worldlineId:'main'}),view=query.openView(f.graph,compiled,frame);
    const result=await query.retrieveAsync(view,{maxStoragePages:1});query.closeView(view);
    assert.equal(reads,1);assert.ok(result.candidates.some(x=>x.nodeId==='fact-one'));assert.equal(result.complete,true);
    assert.ok(result.diagnostics.laneRoleStats.semantic_access.pages>0);assert.equal(pages.inspect().pins,0);assert.equal(pages.inspect().activeRequests,0);
    const eager=await f.semantic.prepare(f.options),eagerFrame=query.sealQueryFrame({...eager.queryInput,queryText:f.options.queryText,owner:f.graph.readerFrame.owner,scopeKey:'scope',worldlineId:'main'}),eagerView=query.openView(f.graph,base,eagerFrame);
    const expected=await query.retrieveAsync(eagerView);query.closeView(eagerView);
    assert.deepEqual(result.candidates.map(x=>[x.nodeId,x.score,x.winningWitness]),expected.candidates.map(x=>[x.nodeId,x.score,x.winningWitness]));
  });
  await test('lazy semantic physical budget stops before reading the next owner ref and leaves a resumable unread access', async () => {
    const f=fixture(),fingerprint=text=>crypto.createHash('sha256').update(text).digest('hex');
    const pages=createPages({fingerprint}),index=createIndex({pages,fingerprint}),lane=createLane({index,pages}),query=createQuery({index,lane,pages,fingerprint});let reads=0;
    const prepared=await f.semantic.prepareLazy({...f.options,readVector:async key=>{reads++;return f.records.get(key);},pages,fingerprint,evaluate:query.evaluateRepresentation});
    const partition='budget',generation=pages.generation(f.graph,{partition,restoreEpoch:0,view:f.graph.readerFrame});
    const base=index.compile(f.graph,{partition,generation}),compiled=index.withSemanticReader(base,prepared.readPage);
    const frame=query.sealQueryFrame({...prepared.queryInput,queryText:f.options.queryText,owner:f.graph.readerFrame.owner,scopeKey:'scope',worldlineId:'main'}),view=query.openView(f.graph,compiled,frame);
    const result=await query.retrieveAsync(view,{maxStoragePages:1});assert.equal(reads,1);assert.equal(result.complete,false);
    assert.ok(result.diagnostics.unreadCursors.some(x=>x.table==='representations'));query.closeView(view);
    assert.equal(pages.inspect().pins,0);assert.equal(pages.inspect().activeRequests,0);
  });
  await test('lazy admission preserves the eager representation budget near its boundary', async () => {
    const f=fixture(),fingerprint=text=>crypto.createHash('sha256').update(text).digest('hex');
    const pages=createPages({fingerprint}),index=createIndex({pages,fingerprint}),lane=createLane({index,pages}),query=createQuery({index,lane,pages,fingerprint});
    const prepared=await f.semantic.prepareLazy({...f.options,maxBytes:4400,pages,fingerprint,evaluate:query.evaluateRepresentation});
    const partition='boundary',generation=pages.generation(f.graph,{partition,restoreEpoch:0,view:f.graph.readerFrame}),compiled=index.withSemanticReader(index.compile(f.graph,{partition,generation}),prepared.readPage);
    const frame=query.sealQueryFrame({...prepared.queryInput,queryText:f.options.queryText,owner:f.graph.readerFrame.owner,scopeKey:'scope',worldlineId:'main'}),view=query.openView(f.graph,compiled,frame);
    const result=await query.retrieveAsync(view);query.closeView(view);
    assert.equal(result.complete,true);assert.equal(prepared.diagnostics.admittedRepresentations,2);
    const eager=await f.semantic.prepare({...f.options,maxBytes:4400});assert.equal(eager.diagnostics.admittedRepresentations,2);assert.equal(prepared.diagnostics.representationBytes,eager.diagnostics.representationBytes);
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
  await test('persisted Micro references are lazy, untruncated, budgeted and retain owner dependencies', async () => {
    const f=fixture(), fingerprint=text=>crypto.createHash('sha256').update(text).digest('hex');
    const pages=createPages({fingerprint}), index=createIndex({pages,fingerprint}), lane=createLane({index,pages}), query=createQuery({index,lane,pages,fingerprint});
    const extras=[];
    for(let i=0;i<10;i++){
      const id='micro-source-'+i,key='micro-vector-'+i;
      f.graph.nodes.push({id,bindingId:id,layer:'source',identityCoverage:'revision_bound'});
      extras.push({family:'micro',nodeId:id,recordKey:'micro-'+i,vectorKey:key,textHash:'text-'+i,spaceDigest:'space',dimensions:2,temporalEndTurn:2});
      f.records.set(key,{schema:'libra.micro_vector.v1',scopeKey:'scope',textHash:'text-'+i,spaceDigest:'space',vector:[1,0],dimensions:2,provider:'fixture',model:'model',profileId:'profile'});
    }
    let reads=0;
    const options={...f.options,canonicalRows:[],additionalRepresentations:extras,pages,fingerprint,evaluate:query.evaluateRepresentation,
      readVector:async key=>{reads++;return f.records.get(key);}};
    const prepared=await f.semantic.prepareLazy(options);
    assert.equal(reads,0);assert.equal(f.calls(),0);assert.equal(prepared.queryInput.semanticReferences.length,10);
    const partition='micro',generation=pages.generation(f.graph,{partition,restoreEpoch:0,view:f.graph.readerFrame});
    const compiled=index.withSemanticReader(index.compile(f.graph,{partition,generation}),prepared.readPage);
    const frame=query.sealQueryFrame({...prepared.queryInput,queryText:f.options.queryText,owner:f.graph.readerFrame.owner,scopeKey:'scope',worldlineId:'main'});
    const view=query.openView(f.graph,compiled,frame);
    try {
      const stopped=await query.retrieveAsync(view,{maxStoragePages:1});
      assert.equal(reads,1);assert.equal(stopped.complete,false);
      assert.equal(prepared.dependencies.length,1);assert.match(prepared.dependencies[0].key,/^micro-vector-/);
      assert.equal(prepared.dependencies[0].digest,digest(f.records.get(prepared.dependencies[0].key)));
      assert.equal(prepared.diagnostics.microRepresentations.length,1);
      assert.ok(!prepared.diagnostics.vectorlessFamilies.includes('micro'));
    } finally { query.closeView(view); }
    const tiny=await f.semantic.prepareLazy(options);
    const noIo=await tiny.readPage({anchorNodeId:extras[0].nodeId},{pagesRead:0,maxPages:1,bytesRead:0,maxBytes:1});
    assert.equal(noIo.storageStopped,true);assert.equal(reads,1,'no owner I/O outside the storage allowance');
    for(const mutate of [record=>record.scopeKey='foreign',record=>record.textHash='wrong',record=>record.profileId='wrong']){
      const record=f.records.get(extras[0].vectorKey),saved={...record};mutate(record);
      const rejected=await f.semantic.prepare({...f.options,canonicalRows:[],additionalRepresentations:[extras[0]]});
      assert.equal(rejected.diagnostics.admittedRepresentations,0);assert.ok(rejected.diagnostics.rejected.some(row=>row.reason==='vector_owner_binding_mismatch'));
      Object.assign(record,saved);
    }
  });
  console.log(JSON.stringify({ suite: 'libra_memory_graph_semantic', passed: tests.length, tests }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
