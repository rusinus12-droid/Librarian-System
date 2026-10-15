'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const createPages=require('../tools/libra_memory_graph_pages.cjs');
const createIndex=require('../tools/libra_memory_graph_index.cjs');
const createInventory=require('../tools/libra_memory_graph_inventory.cjs');
const createCorpus=require('../tools/libra_memory_graph_corpus.cjs');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const clone=v=>JSON.parse(JSON.stringify(v));
function fixture({count=53,canonicalCount=2,incrementalProof=false,hubEdges=0}={}) {
  const values=new Map(),writes=[],reads=[],visits=[];
  let revision=0,editedMicro=count-1,broken=false,compileCount=0,cursorEpoch=0;
  let stateRev=0,loreRev=0,canonicalRev=0;
  const pages=createPages({fingerprint:hash}),coreIndex=createIndex({pages,fingerprint:hash});
  const inventory=createInventory({fingerprint:hash});
  const index={...coreIndex,compile(...args){compileCount++;return coreIndex.compile(...args);}};
  const corpus=createCorpus({pages,index,fingerprint:hash,inventory});
  const liveOwnerProof=(windowCount,limit=1)=>({
    schema:'libra.graph_corpus_owner_proof.v1',
    scopeKey:'test',worldlineId:'main',restoreEpoch:0,cutoffTurn:null,limit,
    manifestDigest:hash('manifest:'+canonicalRev+':'+count),
    registryDigest:hash('registry:0'),
    turnPairsDigest:hash('pairs:'+revision+':'+count),
    stateProof:{continuityStateDigest:hash('state:'+stateRev),correctionJournalDigest:hash('journal:0'),stateRevision:'s'+stateRev},
    loreProof:{allowedLoreDigest:hash('lore:'+loreRev),loreMappingDigest:hash('map:0'),loreBasisDigest:hash('basis:'+loreRev)},
    windows:Array.from({length:windowCount},(_,w)=>({
      ordinal:w,canonicalOffset:Math.min(w,canonicalCount-1),microOffset:w,limit,
      canonicalSlice:[{refIdentity:{key:'canonical'+Math.min(w,canonicalCount-1),revision:w===canonicalCount-1?canonicalRev:0},available:true,evidenceKey:''}],
      microSlice:[{turn:w+1,pairRevisionId:'r'+(w===editedMicro?revision:0),pairSourceDigest:'p'+(w===editedMicro?revision:0),
        completedHeadDigest:'ch'+(w===editedMicro?revision:0),microHeadDigest:'mh'+(w===editedMicro?revision:0),status:'verified'}]
    }))
  });
  const owner={check(){if(broken)throw Error('canceled');},async read(k){reads.push(k);return values.get(k)??null;},
    async putImmutable(k,raw){writes.push(k);values.set(k,raw);},
    async publish({key,raw,previous,manifestKey,manifestRaw}){
      if((values.get(key)??null)!==previous||values.get(manifestKey)!==manifestRaw)throw Error('conflict');
      writes.push(key);values.set(key,raw);
    },
    ...(incrementalProof?{
      async captureSourceProof({windows,config}){return liveOwnerProof(windows.length,config.limit);},
      async verifySourceProofs(proofRecord,{config}){
        return inventory.verifyIncrementalSourceProofs(proofRecord.ownerProof,liveOwnerProof(count,config.limit));
      }
    }:{})};
  const snapshot=async options=>{
    visits.push({...options});
    const c=Number.isSafeInteger(options.canonicalOffset)?options.canonicalOffset:Number(String(options.canonicalCursor||0).split(':')[0]);
    const m=Number.isSafeInteger(options.microOffset)?options.microOffset:Number(String(options.microCursor||0).split(':')[0]);
    const n=options.limit;
    const cursor=offset=>String(offset)+(cursorEpoch?':runtime'+cursorEpoch:'');
    const ids=[...Array.from({length:Math.min(n,canonicalCount-c)},(_,i)=>['canonical',c+i]),
      ...Array.from({length:Math.min(n,count-m)},(_,i)=>['micro',m+i])];
    const extraNodes=hubEdges>0&&m===0?Array.from({length:hubEdges},(_,k)=>({
      id:'hub_dep_'+k,layer:'entity',kind:'entity',identityCoverage:'revision_bound',bindingId:'hb'+k
    })):[];
    const extraEdges=hubEdges>0&&m===0?Array.from({length:hubEdges},(_,k)=>({
      id:'edge_hub_'+k,from:'canonical0',to:'hub_dep_'+k,predicate:'mentions',family:'canonical'
    })):[];
    const extraBases=hubEdges>0&&m===0?[{
      id:'basis_hub_0',nodeId:'canonical0',family:'canonical',
      sourceKeys:Array.from({length:hubEdges},(_,k)=>'dep_source_key_very_long_identifier_'+String(k).padStart(4,'0'))
    }]:[];
    const graph={schema:'libra.memory_graph_projection.v1',scopeKey:'test',
      readerFrame:{owner:'libra:plugin_only',scopeKey:'test',worldlineId:'main',restoreEpoch:0,view:{viewerId:'owner_reader'}},
      nodes:[...ids.map(([family,i])=>({id:family+i,layer:'meaning',kind:'claim',identityCoverage:'revision_bound',
        bindingId:'binding'+(family==='canonical'&&i===canonicalCount-1?canonicalRev:family==='micro'&&i===editedMicro?revision:0)})),...extraNodes],
      edges:extraEdges,bases:extraBases,
      units:ids.map(([family,i])=>({nodeId:family+i,family,recordKey:family+i,
        text:'archive keyword'+i+(hubEdges>0&&family==='canonical'&&i===0?' '+Array.from({length:hubEdges},(_,k)=>'sharedtoken'+k).join(' '):''),
        turn:i,
        ...(hubEdges>0&&family==='canonical'&&i===0?{
          entities:Array.from({length:hubEdges},(_,k)=>'entity_very_long_hub_identifier_'+String(k).padStart(4,'0')),
          dependencyKeys:Array.from({length:hubEdges},(_,k)=>'dep_source_key_very_long_identifier_'+String(k).padStart(4,'0'))
        }:{})})),
      coverage:{families:Object.fromEntries(['canonical','micro'].map(family=>[family,{records:ids.filter(([f])=>f===family).length,
        reasons:(family==='canonical'?c+n<canonicalCount:m+n<count)?[family+'_pages_unread']:[]}])),
        inventory:{canonicalTotal:canonicalCount,microTurnTotal:count,canonicalNextCursor:c+n<canonicalCount?cursor(c+n):'',
          microNextCursor:m+n<count?cursor(m+n):'',inventoryComplete:false},projectionComplete:c+n>=canonicalCount&&m+n>=count}};
    return {graph,collected:{sourceKeys:ids.map(([family,i])=>family+i),canonicalRows:ids.filter(([f])=>f==='canonical').map(([f,i])=>({key:f+i,record:{id:i}}))}};
  };
  const initial=async()=> (await snapshot({limit:1,canonicalCursor:'',microCursor:''})).graph;
  const build=options=>corpus.build({owner,snapshot,options:{limit:1,...options}});
  const read=async(opts={})=>corpus.read({owner,snapshot,initialGraph:await initial(),eager:true,...opts});
  const idle=()=>{const s=pages.inspect();assert.equal(s.pins,0);assert.equal(s.activeRequests,0);assert.equal(s.bytes.request,0);assert.equal(s.bytes.staging,0);assert.equal(corpus.inspect().activeBuild,false);};
  return {values,writes,reads,visits,pages,index,corpus,owner,snapshot,initial,build,read,idle,
    change(){editedMicro=count-1;revision++;},changeCanonical(){canonicalRev++;},changeState(){stateRev++;},changeLore(){loreRev++;},
    grow(delta=1){count+=delta;},restartCursor(){cursorEpoch++;},cancel(){broken=true;},uncancel(){broken=false;},get compiles(){return compileCount;}};
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
test('paged query projection skips build history; warm pages and eager history are physically checked',async()=>{
  const x=fixture({count:10,incrementalProof:true}),built=await x.build();
  const projection=JSON.parse(x.values.get(built.sourceProofs.projectionKey));
  assert.equal(projection.schema,'libra.graph_corpus_projection.v2');assert.equal(projection.windowSlices,undefined);
  const history=JSON.parse(x.values.get(projection.build.key));
  assert.equal(history.windows.length,10);
  x.reads.length=0;
  const result=await x.read({eager:false});assert.equal(result.access.storage.projection.windowRecordsRead,0);
  assert.ok(!x.reads.includes(projection.build.key));
  const saved=x.values.get(history.windows[0].key);x.values.set(history.windows[0].key,'{}');
  assert.equal((await x.read({eager:false})).graph.units.length,result.graph.units.length);
  await assert.rejects(x.read,/PAGE_CORRUPT/);x.values.set(history.windows[0].key,saved);
  const page=projection.parts.units.refs[0].key;x.values.set(page,'[]');
  await assert.rejects(()=>x.read({eager:false}),/PAGE_CORRUPT/);x.idle();
});
test('legacy projection skips unused windows within the query decode budget and validates skipped JSON',async()=>{
  const createResources=require('../tools/libra_memory_graph_resources.cjs');
  const x=fixture({count:4,incrementalProof:true}),built=await x.build(),graph=await x.initial(),loc=x.corpus.location(graph);
  const native=await x.corpus.enumerate(x.snapshot,{limit:1},x.owner.check);
  const legacy={schema:'libra.graph_corpus_projection.v1',generation:built.generation,scopeKey:'test',frame:graph.readerFrame,
    graph:native.graph,windowSlices:native.windowSlices,collected:native.collected};
  legacy.windowSlices[0].unusedMetadata=Array.from({length:12000},()=>({quoted:'"escaped brace } [',value:1}));
  const root=JSON.parse(x.values.get(loc.rootKey)),manifest=JSON.parse(x.values.get(root.manifestKey));
  const publish=raw=>{
    const projectionDigest=hash(raw),projectionKey=loc.prefix+'projection:'+projectionDigest;x.values.set(projectionKey,raw);
    manifest.sourceProofs={...manifest.sourceProofs,projectionKey,projectionDigest};
    const manifestRaw=JSON.stringify(manifest),digest=hash(manifestRaw),manifestKey=loc.prefix+'manifest:'+digest;
    x.values.set(manifestKey,manifestRaw);x.values.set(loc.rootKey,JSON.stringify({...root,digest,manifestKey}));
  };
  publish(JSON.stringify(legacy));
  const pool=createResources({measure:x.pages.measure,encodedSize:x.pages.encodedSize,stageCost:x.pages.stageCost});
  const ledger=pool.open({maxDecodeBytes:4194304});x.owner.resources=ledger;
  const result=await x.read({eager:false});assert.equal(result.graph.units.length,native.graph.units.length);
  assert.ok(ledger.inspect().peakDecodeBytes<4194304);ledger.close();delete x.owner.resources;
  publish(JSON.stringify(legacy).replace('"windowSlices":[','"windowSlices":[invalid,'));
  await assert.rejects(()=>x.read({eager:false}),/RECORD_INVALID/);x.idle();
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
test('N01-A: incremental owner proof verifies 53 windows with zero window re-enumeration and rejects any family mutation or corrupted proof/projection',async()=>{
  const x=fixture({count:53,canonicalCount:2,incrementalProof:true});
  const built=await x.build();
  assert.equal(built.sourceProofs.ownerProofAvailable,true);
  assert.deepEqual(built.sourceProofs.guaranteedFamiliesWithoutBodyReRead,['canonical','micro','state']);
  assert.deepEqual(built.sourceProofs.reReadRequiredEveryRequestFamilies,['state','lore']);
  assert.deepEqual(built.sourceProofs.bodyReReadRequiredFamilies,['lore']);
  const frameGraph=await x.initial();
  x.visits.length=0;
  const opened=await x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:false});
  assert.equal(x.visits.length,0,'incremental proof must not re-enumerate the 53 windows on read');
  assert.equal(opened.access.nativeReprojectionRequired,false);
  assert.equal(opened.access.currentnessVerification.mode,'incremental_owner_proof');
  assert.equal(opened.access.currentnessVerification.status,'verified');
  assert.equal(opened.graph.units.length,55);
  await opened.currentGraph();
  assert.equal(x.visits.length,0,'currentGraph() must also verify incrementally without re-enumerating 53 windows');

  // Negative controls across all 4 families (canonical, micro, state, lore)
  x.changeCanonical();
  await assert.rejects(()=>x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:false}),err=>{
    assert.equal(err.reason,'stale_generation');
    assert.deepEqual(err.currentnessVerification.changedFamilies,['canonical']);
    assert.deepEqual(err.currentnessVerification.changedWindows,[1]);
    return true;
  });
  await assert.rejects(()=>opened.currentGraph(),/STALE_GENERATION/);
  const rebuild1=await x.build();assert.equal(rebuild1.status,'published');

  x.change();
  await assert.rejects(()=>x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:false}),err=>{
    assert.equal(err.reason,'stale_generation');
    assert.deepEqual(err.currentnessVerification.changedFamilies,['micro']);
    assert.deepEqual(err.currentnessVerification.changedWindows,[52]);
    return true;
  });
  await x.build();

  x.changeState();
  await assert.rejects(()=>x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:false}),err=>{
    assert.equal(err.reason,'stale_generation');
    assert.deepEqual(err.currentnessVerification.changedFamilies,['state']);
    return true;
  });
  await x.build();

  x.changeLore();
  await assert.rejects(()=>x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:false}),err=>{
    assert.equal(err.reason,'stale_generation');
    assert.deepEqual(err.currentnessVerification.changedFamilies,['lore']);
    return true;
  });
  const latestBuilt=await x.build();

  // Eager audit re-enumerates all 53 windows even when incremental proof is available
  x.visits.length=0;
  const audited=await x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:true});
  assert.equal(x.visits.length,53,'eager audit must perform full window re-enumeration');
  assert.equal(audited.access.nativeReprojectionRequired,true);
  assert.equal(audited.access.currentnessVerification.mode,'eager_full_reprojection_audit');

  // Corrupted proof or projection record on disk is rejected
  const proofKey=latestBuilt.sourceProofs.proofKey;
  const savedProof=x.values.get(proofKey);
  x.values.set(proofKey,'{"tampered":true}');
  await assert.rejects(()=>x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:false}),/PAGE_CORRUPT/);
  x.values.set(proofKey,savedProof);

  const projKey=latestBuilt.sourceProofs.projectionKey;
  const savedProj=x.values.get(projKey);
  x.values.set(projKey,'{"tampered":true}');
  await assert.rejects(()=>x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:false}),/PAGE_CORRUPT/);
  x.values.set(projKey,savedProj);
  x.idle();
});

test('N01-B: incremental build reuses unchanged window slices on edit or append and supports multi-step checkpoint resume',async()=>{
  const x=fixture({count:10,canonicalCount:2,incrementalProof:true});
  const frameGraph=await x.initial();

  // 1. Multi-step checkpointed initial build (maxWindowsPerStep = 4 across 10 windows -> 3 steps: 4 + 4 + 2)
  x.visits.length=0;
  const step1=await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,options:{limit:1,maxWindowsPerStep:4}});
  assert.equal(step1.status,'checkpointed');
  assert.equal(step1.completedWindows,4);
  assert.equal(step1.enumeratedWindowCount,4);
  assert.equal(step1.reusedWindowCount,0);
  assert.equal(await x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:false}),null,'checkpoint must not publish a partial root');

  const step2=await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,options:{limit:1,maxWindowsPerStep:4}});
  assert.equal(step2.status,'checkpointed');
  assert.equal(step2.buildMode,'checkpoint_resume');
  assert.equal(step2.completedWindows,8);
  assert.equal(step2.reusedWindowCount,4);
  assert.equal(step2.enumeratedWindowCount,4);

  const step3=await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,options:{limit:1,maxWindowsPerStep:4}});
  assert.equal(step3.status,'published');
  assert.equal(step3.buildMode,'checkpoint_resume');
  assert.equal(step3.windowCount,10);
  assert.equal(step3.reusedWindowCount,8);
  assert.equal(step3.enumeratedWindowCount,2);

  // 2. Edit a single micro window (last window, ordinal 9): incremental build reuses windows 0..8 and only enumerates window 9
  x.change();
  x.visits.length=0;
  const incEdit=await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,options:{limit:1}});
  assert.equal(incEdit.status,'published');
  assert.equal(incEdit.buildMode,'incremental_reuse');
  assert.equal(incEdit.reusedWindowCount,9);
  assert.equal(incEdit.enumeratedWindowCount,1);
  assert.equal(x.visits.length,1,'only the 1 changed window must be re-enumerated');

  // 3. Append 2 new micro windows (10 -> 12): incremental build reuses windows 0..9 and only enumerates windows 10..11
  x.grow(2);
  x.visits.length=0;
  const incAppend=await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,options:{limit:1}});
  assert.equal(incAppend.status,'published');
  assert.equal(incAppend.buildMode,'incremental_reuse');
  assert.equal(incAppend.windowCount,12);
  assert.equal(incAppend.reusedWindowCount,10);
  assert.equal(incAppend.enumeratedWindowCount,2);
  assert.equal(x.visits.length,2,'only the 2 appended windows must be enumerated');

  // Verify the incrementally built corpus passes full eager re-enumeration audit
  const audited=await x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:true});
  assert.equal(audited.graph.units.length,14);
  assert.equal(audited.access.currentnessVerification.status,'verified');
  x.idle();
});

test('N01-B: oversized single index rows exceeding pageBytes are split deterministically across pages and reassembled with digest verification',async()=>{
  const x=fixture({count:3,canonicalCount:2,incrementalProof:true,hubEdges:12});
  const frameGraph=await x.initial();

  // With pageBytes: 512, the hub node:canonical0 row in reverseDependencies exceeds 512 bytes and must split
  const built=await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,options:{limit:1,pageBytes:512}});
  assert.equal(built.status,'published');
  assert.ok(built.storage.splitRowCount>0,'oversized index rows must be split across multiple pages');

  // Eager read reassembles all split rows and verifies table & index digests
  const eagerRead=await x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:true});
  assert.equal(eagerRead.compiledIndex.indexDigest,built.indexDigest);
  assert.ok(eagerRead.compiledIndex.reverseDependencies.length>=12);

  // Lazy readRows reassembles split rows on demand and supports queryPageAsync over reassembled rows
  const lazyRead=await x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:false});
  const revPage=await x.index.queryPageAsync(lazyRead.compiledIndex,{
    table:'reverseDependencies',
    dependencyKey:'node:canonical0',
    offset:0,
    pageBytes:512
  });
  assert.equal(revPage.items.length,1);
  assert.equal(revPage.items[0].dependencyKey,'node:canonical0');
  assert.equal(revPage.items[0].edgeIds.length,12);

  // Tampering with a split chunk slice in storage must fail closed with PAGE_CORRUPT
  const loc=x.corpus.location(frameGraph);
  const root=JSON.parse(x.values.get(loc.rootKey));
  const manifest=JSON.parse(x.values.get(root.manifestKey));
  const splitRef=manifest.refs.find(r=>r.splitRow);
  assert.ok(splitRef,'manifest must record splitRow metadata on split page refs');
  const rawSplitPage=x.values.get(splitRef.key);
  const parsedSplitPage=JSON.parse(rawSplitPage);
  parsedSplitPage[0].slice=parsedSplitPage[0].slice.slice(0,-1)+'X';
  x.values.set(splitRef.key,JSON.stringify(parsedSplitPage));
  x.pages.invalidate();
  await assert.rejects(()=>x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:true}),/PAGE_CORRUPT/);
  x.values.set(splitRef.key,rawSplitPage);
  x.idle();
});

test('N01-c: progressive storage access cursor and intermediate reassembly allow multi-step retrieval of split rows',async()=>{
  const x=fixture({count:3,canonicalCount:2,incrementalProof:true,hubEdges:16});
  const frameGraph=await x.initial();

  const built=await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,options:{limit:1,pageBytes:512}});
  assert.equal(built.status,'published');
  assert.ok(built.storage.splitRowCount>0);

  const lazyRead=await x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:false});
  const spec={table:'reverseDependencies',dependencyKey:'node:canonical0',offset:0,pageBytes:512};

  // Step 1: Read with maxPages: 1 budget -> stops on storage budget, returns storageCursor
  const step1=await x.index.queryPageAsync(lazyRead.compiledIndex,spec,{maxPages:1,maxBytes:8388608,pagesRead:0,bytesRead:0});
  assert.equal(step1.storageStopped,true);
  assert.equal(step1.stopReason,'storage_page_count_budget');
  assert.ok(step1.storageCursor,'must return intermediate storage cursor');
  assert.equal(step1.storageCursor.schema,'libra.graph_storage_access_cursor.v1');
  assert.equal(step1.storageCursor.table,'reverseDependencies');
  assert.equal(step1.storageCursor.refIndex,1);
  assert.equal(step1.storageCursor.assembledRowCount,0);

  // Step 2: Resume with step1.storageCursor and maxPages: 1
  let finalPage=await x.index.queryPageAsync(lazyRead.compiledIndex,{...spec,storageCursor:step1.storageCursor},{maxPages:1,maxBytes:8388608,pagesRead:0,bytesRead:0});

  // If split across more pages, continue draining
  while(finalPage.storageStopped&&finalPage.storageCursor){
    finalPage=await x.index.queryPageAsync(lazyRead.compiledIndex,{...spec,storageCursor:finalPage.storageCursor},{maxPages:1,maxBytes:8388608,pagesRead:0,bytesRead:0});
  }

  // Final page must have finished reassembly, returned items and storageCursor: null
  assert.equal(finalPage.storageStopped,undefined);
  assert.equal(finalPage.storageCursor,null);
  assert.equal(finalPage.items.length,1);
  assert.equal(finalPage.items[0].dependencyKey,'node:canonical0');
  assert.equal(finalPage.items[0].edgeIds.length,16);

  // Eager read produces the exact same reassembled row
  const eagerRead=await x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:true});
  const eagerRow=eagerRead.compiledIndex.reverseDependencies.find(r=>r.dependencyKey==='node:canonical0');
  assert.deepEqual(finalPage.items[0],eagerRow);

  // Failure cases:
  // 1. Invalid / tampered generation on cursor fails STORAGE_CURSOR_INVALID
  await assert.rejects(()=>x.index.queryPageAsync(lazyRead.compiledIndex,{...spec,storageCursor:{...step1.storageCursor,generation:'forged_gen'}},{maxPages:1,maxBytes:8388608,pagesRead:0,bytesRead:0}),/STORAGE_CURSOR_INVALID/);

  // 2. Out of range refIndex fails STORAGE_CURSOR_INVALID
  await assert.rejects(()=>x.index.queryPageAsync(lazyRead.compiledIndex,{...spec,storageCursor:{...step1.storageCursor,refIndex:9999}},{maxPages:1,maxBytes:8388608,pagesRead:0,bytesRead:0}),/STORAGE_CURSOR_INVALID/);

  x.idle();
});

test('checkpoint without an owner proof is re-enumerated after a source edit',async()=>{
  const x=fixture({count:4,canonicalCount:2});
  const initialGraph=await x.initial();
  assert.equal((await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph,options:{limit:1,maxWindowsPerStep:2}})).status,'checkpointed');
  x.changeCanonical();
  const built=await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph,options:{limit:1,maxWindowsPerStep:4}});
  assert.equal(built.status,'published');
  assert.equal(built.reusedWindowCount,0,'absence of proof cannot authorize reuse');
  assert.equal((await x.read()).graph.nodes.find(n=>n.id==='canonical1').bindingId,'binding1');x.idle();
});

test('a null currentness verifier result cannot authorize a checkpoint reuse',async()=>{
  const x=fixture({count:4,canonicalCount:2,incrementalProof:true});
  const initialGraph=await x.initial();
  assert.equal((await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph,options:{limit:1,maxWindowsPerStep:2}})).status,'checkpointed');
  x.changeCanonical();
  const verify=x.owner.verifySourceProofs;x.owner.verifySourceProofs=async(proof,options)=>options.phase==='build'?null:verify(proof,options);
  const built=await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph,options:{limit:1,maxWindowsPerStep:4}}).catch(error=>error);
  assert.equal(built.status,'published');
  assert.equal(built.reusedWindowCount,0,'a null proof result must never reuse the old slices');
  x.owner.verifySourceProofs=verify;x.idle();
});

test('a changed checkpoint payload is discarded before any saved graph can be reused',async()=>{
  const x=fixture({count:4,incrementalProof:true});const initialGraph=await x.initial();
  const step=await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph,options:{limit:1,maxWindowsPerStep:2}});
  const checkpoint=JSON.parse(x.values.get(step.checkpointKey));
  checkpoint.windowSlices[0].graph.units[0].text='corrupted saved evidence';
  x.values.set(step.checkpointKey,JSON.stringify(checkpoint));
  const result=await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph,options:{limit:1,maxWindowsPerStep:4}});
  assert.equal(result.status,'published');assert.equal(result.reusedWindowCount,0);
  assert.equal((await x.read()).graph.units.some(u=>u.text==='corrupted saved evidence'),false);x.idle();
});

test('v1 source proofs use native reprojection and never supply a new physical body baseline',async()=>{
  const x=fixture({count:4,incrementalProof:true});await x.build();const initialGraph=await x.initial(),loc=x.corpus.location(initialGraph);
  const root=JSON.parse(x.values.get(loc.rootKey)),manifest=JSON.parse(x.values.get(root.manifestKey));
  const proof=JSON.parse(x.values.get(manifest.sourceProofs.proofKey));proof.proofVersion='libra.source_proof_contract.v1';
  const proofRaw=JSON.stringify(proof),proofDigest=hash(proofRaw),proofKey=loc.prefix+'proof:'+proofDigest;
  x.values.set(proofKey,proofRaw);
  manifest.sourceProofs={...manifest.sourceProofs,proofVersion:proof.proofVersion,proofDigest,proofKey};
  const manifestRaw=JSON.stringify(manifest),digest=hash(manifestRaw),manifestKey=loc.prefix+'manifest:'+digest;
  x.values.set(manifestKey,manifestRaw);x.values.set(loc.rootKey,JSON.stringify({...root,digest,manifestKey}));
  x.visits.length=0;
  const result=await x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph,eager:false});
  assert.equal(result.access.nativeReprojectionRequired,true);assert.equal(x.visits.length,4);
  assert.equal(result.sourceProofs,null);await result.currentGraph();assert.equal(x.visits.length,8);x.idle();
});

test('one-window checkpoint steps can complete beyond the old 64-attempt scan ceiling',async()=>{
  const x=fixture({count:67,incrementalProof:true});const initialGraph=await x.initial();let result;
  for(let step=0;step<67;step++){
    result=await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph,options:{limit:1,maxWindows:128,maxWindowsPerStep:1}});
    if(step<66){assert.equal(result.status,'checkpointed');assert.equal(result.completedWindows,step+1);}
  }
  assert.equal(result.status,'published');assert.equal(result.windowCount,67);assert.equal(result.reusedWindowCount,66);x.idle();
});

test('N01-d: incremental build matches full rebuild byte-for-byte, resumes across cancellations, and refuses concurrent root-last CAS overwrite',async()=>{
  const x=fixture({count:10,canonicalCount:2,incrementalProof:true});
  const frameGraph=await x.initial();
  const rootKey=x.corpus.location(frameGraph).rootKey;

  // 1. Initial build
  const built1=await x.build();
  assert.equal(built1.status,'published');
  assert.equal(built1.windowCount,10);

  // 2. Incremental build vs Full rebuild comparison
  x.change();
  x.visits.length=0;
  const builtInc=await x.build({incremental:true});
  assert.equal(builtInc.status,'published');
  assert.equal(builtInc.buildMode,'incremental_reuse');
  assert.equal(builtInc.reusedWindowCount,9);
  assert.equal(builtInc.enumeratedWindowCount,1);
  assert.equal(x.visits.length,1);

  // Run full rebuild with incremental: false on the exact same state
  x.visits.length=0;
  const builtFull=await x.build({incremental:false});
  assert.equal(builtFull.status,'published');
  assert.equal(builtFull.buildMode,'full_build');
  assert.equal(builtFull.reusedWindowCount,0);
  assert.equal(builtFull.enumeratedWindowCount,10);
  assert.equal(x.visits.length,10);

  // Exact equivalence of generation, indexDigest, page counts, and query candidates
  assert.equal(builtInc.indexDigest,builtFull.indexDigest,'incremental build and full rebuild must produce identical indexDigest');
  assert.equal(builtInc.generation,builtFull.generation,'incremental build and full rebuild must produce identical generation');
  assert.equal(builtInc.pageCount,builtFull.pageCount);

  const readInc=await x.corpus.read({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,eager:true});
  assert.equal(readInc.compiledIndex.indexDigest,builtFull.indexDigest);
  assert.equal(readInc.access.currentnessVerification.status,'verified');

  // 3. Concurrent publication CAS protection: foreign root update refuses overwrite
  const stalePrevious=x.values.get(rootKey);
  const foreignRoot=JSON.stringify({schema:'libra.memory_graph_corpus_root.v1',manifestKey:'foreign:manifest',digest:hash('foreign')});
  x.values.set(rootKey,foreignRoot);

  await assert.rejects(async()=>{
    await x.owner.publish({
      key:rootKey,
      previous:stalePrevious,
      raw:JSON.stringify({schema:'libra.memory_graph_corpus_root.v1',manifestKey:'my:manifest',digest:hash('mine')}),
      manifestKey:'my:manifest',
      manifestRaw:'mine'
    });
  },/conflict/);
  assert.equal(x.values.get(rootKey),foreignRoot,'concurrent foreign root must never be overwritten on CAS failure');

  // Restore root for resumption testing
  x.values.set(rootKey,stalePrevious);

  // 4. Resumption across cancellation
  // Append 6 new windows: windows 0..9 are reused, 6 new windows need enumeration
  x.grow(6);

  // Step 1: enumerates 3 of the 6 new windows (windows 10..12) -> checkpoints at 13 windows
  const step1=await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,options:{limit:1,maxWindowsPerStep:3}});
  assert.equal(step1.status,'checkpointed');
  assert.equal(step1.completedWindows,13);
  assert.equal(step1.reusedWindowCount,10);
  assert.equal(step1.enumeratedWindowCount,3);

  // Step 2: cancellation occurs mid-flight
  x.cancel();
  await assert.rejects(async()=>{
    await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,options:{limit:1,maxWindowsPerStep:3}});
  },/canceled/);
  assert.equal(x.corpus.inspect().activeBuild,false,'canceled build must release build lock');

  // Step 3: resume after cancellation from step 1 checkpoint (enumerates remaining 3 windows 13..15)
  x.uncancel();
  const step3=await x.corpus.build({owner:x.owner,snapshot:x.snapshot,initialGraph:frameGraph,options:{limit:1,maxWindowsPerStep:3}});
  assert.equal(step3.status,'published');
  assert.equal(step3.windowCount,16);
  assert.equal(step3.reusedWindowCount,13,'resumed step must reuse the 13 completed windows from step 1');
  assert.equal(step3.enumeratedWindowCount,3);

  x.idle();
});

