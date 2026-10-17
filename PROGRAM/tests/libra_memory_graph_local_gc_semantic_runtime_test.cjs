'use strict';
const assert=require('node:assert/strict');
let fake;try{fake=require('fake-indexeddb');}catch(_){fake=require('../build-support/node_modules/fake-indexeddb');}
const {fixture}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const dimensions=1024,axis=n=>Array.from({length:dimensions},(_,i)=>i===n?1:0);
const config={enabled:true,provider:'openai',url:'https://synthetic.invalid/v1/embeddings',model:'text-embedding-3-small',key:'synthetic-test-key',dimensions,maxRetries:0};
(async()=>{
 let calls=0;
 const embed=async(_url,init)=>{calls++;return new Response(JSON.stringify({data:JSON.parse(init.body).input.map((text,index)=>({index,embedding:axis(text==='semantic target'||text.includes('최후의 증표')?0:1)}))}),{status:200});};
 const x=await fixture({contextGlobals:{indexedDB:new fake.IDBFactory()},embeddingConfig:config,embeddingFetch:embed,microCount:30,
  microText:turn=>turn===35?'민아가 최후의 증표를 준호에게 건넸다.':'민아가 물건 '+turn+'번을 준호에게 건넸다.'});
 try{
  await x.f.r.api.retryPendingUnifiedVectors();
  for(const deadline=Date.now()+30000;x.f.r.api.inspectMicroRepresentationVectors().warming;){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,10));}
  const before=calls,build=await x.f.r.api.buildMemoryGraphCorpus();assert.equal(calls,before,'index build cannot embed documents or queries');
  assert.equal(build.persistenceBackend,'indexeddb');assert.equal(build.reclamation.status,'completed');
  for(let restart=0;restart<2;restart++){
   if(restart)await x.restart();
   const start=calls,result=await x.f.r.api.executeMemoryGraphUnifiedQuery({corpusMode:'required',queryInput:{queryText:'semantic target'},consumerPolicy:{maxUnits:64}});
   assert.equal(result.modelDispatchEligible,true);assert.ok(JSON.stringify(result.packet).includes('최후의 증표'));
   assert.equal(result.corpusRead.persistenceBackend,'indexeddb');assert.equal(result.diagnostics.nativeSemantic.microSelection.scanned,30);
   assert.equal(result.diagnostics.nativeSemantic.microSelection.selected,8);assert.equal(result.diagnostics.nativeSemantic.documentEmbeddingCalls,0);
   assert.ok(calls-start<=1);assert.equal(x.f.r.api.inspectMicroRepresentationVectors().cacheContents,'diagnostic_storage_keys_only');
  }
  const gc=await x.f.r.api.collectMemoryGraphGarbage({dryRun:false});assert.equal(gc.status,'completed');
  await x.f.r.api.deleteLibraScope();
  const empty=await x.f.r.api.collectMemoryGraphGarbage({dryRun:true});assert.equal(empty.inventoryRecords,0,'scope deletion clears the device-local derived records');
  console.log(JSON.stringify({test:'local_gc_dense_30_last_target',dimensions,microCount:30,restart:true,selected:8,documentEmbeddingCalls:0}));
 }finally{await x.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
