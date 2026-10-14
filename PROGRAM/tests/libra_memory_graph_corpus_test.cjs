'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const createPages=require('../tools/libra_memory_graph_pages.cjs');
const createIndex=require('../tools/libra_memory_graph_index.cjs');
const createCorpus=require('../tools/libra_memory_graph_corpus.cjs');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const clone=v=>JSON.parse(JSON.stringify(v));
function fixture({count=53,canonicalCount=2}={}) {
  const values=new Map(),writes=[],reads=[],visits=[];
  let revision=0,broken=false,compileCount=0,cursorEpoch=0;
  const pages=createPages({fingerprint:hash}),coreIndex=createIndex({pages,fingerprint:hash});
  const index={...coreIndex,compile(...args){compileCount++;return coreIndex.compile(...args);}};
  const corpus=createCorpus({pages,index,fingerprint:hash});
  const owner={check(){if(broken)throw Error('canceled');},async read(k){reads.push(k);return values.get(k)??null;},
    async putImmutable(k,raw){writes.push(k);values.set(k,raw);},
    async publish({key,raw,previous,manifestKey,manifestRaw}){
      if((values.get(key)??null)!==previous||values.get(manifestKey)!==manifestRaw)throw Error('conflict');
      writes.push(key);values.set(key,raw);
    }};
  const snapshot=async options=>{
    visits.push({...options});
    const c=Number(String(options.canonicalCursor||0).split(':')[0]),m=Number(String(options.microCursor||0).split(':')[0]),n=options.limit;
    const cursor=offset=>String(offset)+(cursorEpoch?':runtime'+cursorEpoch:'');
    const ids=[...Array.from({length:Math.min(n,canonicalCount-c)},(_,i)=>['canonical',c+i]),
      ...Array.from({length:Math.min(n,count-m)},(_,i)=>['micro',m+i])];
    const graph={schema:'libra.memory_graph_projection.v1',scopeKey:'test',
      readerFrame:{owner:'libra:plugin_only',scopeKey:'test',worldlineId:'main',restoreEpoch:0,view:{viewerId:'owner_reader'}},
      nodes:ids.map(([family,i])=>({id:family+i,layer:'meaning',kind:'claim',identityCoverage:'revision_bound',bindingId:'binding'+(i===count-1?revision:0)})),edges:[],bases:[],
      units:ids.map(([family,i])=>({nodeId:family+i,family,recordKey:family+i,text:'archive keyword'+i,turn:i})),
      coverage:{families:Object.fromEntries(['canonical','micro'].map(family=>[family,{records:ids.filter(([f])=>f===family).length,
        reasons:(family==='canonical'?c+n<canonicalCount:m+n<count)?[family+'_pages_unread']:[]}])),
        inventory:{canonicalTotal:canonicalCount,microTurnTotal:count,canonicalNextCursor:c+n<canonicalCount?cursor(c+n):'',
          microNextCursor:m+n<count?cursor(m+n):'',inventoryComplete:false},projectionComplete:c+n>=canonicalCount&&m+n>=count}};
    return {graph,collected:{sourceKeys:ids.map(([family,i])=>family+i),canonicalRows:ids.filter(([f])=>f==='canonical').map(([f,i])=>({key:f+i,record:{id:i}}))}};
  };
  const initial=async()=> (await snapshot({limit:1,canonicalCursor:'',microCursor:''})).graph;
  const build=options=>corpus.build({owner,snapshot,options:{limit:1,...options}});
  const read=async()=>corpus.read({owner,snapshot,initialGraph:await initial(),eager:true});
  const idle=()=>{const s=pages.inspect();assert.equal(s.pins,0);assert.equal(s.activeRequests,0);assert.equal(s.bytes.request,0);assert.equal(s.bytes.staging,0);assert.equal(corpus.inspect().activeBuild,false);};
  return {values,writes,reads,visits,pages,index,corpus,owner,snapshot,initial,build,read,idle,
    change(){revision++;},restartCursor(){cursorEpoch++;},cancel(){broken=true;},get compiles(){return compileCount;}};
}
test('one durable index spans 53 owner windows and the ended family never restarts',async()=>{
  const x=fixture();const built=await x.build();assert.equal(built.windowCount,53);
  assert.equal(x.writes.at(-1),x.corpus.location(await x.initial()).rootKey);
  const before=x.writes.length,result=await x.read();
  assert.equal(result.graph.units.length,55);assert.ok(result.graph.units.some(u=>u.nodeId==='micro52'));
  assert.ok(x.visits.slice(2,53).every(v=>v.canonicalCursor==='1'));
  assert.equal(result.graph.coverage.projectionComplete,true);assert.equal(result.graph.coverage.inventory.inventoryComplete,false);
  assert.equal(result.compiledIndex.postings.some(row=>row.term==='keyword52'),true);
  assert.equal(x.compiles,1);assert.equal(x.writes.length,before);x.idle();
});
test('cold, warm, evicted and fresh-runtime reads reuse the published index without compilation',async()=>{
  const x=fixture({count:7});await x.build();const first=await x.read(),second=await x.read();
  assert.deepEqual(first.compiledIndex,second.compiledIndex);assert.ok(x.pages.inspect().counters.hits>0);
  x.pages.invalidate();assert.deepEqual((await x.read()).compiledIndex,first.compiledIndex);
  const pages=createPages({fingerprint:hash}),index=createIndex({pages,fingerprint:hash});
  const corpus=createCorpus({pages,index:{...index,compile(){throw Error('query_must_not_compile');}},fingerprint:hash});
  const fresh=await corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:await x.initial(),eager:true});
  assert.deepEqual(fresh.compiledIndex,first.compiledIndex);assert.equal(x.compiles,1);x.idle();
});
test('an edit outside the first source window refuses both a fresh read and an already selected generation',async()=>{
  const x=fixture({count:7});await x.build();const issued=await x.read();x.change();
  await assert.rejects(x.read,/STALE_GENERATION/);await assert.rejects(issued.currentGraph,/STALE_GENERATION/);x.idle();
});
test('fresh runtime-bound owner cursors do not invalidate unchanged native content',async()=>{
  const x=fixture({count:7});await x.build();const before=await x.read();x.restartCursor();
  const after=await x.read();assert.equal(after.compiledIndex.indexDigest,before.compiledIndex.indexDigest);
  await before.currentGraph();assert.equal(x.compiles,1);x.change();await assert.rejects(x.read,/STALE_GENERATION/);x.idle();
});
test('corrupt disk tables are checked even while their old pages are warm',async()=>{
  const x=fixture({count:7});await x.build();await x.read();
  const key=[...x.values.keys()].find(k=>k.includes('page:postings:'));x.values.set(key,'[]');
  await assert.rejects(x.read,/PAGE_CORRUPT/);x.idle();
});
test('a failed page write and exhausted build budgets preserve the old root',async()=>{
  const x=fixture({count:7});await x.build();const rootKey=x.corpus.location(await x.initial()).rootKey,root=x.values.get(rootKey);
  x.change();const put=x.owner.putImmutable;x.owner.putImmutable=async()=>{throw Error('disk_failure');};
  await assert.rejects(()=>x.build(),/disk_failure/);assert.equal(x.values.get(rootKey),root);x.owner.putImmutable=put;
  await assert.rejects(()=>x.build({maxWindows:2}),/WINDOW_BUDGET/);assert.equal(x.values.get(rootKey),root);x.idle();
});
test('missing generations stay read only; byte and policy limits cannot silently publish a partial corpus',async()=>{
  const x=fixture();assert.equal(await x.read(),null);assert.equal(x.writes.length,0);
  await assert.rejects(()=>x.build({maxWindows:129}),/POLICY_INVALID/);
  await assert.rejects(()=>x.build({maxSerializedBytes:1}),/POLICY_INVALID/);assert.equal(x.writes.length,0);x.idle();
});
test('a source change while index pages are written prevents publication',async()=>{
  const x=fixture({count:7}),put=x.owner.putImmutable;let changed=false;
  x.owner.putImmutable=async(...args)=>{await put(...args);if(!changed){changed=true;x.change();}};
  await assert.rejects(()=>x.build(),/SOURCE_CHANGED/);assert.ok(!x.writes.some(k=>k.includes(':root:')));x.idle();
});
test('canceled writes keep the build barrier until the pending write settles',async()=>{
  const x=fixture({count:7});let entered,release;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r),put=x.owner.putImmutable;
  x.owner.putImmutable=async(...args)=>{entered();await gate;await put(...args);};
  const pending=x.build();await started;x.cancel();await assert.rejects(()=>x.build(),/BUILD_BUSY/);release();
  await assert.rejects(()=>pending,/canceled/);assert.ok(!x.writes.some(k=>k.includes(':root:')));x.idle();
});
test('resigned manifests cannot redirect reads outside the corpus namespace',async()=>{
  const x=fixture({count:7});await x.build();const loc=x.corpus.location(await x.initial()),root=JSON.parse(x.values.get(loc.rootKey));
  const manifest=JSON.parse(x.values.get(root.manifestKey));manifest.refs[0].key='foreign-secret';
  const raw=JSON.stringify(manifest),digest=hash(raw),key=loc.prefix+'manifest:'+digest;
  x.values.set(key,raw);x.values.set(loc.rootKey,JSON.stringify({...root,manifestKey:key,digest}));
  await assert.rejects(x.read,/DIRECTORY_INVALID/);assert.ok(!x.reads.includes('foreign-secret'));x.idle();
});
test('index restoration and rollout reuse reject foreign generation/partition and altered tables',()=>{
  const x=fixture({count:1});const graph={schema:'libra.memory_graph_projection.v1',nodes:[],edges:[],bases:[],units:[],coverage:{}};
  const compiled=x.index.compile(graph,{partition:'p',generation:'a'.repeat(64)});
  assert.equal(x.index.isCompatible(clone(compiled),{partition:'p',generation:compiled.generation}),false);
  assert.throws(()=>x.index.restore(clone(compiled),{partition:'other',generation:compiled.generation}),/RESTORE_BINDING/);
  const changed=clone(compiled);changed.postings.push({term:'forged'});
  assert.throws(()=>x.index.restore(changed,{partition:'p',generation:compiled.generation}),/RESTORE_DIGEST/);x.idle();
});
