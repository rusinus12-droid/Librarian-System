'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
let fake;try{fake=require('fake-indexeddb');}catch(_){fake=require('../build-support/node_modules/fake-indexeddb');}
for(const mode of ['plugin_only','server_only'])test(`${mode}: shipped forest API publishes, routes, validates original evidence and survives reload`,async t=>{
  const x=await fixture({mode,contextGlobals:mode==='plugin_only'?{indexedDB:new fake.IDBFactory()}:undefined});t.after(()=>x.cleanup());
  let api=x.f.r.api;
  const built=await api.buildMemoryGraphCorpus({limit:1,shardWindows:2});
  assert.equal(built.status,'published');assert.equal(built.shardCount,3);
  const options={corpusMode:'required',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'},laneBudget:{maxPages:128,maxBytes:262144}};
  const result=await api.executeMemoryGraphUnifiedQuery(options);
  assert.equal(result.corpusRead.storage.storageAccess,'routed_durable_shards');assert.equal(result.modelDispatchEligible,true);
  assert.ok(result.bundle.items.some(i=>i.family==='micro'&&i.text===QUOTE));
  await x.restart();api=x.f.r.api;
  const again=await api.executeMemoryGraphUnifiedQuery(options);assert.equal(again.modelDispatchEligible,true);
  assert.deepEqual(Array.from(again.bundle.items,i=>i.text),Array.from(result.bundle.items,i=>i.text));

  x.f.chat.message.find(m=>m.chatId==='t6-a').data+=' changed';
  await assert.rejects(()=>api.executeMemoryGraphUnifiedQuery(options),/CORPUS_|READ_/);
});
test('server automatic reclamation removes an orphan after forest publication and keeps the routed evidence',async t=>{
  const x=await fixture({mode:'server_only'});t.after(()=>x.cleanup());const api=x.f.r.api;
  const orphan='libra:v1:scope:'+x.scopeKey+':memory-graph:v1:corpus:forest:'+'f'.repeat(64);
  await x.server.mutate(orphan,{orphan:true});
  await api.buildMemoryGraphCorpus({limit:1,shardWindows:2});
  await waitFor(()=>!x.server.storedRows().some(r=>r.key===orphan),15000);
  const result=await api.executeMemoryGraphUnifiedQuery({corpusMode:'required',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'}});
  assert.equal(result.modelDispatchEligible,true);assert.ok(result.bundle.items.some(i=>i.family==='micro'&&i.text===QUOTE));

});
test('a metadata-only manifest write refreshes the singleton shard proof instead of permanently reusing a stale proof',async t=>{
  const x=await fixture({pauseAutomaticAnalysis:true});t.after(()=>x.cleanup());const api=x.f.r.api;
  await api.buildMemoryGraphCorpus({limit:1,shardWindows:2});
  const key=[...x.f.r.values.keys()].find(k=>k.endsWith(':manifest'));
  x.f.r.values.set(key,JSON.stringify({...JSON.parse(x.f.r.values.get(key)),fixtureRoutingNote:'metadata-only-change'}));
  const built=await api.buildMemoryGraphCorpus({limit:1,shardWindows:2});assert.ok(built.reusedWindowCount>=2);
  const result=await api.executeMemoryGraphUnifiedQuery({corpusMode:'required',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'}});
  assert.equal(result.modelDispatchEligible,true);assert.ok(result.bundle.items.some(i=>i.text===QUOTE));
});
test('an incoming server query requests GC yield, waits internally and receives verified evidence',async t=>{
  const x=await fixture({mode:'server_only'});t.after(()=>x.cleanup());const api=x.f.r.api;
  await api.buildMemoryGraphCorpus({limit:1,shardWindows:2});
  const orphan='libra:v1:scope:'+x.scopeKey+':memory-graph:v1:corpus:forest:'+'e'.repeat(64);await x.server.mutate(orphan,{orphan:true});
  let held=false,sawYield=false,token='',release;const gate=new Promise(r=>release=r);
  x.server.hooks.beforeServerRequest=async(url,init)=>{
    if(!url.endsWith('/v1/libra/graph-lifecycle')||!init?.body)return;const body=JSON.parse(init.body);
    if(body.action==='delete'&&!held){held=true;token=body.token;await gate;}
    if(body.action==='yield')sawYield=true;
  };
  const gc=api.collectMemoryGraphGarbage({candidateKeys:[orphan]});
  try{
    await waitFor(()=>held,10000);
    const query=api.executeMemoryGraphUnifiedQuery({corpusMode:'required',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'}});
    await waitFor(()=>sawYield&&x.server.app.repositories.libra.graphLifecycle.command({scopeKey:x.scopeKey,action:'assert',token}).yieldRequested,5000);
    release();await gc;const result=await query;
    assert.equal(result.modelDispatchEligible,true);assert.ok(result.bundle.items.some(i=>i.text===QUOTE));
  }finally{release();x.server.hooks.beforeServerRequest=null;await gc.catch(()=>{});}
});
test('semantic-only canonical evidence still reaches the single kernel through the forest and shares one query embedding',async t=>{
  const requests=[],config={enabled:true,provider:'openai',url:'https://synthetic.invalid/v1/embeddings',model:'text-embedding-3-small',key:'synthetic-only',dimensions:256,maxRetries:0};
  const x=await fixture({includeMicro:false,embeddingConfig:config,embeddingFetch:async(_url,init)=>{
    const input=JSON.parse(init.body).input;requests.push(input);
    return new Response(JSON.stringify({data:input.map((_,index)=>({index,embedding:Array.from({length:256},(_,i)=>i===0?1:0)}))}),{status:200});
  }});t.after(()=>x.cleanup());const api=x.f.r.api,before=requests.length;
  await api.buildMemoryGraphCorpus({limit:1,shardWindows:2});assert.equal(requests.length,before,'maintenance creates no document embeddings');
  const options={corpusMode:'required',queryInput:{queryText:'keepsake custodian rendezvous'},consumerPolicy:{maxUnits:64}};
  const lexical=await api.executeMemoryGraphUnifiedQuery({...options,semanticPolicy:{mode:'disabled'}});
  assert.equal(lexical.bundle.items.some(i=>i.family==='canonical'),false);
  const result=await api.executeMemoryGraphUnifiedQuery(options);assert.equal(result.modelDispatchEligible,true);
  assert.ok(result.bundle.items.some(i=>i.family==='canonical'));assert.equal(requests.length,before+1);
  const warm=await api.executeMemoryGraphUnifiedQuery(options);assert.equal(warm.additionalEmbeddingCalls,0);assert.equal(requests.length,before+1);
});
test('current State follows exact late Micro provenance after sealed historical shards are reused',async t=>{
  const x=await fixture({pauseAutomaticAnalysis:true,transformSource:source=>source
    .replace('const memoryGraphSourceFingerprint =','globalThis.__forestDigest=digest; const memoryGraphSourceFingerprint =')
    .replace("owner.resources?.retain(graph,'forest_selected_graph');","globalThis.__forestSelected=graph; owner.resources?.retain(graph,'forest_selected_graph');")});
  t.after(()=>x.cleanup());const api=x.f.r.api;
  await api.buildMemoryGraphCorpus({limit:1,shardWindows:2});
  const record=x.active.record,span=record.claims[0].evidence,head=await x.f.getHead();
  const row=head.characters[0];row.state.current_state=QUOTE;
  row.fieldEvidence.current_state={schema:'libra.micro_state_field_evidence.v1',status:'state_admitted',turn:6,
    receiptKey:record.receiptKey,sourceRevisionId:record.sourceRevisionId,sourceDigest:record.sourceDigest,
    analysisRevisionId:record.analysisRevisionId,claimDigest:x.f.r.context.__forestDigest(record.claims[0]),...span};
  const key=[...x.f.r.values.keys()].find(k=>k.endsWith(':continuity-state'));
  x.f.r.values.set(key,JSON.stringify(head));
  const built=await api.buildMemoryGraphCorpus({limit:1,shardWindows:2});assert.ok(built.reusedWindowCount>=2);
  const result=await api.executeMemoryGraphUnifiedQuery({corpusMode:'required',queryInput:{queryText:'current_state'},semanticPolicy:{mode:'disabled'}});
  assert.ok(result.corpusRead.stateEvidenceReprojectionPages>=1);assert.equal(result.corpusRead.nativeReprojectionRequired,true);
  const graph=x.f.r.context.__forestSelected,state=graph.units.find(u=>u.family==='state'&&u.field==='current_state');
  assert.ok(state);const micro=graph.units.find(u=>u.family==='micro'&&u.turn===6);assert.ok(micro);
  assert.ok(graph.edges.some(e=>e.from===state.nodeId&&e.to===micro.nodeId&&e.predicate==='derived_from'));
  row.fieldEvidence.current_state.claimDigest='mismatching-claim';x.f.r.values.set(key,JSON.stringify(head));
  await api.buildMemoryGraphCorpus({limit:1,shardWindows:2});
  await api.executeMemoryGraphUnifiedQuery({corpusMode:'required',queryInput:{queryText:'current_state'},semanticPolicy:{mode:'disabled'}});
  const invalid=x.f.r.context.__forestSelected,badState=invalid.units.find(u=>u.family==='state'&&u.field==='current_state');
  assert.ok(!invalid.edges.some(e=>e.from===badState.nodeId&&e.predicate==='derived_from'));
});
test('the shipped API passes 64 windows and retrieves a real Micro at turn 70 without provider work during maintenance',async t=>{
  const x=await fixture({microTurn:6,microCount:65,pauseAutomaticAnalysis:true,contextGlobals:{indexedDB:new fake.IDBFactory()},
    microText:turn=>turn===70?QUOTE:'민아는 은빛 열쇠에 관해 다른 기록 '+turn+'을 남겼다.'});
  t.after(()=>x.cleanup());const api=x.f.r.api,calls=x.f.control.calls.length;
  const cold=await api.executeMemoryGraphUnifiedQuery({corpusMode:'auto',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'}});
  assert.equal(cold.corpusRead.mode,'request_local_corpus');assert.equal(cold.corpusRead.selectionComplete,false);
  assert.equal(cold.queryComplete,false);assert.ok(cold.nextWindow,'unread history remains explicit until the durable forest is ready');
  const timer=setInterval(()=>{const p=api.inspectDurableGraphStatus().buildProgress;console.log('forest70-progress',p&&{phase:p.phase,windows:p.windowsDone,shards:p.shardsDone});},5000);timer.unref();
  let built,steps=0;try{do{built=await api.buildMemoryGraphCorpus({limit:1,maxShardsPerStep:64});assert.ok(++steps<=70);}while(built.status==='checkpointed');}finally{clearInterval(timer);}
  assert.equal(built.status,'published');assert.equal(built.windowCount,70);assert.ok(built.shardCount>1);
  assert.equal(built.persistenceBackend,'indexeddb');
  assert.equal(x.f.control.calls.length,calls);
  const result=await api.executeMemoryGraphUnifiedQuery({corpusMode:'required',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'},laneBudget:{maxPages:128,maxBytes:262144}});
  assert.equal(result.modelDispatchEligible,true);assert.ok(result.bundle.items.some(i=>i.family==='micro'&&i.text===QUOTE));
  assert.ok(result.corpusRead.selectedShardCount<=result.corpusRead.shardCount);
  assert.ok(result.accessTrace.resources.pool.peakRetainedBytes<=result.accessTrace.resources.pool.limits.retainedBytes);
});
