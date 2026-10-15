'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const {fiveMore}=require('./fixtures/libra_server_runtime_fixture.cjs');
const config={enabled:true,provider:'openai',url:'https://synthetic.invalid/v1/embeddings',model:'text-embedding-3-small',key:'fixture',dimensions:256,maxRetries:0};
test('persisted semantic directory routes a synonym-only query through Lane without reading the orthogonal owner vector',async t=>{
 let documents=0,queries=0;const queryText='unrelated semantic-only rendezvous';
 const x=await fixture({mode:'server_only',includeMicro:false,embeddingConfig:config,embeddingFetch:async(_url,init)=>{
  const inputs=JSON.parse(init.body).input,isQuery=inputs.length===1&&inputs[0]===queryText;
  if(isQuery)queries++;else documents++;
  const axis=isQuery||documents===1?0:1;
  return new Response(JSON.stringify({data:inputs.map((_,index)=>({index,embedding:Array.from({length:256},(_,i)=>i===axis?1:0)}))}),{status:200});
 }});t.after(()=>x.cleanup());
 fiveMore(x.f);x.f.control.onCall=null;await x.f.run();await x.f.r.api.retryPendingUnifiedVectors();
 for(let i=0;i<100&&x.server.getMemory(6)?.embedding?.status!=='ready';i++)await new Promise(r=>setTimeout(r,20));
 const one=x.server.getMemory(1),two=x.server.getMemory(6);assert.equal(two?.embedding?.status,'ready');
 const api=x.f.r.api;await api.buildMemoryGraphCorpus({limit:1});
 const directory=x.server.getRecords('libra.graph_semantic_directory.v1')[0];assert.ok(directory);assert.equal(directory.value.entries.length,2);
 const reads=new Map();x.server.hooks.beforeServerRequest=async(url,init)=>{
  const parsed=new URL(url);let keys=[];
  if(parsed.pathname==='/v1/kv/get')keys=[parsed.searchParams.get('key')];
  if(parsed.pathname==='/v1/kv/get-many')keys=JSON.parse(init.body).keys||[];
  for(const key of keys)reads.set(key,(reads.get(key)||0)+1);
 };
 const before=documents,result=await api.executeMemoryGraphUnifiedQuery({corpusMode:'required',queryInput:{queryText}});
 assert.equal(result.modelDispatchEligible,true);assert.ok(result.bundle.items.some(item=>item.family==='canonical'));
 assert.equal(result.diagnostics.nativeSemantic.prunedByExactBound,1);
 assert.equal(result.diagnostics.nativeSemantic.admittedRepresentations,1);
 assert.ok(reads.get(one.embedding.vectorKey)>0);assert.equal(reads.get(two.embedding.vectorKey)||0,0,'unselected vector body is never loaded');
 assert.ok(result.diagnostics.laneRoleStats.semantic_access.pages>0);
 const projection=x.server.getRecords('libra.graph_corpus_projection.v2')[0];assert.ok(projection);
 assert.equal(reads.get(projection.value.build.key)||0,0,'query never opens build-only window history');
 assert.equal(result.corpusRead.storage.projection.windowRecordsRead,0);
 assert.ok(result.diagnostics.resourceAccess.peakDecodeBytes<16*1024*1024,'query no longer decodes the complete snapshot');
 assert.equal(documents,before,'query never rebuilds document embeddings');assert.equal(queries,1);
 assert.equal(api.inspectMemoryGraphPages().pins,0);assert.equal(api.inspectMemoryGraphStore().resources.retainedBytes,0);
 const unused=directory.value.entries.find(entry=>entry.vectorKey===two.embedding.vectorKey).vectorPages[0];
 const stored=x.server.storedRows().find(row=>row.key===unused.key);await x.server.mutate(unused.key,{corrupted:true});
 const budget={maxDecodeBytes:134217728,maxRetainedBytes:209715200};
 const healthy=await api.executeMemoryGraphUnifiedQuery({corpusMode:'required',resourceBudget:budget,queryInput:{queryText}});assert.equal(healthy.modelDispatchEligible,true,'unrequested corruption stays outside the query');
 await assert.rejects(()=>api.verifyMemoryGraphCorpus({resourceBudget:budget}),/SEMANTIC_PAGE_CORRUPT/);
 await x.server.mutate(unused.key,stored.value);
 const gc=await api.collectMemoryGraphGarbage({dryRun:false});assert.equal(gc.status,'completed');
 for(const entry of directory.value.entries)for(const page of entry.vectorPages)assert.ok(!gc.deletedKeys.includes(page.key));
 // Recreate the pre-patch v1 artifact from the same genuine owner snapshots.
 // Its historical windows must not force a default query to decode them all.
 const savedRows=new Map(x.server.storedRows().map(row=>[row.key,row.value]));
 const unpack=record=>{
  const decoded={...record.graph};
  for(const [label,part] of Object.entries(record.parts)){
   const out=[];let chunks=[];
   for(const ref of part.refs)for(const row of savedRows.get(ref.key)){
    if(row.__chunkSchema){chunks.push(row.slice);if(chunks.length===row.chunkCount){out.push(JSON.parse(chunks.join('')));chunks=[];}}
    else out.push(row);
   }
   assert.equal(chunks.length,0);decoded[label]=out;
  }
  const {canonicalRows,...graph}=decoded;return {graph,canonicalRows};
 };
 const decoded=unpack(projection.value),buildHistory=savedRows.get(projection.value.build.key);
 const legacy={scopeKey:x.scopeKey,schema:'libra.graph_corpus_projection.v1',generation:projection.value.generation,frame:projection.value.frame,
  graph:decoded.graph,collected:{...projection.value.collected,canonicalRows:decoded.canonicalRows},windowSlices:buildHistory.windows.map(ref=>{
   const {schema,parts,graph,...meta}=savedRows.get(ref.key);return {...meta,...unpack(savedRows.get(ref.key))};
  })};
 const repo=x.server.app.repositories.libra,lease=repo.graphLifecycle.command({scopeKey:x.scopeKey,action:'acquire',kind:'build'});
 const put=(key,raw)=>repo.mutate({kind:'set',space:'plugin',key,value:raw,operationId:crypto.randomUUID(),graphLease:{scopeKey:x.scopeKey,token:lease.token}});
 const hash=raw=>crypto.createHash('sha256').update(raw).digest('hex'),prefix='libra:v1:scope:'+x.scopeKey+':memory-graph:v1:corpus:';
 const legacyRaw=JSON.stringify(legacy),projectionDigest=hash(legacyRaw),projectionKey=prefix+'projection:'+projectionDigest;put(projectionKey,legacyRaw);
 const manifest=x.server.getRecords('libra.graph_corpus.v1').find(row=>Array.isArray(row.value.refs));
 const updated={...manifest.value,sourceProofs:{...manifest.value.sourceProofs,projectionKey,projectionDigest}};
 const raw=JSON.stringify(updated),digest=hash(raw),manifestKey=prefix+'manifest:'+digest;put(manifestKey,raw);
 const root=x.server.storedRows().find(row=>row.key.startsWith(prefix+'root:'));put(root.key,JSON.stringify({...root.value,manifestKey,digest}));
 repo.graphLifecycle.command({scopeKey:x.scopeKey,action:'release',token:lease.token});
 const compatible=await api.executeMemoryGraphUnifiedQuery({queryInput:{queryText},resourceBudget:{maxDecodeBytes:16*1024*1024,maxRetainedBytes:32*1024*1024}});
 assert.equal(compatible.modelDispatchEligible,true,'existing v1 corpora work without a rebuild or raised default budgets');
 assert.equal(compatible.corpusRead.storage.projection.schema,'libra.graph_corpus_projection.v1');
 assert.equal(compatible.corpusRead.storage.projection.windowRecordsRead,0);
 assert.deepEqual(compatible.bundle.items.map(i=>i.nodeId),result.bundle.items.map(i=>i.nodeId));
 const messages=await x.f.control.hooks.beforeRequest([{role:'user',content:queryText}],'model');
 assert.equal(messages.length,2,'default Classic must deliver RAG after limit:1 publication');
 assert.equal(api.getRuntime().lastMemoryInjectionMeta.injected,true);
 assert.equal(api.getRuntime().lastMemoryInjectionMeta.finalVerification.status,'verified');
 console.log(JSON.stringify({suite:'projection_default_rag_budget',sourceBytes:result.diagnostics.resourceAccess.sourceBytes,
  durableBytes:result.diagnostics.resourceAccess.durableBytes,retainedPeak:result.diagnostics.resourceAccess.peakRetainedBytes,
  decodePeak:result.diagnostics.resourceAccess.peakDecodeBytes,projection:result.corpusRead.storage.projection}));
 const selected=directory.value.entries.find(entry=>entry.vectorKey===one.embedding.vectorKey).vectorPages[0];await x.server.mutate(selected.key,{corrupted:true});
 await assert.rejects(()=>api.executeMemoryGraphUnifiedQuery({corpusMode:'required',resourceBudget:budget,queryInput:{queryText}}),/SEMANTIC_PAGE_CORRUPT/);

});
