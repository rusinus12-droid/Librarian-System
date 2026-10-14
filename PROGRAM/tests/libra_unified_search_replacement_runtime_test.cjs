'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture:writer}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {fixture:graphFixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const poisonLegacy=(f)=>{const get=f.r.values.get.bind(f.r.values),reads=[];
 f.r.values.get=key=>{if(/:recall-catalog:|:evidence-link-index:|:lore-link-index:/.test(key)){reads.push(key);throw Error('RETIRED_SEARCH_READ');}return get(key);};return reads;};
test('normal Classic request uses the new engine without opt-in, a stored index, a registered local route, or catalog reads',async t=>{
 const f=await writer();t.after(()=>f.r.cleanup());await f.run();const api=f.r.api,calls=f.control.calls.length,reads=poisonLegacy(f),before=[...f.r.values];
 const result=await api.previewUnifiedMemoryRecall({queryText:'은빛 열쇠'});
 assert.equal(result.diagnostics.memoryEngine.mode,'unified');assert.equal(result.corpusRead.mode,'request_local_corpus');
 assert.ok(result.memories.some(m=>m.family==='canonical'));assert.equal(result.unifiedExecution.modelDispatchEligible,true);
 const output=await f.control.hooks.beforeRequest([{role:'user',content:'은빛 열쇠'}],'model');
 assert.ok(output.some(row=>row.content.includes('[canonical:canonical_assertion]')));assert.equal(api.getRuntime().lastMemoryInjectionMeta.servedEngine,'unified');
 assert.equal(api.getRuntime().lastMemoryInjectionMeta.finalVerification.status,'verified');assert.equal(f.control.calls.length,calls);
 const context=api.getLastResponseContext(),viewer=api.getLastMemoryRecallViewer();
 assert.equal(viewer.responseContextDigest,context.contextDigest);assert.equal(viewer.scopeKey,result.scopeKey);
 assert.equal((await api.validateResponseContext(context)).current,true);
 assert.ok(viewer.rows.some(row=>row.family==='canonical'&&row.memoryId===f.getManifest().memories['1'].memoryId&&row.revision===1));
 assert.deepEqual([...f.r.values],before);assert.deepEqual(reads,[]);
 for(const name of ['debugRecallBm25fScoresLocal','debugRecallBm25fScoresWithCurrentOwner','debugRouteMemoryLaneCatalog'])assert.equal(api[name],undefined);
});
test('corrupt stored index refuses the request and never invokes a retired search or mutates the source',async t=>{
 const f=await writer();t.after(()=>f.r.cleanup());await f.run();const api=f.r.api;await api.buildMemoryGraphCorpus();poisonLegacy(f);
 const page=[...f.r.values.keys()].find(key=>key.includes(':memory-graph:v1:corpus:page:'));
 assert.ok(page);f.r.values.set(page,'CORRUPTED_INDEX');const before=[...f.r.values],calls=f.control.calls.length;
 const messages=[{role:'user',content:'은빛 열쇠'}],output=await f.control.hooks.beforeRequest(messages,'model');
 assert.deepEqual(output,messages);assert.equal(api.getLastMemoryRecallViewer().failOpen,true);
 assert.equal(api.getRuntime().lastMemoryInjectionMeta.injected,false);assert.deepEqual([...f.r.values],before);assert.equal(f.control.calls.length,calls);
});
test('old stored modes and old request modes all serve unified without a shadow/legacy search',async t=>{
 const f=await writer();t.after(()=>f.r.cleanup());await f.run();const api=f.r.api;poisonLegacy(f);
 for(const old of ['legacy','shadow']){
  const settings=await api.saveLibraMemorySettings({unifiedMemoryEngineMode:old});assert.equal(settings.unifiedMemoryEngineMode,'unified');
  const result=await api.previewUnifiedMemoryRecall({queryText:'은빛 열쇠',unifiedEngineMode:old});
  assert.equal(result.diagnostics.memoryEngine.mode,'unified');assert.equal(result.diagnostics.memoryEngine.retiredSelection,old);
  assert.equal(result.diagnostics.unifiedShadowEvaluation,undefined);assert.equal(result.unifiedExecution.legacyRankerExecuted,false);
 }
});
test('a cold default query reaches native Micro beyond turn 20 in the same corpus and reports gaps',async t=>{
 const x=await graphFixture({microTurn:26});t.after(()=>x.cleanup());const calls=x.f.control.calls.length,before=[...x.f.r.values];poisonLegacy(x.f);
 const result=await x.f.r.api.previewUnifiedMemoryRecall({queryText:QUOTE,consumerPolicy:{consumer:'classic',maxUnits:64,maxCharacters:12000},laneBudget:{maxPages:128,maxBytes:262144}});
 assert.equal(result.diagnostics.memoryEngine.mode,'unified');assert.equal(result.corpusRead.mode,'request_local_corpus');assert.ok(result.corpusRead.windowCount>=2);
 assert.ok(result.memories.some(m=>m.family==='micro'&&m.memory.turnRange.start===26));assert.equal(result.unifiedExecution.queryComplete,false);
 assert.equal(x.f.control.calls.length,calls);assert.deepEqual([...x.f.r.values],before);
});
test('canonical GUI search uses common lexical access, including Korean particles, and never reads the old catalog',async t=>{
 const f=await writer();t.after(()=>f.r.cleanup());await f.run();const api=f.r.api,reads=poisonLegacy(f),calls=f.control.calls.length;
 const result=await api.listCanonicalReaderChapters({query:'열쇠'});assert.ok(result.items.length);assert.equal(result.searchCoverage.engine,'unified');
 assert.equal(f.control.calls.length,calls);assert.deepEqual(reads,[]);
});
test('normal empty/cold owner can run the same engine without manufacturing an entity registry or analyzing source history',async t=>{
 const f=await writer();t.after(()=>f.r.cleanup());const api=f.r.api,calls=f.control.calls.length;
 const result=await api.previewUnifiedMemoryRecall({queryText:'현재 상황은?'});
 assert.equal(result.diagnostics.memoryEngine.mode,'unified');assert.equal(result.corpusRead.mode,'request_local_corpus');assert.equal(result.unifiedExecution.modelDispatchEligible,true);
 assert.equal(f.control.calls.length,calls);assert.equal([...f.r.values.keys()].some(k=>k.endsWith(':entity-registry:v1')),false);
 await f.control.hooks.beforeRequest([{role:'user',content:'현재 상황은?'}],'model');
 assert.equal(api.getRuntime().lastMemoryInjectionMeta.sourceTurnAccounting.completeUniqueOriginalTurns,0);
});
test('common evidence setting limits the normal delivery and its displayed context is invalid after source replacement',async t=>{
 const f=await writer();t.after(()=>f.r.cleanup());await f.run();const api=f.r.api;
 await api.saveLibraMemorySettings({unifiedMaxUnits:2});
 await f.control.hooks.beforeRequest([{role:'user',content:'은빛 열쇠'}],'model');
 const viewer=api.getLastMemoryRecallViewer(),context=api.getLastResponseContext();
 assert.ok(viewer.rows.length>0&&viewer.rows.length<=2);assert.equal((await api.validateResponseContext(context)).current,true);
 const key=f.getManifest().memories['1'].key,record=JSON.parse(f.r.values.get(key));
 f.r.values.set(key,JSON.stringify({...record,summary:'REPLACED_SOURCE'}));
 assert.equal((await api.validateResponseContext(context)).current,false);
});
