'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const createPages=require('../tools/libra_memory_graph_pages.cjs'),createIndex=require('../tools/libra_memory_graph_index.cjs'),createCorpus=require('../tools/libra_memory_graph_corpus.cjs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function fixture(count=129){
  const rows=new Map(),reads=[],visits=[],versions=new Map(),links=new Map();let broken=false,payload=0,vocabulary=0;
  const pages=createPages({fingerprint:hash}),index=createIndex({pages,fingerprint:hash});
  const frame={owner:'libra:plugin_only',scopeKey:'forest-test',worldlineId:'main',restoreEpoch:0,view:{viewerId:'owner_reader'}};
  const head=async shard=>({canonicalTotal:0,microTurnTotal:count,...(shard?{count:shard.count}:{}),
    digest:hash(JSON.stringify(Array.from({length:shard?Math.min(shard.count,count-shard.start):count},(_,i)=>{const n=(shard?.start||0)+i;return[n,versions.get(n)||0,links.get(n)||null,payload];})))});
  const owner={check(){if(broken)throw Error('canceled');},read:async k=>{reads.push(k);return rows.get(k)??null;},
    putImmutable:async(k,v)=>{assert.ok(!rows.has(k)||rows.get(k)===v);rows.set(k,v);},
    publish:async p=>{assert.equal(rows.get(p.key)??null,p.previous);assert.equal(rows.get(p.manifestKey),p.manifestRaw);rows.set(p.key,p.raw);},
    captureForestHead:head,
    captureSourceProof:async({config})=>({stamp:(await head({start:config.windowStart||0,count:config.windowCount||count})).digest,sourceBodyDigests:{},recordDependencyKeys:{}}),
    verifySourceProofs:async(p,{config})=>({status:p.ownerProof.stamp===(await head({start:config.windowStart||0,count:config.windowCount||count})).digest?'verified':'stale_source'})};
  const snapshot=async o=>{
    const start=o.microOffset??Number(o.microCursor||0);visits.push(start);const end=Math.min(count,start+(o.limit||1));
    const units=Array.from({length:end-start},(_,i)=>({nodeId:'m'+(start+i),family:'micro',recordKey:'record'+(start+i),text:'keyword'+(start+i)+' extra'.repeat(payload)+Array.from({length:vocabulary},(_,j)=>' term'+(start+i)+'x'+j).join(''),turn:start+i+1,revision:versions.get(start+i)||0}));
    const graph={schema:'libra.memory_graph_projection.v1',scopeKey:frame.scopeKey,readerFrame:frame,
      nodes:units.map(u=>({id:u.nodeId,layer:'meaning',kind:'claim',bindingId:'b'+u.revision,identityCoverage:'revision_bound'})),
      edges:units.flatMap(u=>links.has(u.turn-1)?[{id:'edge'+u.turn,from:u.nodeId,to:'m'+links.get(u.turn-1),predicate:'follows',family:'micro'}]:[]),bases:[],units,
      coverage:{families:{micro:{units:units.length,reasons:end<count?['micro_pages_unread']:[]}},inventory:{canonicalTotal:0,microTurnTotal:count,canonicalNextCursor:'',microNextCursor:end<count?String(end):'',inventoryComplete:false},sourceReadFailures:[],projectionComplete:end===count}};
    return {graph,collected:{sourceKeys:units.map(u=>u.recordKey),canonicalRows:[],entityRegistry:[]}};
  };
  const initial={scopeKey:frame.scopeKey,readerFrame:frame};
  const make=()=>createCorpus({pages,index,fingerprint:hash});let corpus=make();
  return {rows,reads,visits,pages,index,owner,initial,snapshot,
    build:options=>corpus.build({initialGraph:initial,owner,snapshot,options:{limit:1,...options}}),
    read:options=>corpus.read({initialGraph:initial,owner,snapshot,queryInput:{queryText:'keyword128',semanticEnabled:false},...options}),
    restart(){corpus=make();},grow(){count++;},edit(n){versions.set(n,(versions.get(n)||0)+1);},cancel(){broken=true;},link(a,b){links.set(a,b);},payload(n){payload=n;},vocabulary(n){vocabulary=n;}};
}
test('129 windows publish in three bounded shards and route only the matching old/new shard across restart',async()=>{
  const f=fixture(),built=await f.build();assert.equal(built.status,'published');assert.equal(built.shardCount,3);assert.equal(built.windowCount,129);
  f.restart();f.visits.length=0;const read=await f.read();assert.equal(read.access.selectedShardCount,2); // singleton shard + exact hit
  assert.ok(read.graph.units.some(u=>u.nodeId==='m128'));assert.ok(!read.graph.units.some(u=>u.nodeId==='m80'));
  assert.equal(f.visits.length,0,'query never reprojects historical windows');await read.currentGraph();
  const early=await f.read({queryInput:{queryText:'keyword4',semanticEnabled:false}});assert.ok(early.graph.units.some(u=>u.nodeId==='m4'));
});
test('append reuses sealed shards and changes outside selected evidence invalidate the global routing seal',async()=>{
  const f=fixture();await f.build();f.grow();f.visits.length=0;const next=await f.build();assert.ok(next.reusedWindowCount>=64);
  const read=await f.read();f.edit(80);await assert.rejects(()=>read.currentGraph(),/STALE_GENERATION/);await assert.rejects(()=>f.read(),/STALE_GENERATION/);
});
test('broad searches expose a partial result under a shard budget; corruption and cancellation fail closed',async()=>{
  const f=fixture();await f.build();const read=await f.read({queryInput:{queryText:'',semanticEnabled:false},eager:true,selectionBudget:{maxShards:1}});
  assert.equal(read.access.selectionComplete,false);assert.equal(read.graph.coverage.projectionComplete,false);
  const root=JSON.parse(f.rows.get([...f.rows.keys()].find(k=>k.includes(':root:'))));
  const manifest=JSON.parse(f.rows.get(root.manifestKey));f.rows.set(manifest.forest.routes.key,'bad');await assert.rejects(()=>f.read(),/CORRUPT|INVALID|JSON/);
  f.cancel();await assert.rejects(()=>f.build(),/canceled/);
});
test('checkpoints resume bounded shard jobs across restart and never replace the live root until complete',async()=>{
  const f=fixture(257);
  let step=await f.build({maxShardsPerStep:1});assert.equal(step.status,'checkpointed');
  assert.equal([...f.rows.keys()].some(k=>k.includes(':root:')),false);
  f.edit(200);f.restart();f.visits.length=0;
  step=await f.build({maxShardsPerStep:1});assert.equal(step.status,'checkpointed');assert.equal(f.visits.length,0,'a changed tail does not discard sealed checkpoint shards');
  let steps=2;
  while(step.status==='checkpointed'){step=await f.build({maxShardsPerStep:1});assert.ok(++steps<8);}
  assert.equal(step.status,'published');assert.equal(step.windowCount,257);assert.equal(step.shardCount,5);
  const read=await f.read({queryInput:{queryText:'keyword256',semanticEnabled:false}});assert.ok(read.graph.units.some(u=>u.nodeId==='m256'));
});
test('cross-shard follow-up edges feed the same frontier and a connected later fact stays searchable',async()=>{
  const f=fixture();f.link(4,80);await f.build();
  const read=await f.read({queryInput:{queryText:'keyword4',semanticEnabled:false}});
  assert.ok(read.graph.units.some(u=>u.nodeId==='m80'),'routing follows the edge to another shard');
  const lane=require('../tools/libra_memory_graph_lane.cjs')({pages:f.pages,index:f.index,fingerprint:hash});
  const query=require('../tools/libra_memory_graph_query.cjs')({pages:f.pages,index:f.index,lane,fingerprint:hash});
  const frame=query.sealQueryFrame({queryText:'keyword4',owner:'libra:plugin_only',scopeKey:f.initial.scopeKey,worldlineId:'main'});
  const result=query.retrieve(query.openView(read.graph,read.compiledIndex,frame));
  assert.ok(result.candidates.some(c=>c.nodeId==='m80'),'one frontier propagates activation across the shard boundary');
});
test('byte-heavy windows split before 64 and a distant hit still fits the query workspace',async()=>{
  const f=fixture();f.payload(2700);const built=await f.build({maxShardsPerStep:64});
  assert.equal(built.status,'published');assert.ok(built.shardCount>3);
  const read=await f.read();assert.ok(read.graph.units.some(u=>u.nodeId==='m128'));assert.equal(read.access.selectionComplete,true);
  assert.ok(read.access.storage.selectedGraphBytes<=4194304);
});
test('more than 64 shards use a two-level term directory and still read only the rare hit and singleton shard',async()=>{
  const f=fixture();let built;do{built=await f.build({shardWindows:1,maxShardsPerStep:64});}while(built.status==='checkpointed');
  assert.equal(built.shardCount,129);f.restart();f.visits.length=0;
  const read=await f.read();assert.equal(read.access.selectedShardCount,2);assert.ok(read.graph.units.some(u=>u.nodeId==='m128'));assert.equal(f.visits.length,0);
});

test('a small corpus exceeding the legacy index budget splits, publishes and uses stored routing after restart', async () => {
  const f = fixture(16); f.vocabulary(100);
  const result = await f.build({ maxIndexBytes: 65536 });
  assert.equal(result.status, 'published');
  assert.ok(result.shardCount > 1, 'a corpus below 64 windows still splits when its index is too large');
  f.restart(); f.visits.length = 0;
  const read = await f.read({ queryInput: { queryText: 'keyword15', semanticEnabled: false } });
  assert.equal(read.access.storage.storageAccess, 'routed_durable_shards');
  assert.ok(read.graph.units.some(unit => unit.nodeId === 'm15'));
  assert.equal(f.visits.length, 0, 'retrieval opens stored graph pages instead of enumerating native windows');
  f.edit(15);
  const updated = await f.build({ maxIndexBytes: 65536 });
  assert.equal(updated.status, 'published');
  assert.ok(updated.reusedWindowCount > 0);
  const latest = await f.read({ queryInput: { queryText: 'keyword15', semanticEnabled: false } });
  assert.ok(latest.graph.units.some(unit => unit.nodeId === 'm15' && unit.revision === 1));
});

test('published structure pages enumerate each stored shard without repeating or omitting one', async () => {
  const f = fixture(7); await f.build({ shardWindows: 2 });
  const seen = new Set(); let offset = 0, generation = '';
  do {
    const read = await f.read({ eager: true, queryInput: { semanticEnabled: false }, selectionBudget: { maxShards: 1, shardOffset: offset } });
    generation ||= read.access.generation;
    assert.equal(read.access.generation, generation);
    assert.equal(read.access.selectedShardCount, 1);
    for (const unit of read.graph.units) {
      assert.ok(!seen.has(unit.nodeId), 'no repeated stored node'); seen.add(unit.nodeId);
    }
    offset = read.access.nextShardOffset;
  } while (offset != null);
  assert.equal(seen.size, 7);
});

test('one oversized native window narrows without relaxing index limits and preserves its width for incremental reuse', async () => {
  const f = fixture(16); f.vocabulary(100);
  const result = await f.build({ limit: 20, maxIndexBytes: 65536, maxShardsPerStep: 64 });
  assert.equal(result.status, 'published');
  assert.ok(result.effectiveLimit < 20);
  assert.ok(result.windowLimitRetries > 0);
  const again = await f.build({ limit: undefined, maxIndexBytes: 65536, maxShardsPerStep: 64 });
  assert.equal(again.status, 'published');
  assert.equal(again.effectiveLimit, result.effectiveLimit);
  assert.ok(again.reusedWindowCount > 0);
  assert.equal(again.windowLimitRetries, 0);
});
