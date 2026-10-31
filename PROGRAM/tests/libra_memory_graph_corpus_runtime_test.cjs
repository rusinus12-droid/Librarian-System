'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
for (const mode of ['plugin_only','server_only']) test(`${mode}: shipped API searches persisted whole-window index across restart and refuses changed sources`,async t=>{
  const x=await fixture({mode});t.after(()=>x.cleanup());
  const options={corpusMode:'required',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'},laneBudget:{maxPages:128,maxBytes:262144}};
  let api=x.f.r.api;
  await assert.rejects(()=>api.executeMemoryGraphUnifiedQuery(options),/CORPUS_MISSING_GENERATION/);
  const first=await api.executeMemoryGraphUnifiedQuery({...options,corpusMode:'window',limit:1});
  assert.equal(first.bundle.items.some(i=>i.family==='micro'),false);assert.equal(first.queryComplete,false);
  const built=await api.buildMemoryGraphCorpus({limit:1});assert.equal(built.status,'published');assert.equal(built.persistenceBackend,mode==='plugin_only'?'host_storage':'server_storage');assert.ok(built.windowCount>1);
  const records=()=>mode==='server_only'?x.server.storedRows().filter(row=>!row.key.includes(':memory-graph-control:v1:')):[...x.f.r.values].filter(([key])=>key.includes(':memory-graph:v1:'));
  const before=records(),calls=x.f.control.calls.length;
  const cold=await api.executeMemoryGraphUnifiedQuery(options),warm=await api.executeMemoryGraphUnifiedQuery({...options,corpusMode:'auto'});
  assert.equal(cold.corpusRead.storage.storageAccess,'selective_durable_pages');
  assert.ok(cold.corpusRead.storage.pagesRead>0&&cold.corpusRead.storage.pagesRead<cold.corpusRead.pageCount);
  assert.equal(cold.corpusRead.mode,'durable_common_index');assert.equal(cold.corpusRead.indexBuildsDuringQuery,0);
  assert.equal(cold.windowRead.scope,'enumerated_owner_windows');assert.equal(cold.windowRead.limit,1);
  assert.ok(cold.bundle.items.some(i=>i.family==='micro'&&i.text===QUOTE));assert.equal(cold.modelDispatchEligible,true);
  assert.equal(cold.queryComplete,true);assert.equal(cold.nextWindow,null);assert.equal(cold.windowRead.inventory.inventoryComplete,false);
  assert.equal(warm.bundle.bundleDigest,cold.bundle.bundleDigest);assert.deepEqual(records(),before);assert.equal(x.f.control.calls.length,calls);
  const cache=api.inspectMemoryGraphPages();assert.equal(cache.pins,0);assert.equal(cache.activeRequests,0);assert.ok(cache.counters.hits>0);
  await api.cancelMemoryGraphGenerationBuild();
  assert.equal((await api.executeMemoryGraphUnifiedQuery(options)).bundle.bundleDigest,cold.bundle.bundleDigest);
  await x.restart();api=x.f.r.api;
  const restarted=await api.executeMemoryGraphUnifiedQuery(options);
  assert.equal(restarted.corpusRead.indexDigest,cold.corpusRead.indexDigest);assert.equal(restarted.bundle.bundleDigest,cold.bundle.bundleDigest);
  // This source lives beyond the original limit-1 window. It must invalidate
  // the published generation rather than silently searching the first window.
  x.f.chat.message.find(row=>row.chatId==='t6-a').data+=' 원문이 바뀌었다.';
  await assert.rejects(()=>api.executeMemoryGraphUnifiedQuery(options),/CORPUS_|READER_|READ_/);
  const current=await api.executeMemoryGraphUnifiedQuery({...options,corpusMode:'auto'});
  assert.equal(current.corpusRead.mode,'request_local_corpus');assert.equal(current.corpusRead.reason,'superseded_derived_index');
});

test('stored canonical vectors seed the same durable-index frontier without lexical overlap or document embedding during retrieval',async t=>{
  const requests=[],config={enabled:true,provider:'openai',url:'https://synthetic.invalid/v1/embeddings',model:'text-embedding-3-small',
    key:'synthetic-only',dimensions:256,maxRetries:0};
  const x=await fixture({includeMicro:false,embeddingConfig:config,embeddingFetch:async(_url,init)=>{
    const input=JSON.parse(init.body).input;requests.push(input);
    return new Response(JSON.stringify({data:input.map((_,index)=>({index,embedding:Array.from({length:256},(_,i)=>i===0?1:0)}))}),{status:200});
  }});t.after(()=>x.cleanup());
  const api=x.f.r.api,before=requests.length;
  await api.buildMemoryGraphCorpus({limit:2});assert.equal(requests.length,before,'index maintenance does not embed documents');
  const options={corpusMode:'required',queryInput:{queryText:'keepsake custodian rendezvous'},consumerPolicy:{maxUnits:64}};
  const negative=await api.executeMemoryGraphUnifiedQuery({...options,semanticPolicy:{mode:'disabled'}});
  assert.equal(negative.bundle.items.some(i=>i.family==='canonical'),false);
  const result=await api.executeMemoryGraphUnifiedQuery(options),warm=await api.executeMemoryGraphUnifiedQuery(options);
  assert.equal(result.corpusRead.mode,'durable_common_index');assert.equal(result.corpusRead.indexBuildsDuringQuery,0);
  assert.equal(result.diagnostics.nativeSemantic.status,'available');assert.equal(result.diagnostics.nativeSemantic.queryRequestCount,1);
  assert.ok(result.bundle.items.some(i=>i.family==='canonical'));assert.equal(result.modelDispatchEligible,true);
  assert.equal(warm.additionalEmbeddingCalls,0);assert.equal(requests.length,before+1);
  assert.equal(result.diagnostics.nativeSemantic.documentEmbeddingCalls,0);
  await api.saveLibraMemorySettings({unifiedMemoryEngineMode:'unified'});
  const output=await x.f.control.hooks.beforeRequest([{role:'user',content:options.queryInput.queryText}],'model');
  assert.ok(output.some(row=>row.content.includes('[canonical:canonical_assertion]')));
  assert.equal(api.getLastMemoryRecall().corpusRead.mode,'durable_common_index');
  assert.equal(api.getLastMemoryRecall().corpusRead.indexBuildsDuringQuery,0);
  assert.equal(api.getRuntime().lastMemoryInjectionMeta.finalVerification.status,'verified');
  assert.equal(requests.length,before+1,'Classic uses the same owned query cache');
});

test('server corpus uses multiple bounded readsets and preserves unread native turns as partial coverage',async t=>{
  const anchor='const captureConditionalReadSet = async (keys = [], { readObserver = null, readBatchSize = null } = {}) => {';
  const x=await fixture({mode:'server_only',transformSource:source=>{
    assert.equal(source.split(anchor).length,2);
    return source.replace(anchor,anchor+' globalThis.__testCorpusPins ||= []; globalThis.__testCorpusPins.push(keys.length);');
  }});t.after(()=>x.cleanup());
  for (let turn=7;turn<=30;turn++) x.f.chat.message.push({role:'user',chatId:'extra-u'+turn,data:'추가 질문 '+turn},
    {role:'assistant',chatId:'extra-a'+turn,data:'추가 원문 '+turn});
  x.f.chat.messages=x.f.chat.message;
  const api=x.f.r.api;await api.buildMemoryGraphCorpus({limit:20});
  x.f.r.context.__testCorpusPins=[];
  const result=await api.executeMemoryGraphUnifiedQuery({corpusMode:'required',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'},laneBudget:{maxPages:128,maxBytes:262144}});
  const pins=Array.from(x.f.r.context.__testCorpusPins);
  assert.ok(pins.includes(64));assert.ok(pins.length>=2);assert.ok(pins.every(n=>n<=64));
  assert.equal(result.corpusRead.mode,'durable_common_index');assert.equal(result.queryComplete,false);
  assert.equal(result.sourceCoverageComplete,false);assert.equal(result.deliveryOutcome,'partial');
  assert.ok(result.coverage.sourceReadFailures.some(row=>row.family==='micro'));
  assert.equal(result.corpusRead.ownerAtomicity,false);assert.equal(result.modelDispatchEligible,true);
});
