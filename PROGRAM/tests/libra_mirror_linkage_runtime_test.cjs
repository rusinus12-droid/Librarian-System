'use strict';
const assert=require('node:assert/strict');
const {serverFixture,fiveMore}=require('./fixtures/libra_server_runtime_fixture.cjs');
const results=[];
const expose=source=>source.replace('  const RisuCompat = (() => {','  globalThis.__auditStorageBridge = MemorySuiteStorageBridge;\n  const RisuCompat = (() => {');
const bridge=s=>s.f.r.context.__auditStorageBridge;
const canonicalCalls=s=>s.f.control.calls.filter(args=>
 !String(args[0]?.messages?.[0]?.content||'').includes('[LIBRA MICRO SOURCE CONTRACT]')).length;
async function test(name,fn,mode='mirror'){if(process.env.LIBRA_MIRROR_TEST_FILTER&&!name.includes(process.env.LIBRA_MIRROR_TEST_FILTER))return;const s=await serverFixture({mode,transformSource:expose});try{await fn(s);results.push(name);console.log('PASS',name);}catch(e){if(e.validation)console.error(JSON.stringify(e.validation));throw e;}finally{await s.cleanup();}}
const copies=s=>{for(const row of s.storedRows().filter(r=>r.key.endsWith(':manifest')||r.value?.schema==='libra.continuity_state.v2'||r.value?.schema==='libra.entity_registry.v2'))assert.equal(s.local.get(row.key),row.raw,row.key);};
(async()=>{
 await test('five and ten turns commit both stores; restart and recall use the same canonical',async s=>{
  assert.equal((await s.f.run()).completed,1);await s.f.r.api.retryPendingUnifiedVectors();copies(s);fiveMore(s.f);assert.equal((await s.f.run()).completed,1);await s.f.r.api.retryPendingUnifiedVectors();copies(s);
   assert.equal(s.getHead().throughTurn,10);assert.equal(canonicalCalls(s),2);await s.restart();
  assert.equal((await s.f.r.api.getUnifiedStorageStatus()).eligible,true);assert.equal((await bridge(s).getMode()),'mirror');
  const recall=await s.f.r.api.previewUnifiedMemoryRecall('은빛 열쇠');assert.ok(recall.memories.length);copies(s);
 });
 await test('lost commit response resolves once and local mirrors match',async s=>{
  let lost=0;s.hooks.afterBatch=async()=>{if(lost++<2)throw Error('response_lost');};
   assert.equal((await s.f.run()).completed,1);await s.f.r.api.retryPendingUnifiedVectors();assert.equal(canonicalCalls(s),1);copies(s);
 });
 await test('stale local Head cannot overwrite newer server Head on read or manual sync',async s=>{
  await s.f.run();const row=s.storedRows().find(r=>r.value?.schema==='libra.continuity_state.v2');
  const newer={...row.value,mirrorExternalMarker:'newer_server'};await s.mutate(row.key,newer);
  await s.f.r.api.getUnifiedStorageStatus();await bridge(s).synchronizeNow();
  assert.equal(s.getHead().mirrorExternalMarker,'newer_server');assert.equal(JSON.parse(s.local.get(row.key)).mirrorExternalMarker,'newer_server');
 });
 await test('lying local writes preserve server commit and repair after restart without another model call',async s=>{
  const original=s.backend.setItem;s.backend.setItem=async(k,v)=>k.includes(':continuity-state')?false:original.call(s.backend,k,v);
   assert.equal((await s.f.run()).completed,1);assert.equal(s.getHead().throughTurn,5);assert.equal(canonicalCalls(s),1);
  assert.ok(![...s.local.keys()].some(k=>k.includes(':continuity-state')));
  s.backend.setItem=original;await s.restart();await bridge(s).synchronizeNow();copies(s);assert.equal(s.f.control.calls.length,0);
 });
 await test('offline server cannot publish a new local canonical or perform an extra model call',async s=>{
  await s.f.run();await s.f.r.api.retryPendingUnifiedVectors();fiveMore(s.f);const head=JSON.stringify(s.getHead()),local=new Map(s.local),calls=s.f.control.calls.length;
  const api=s.f.r.context.risuai,old=api.nativeFetch;api.nativeFetch=async()=>{throw Error('offline');};
  let out,error;try{out=await s.f.run();}catch(e){error=e;}
  assert.ok(error||out.completed===0);assert.equal(s.f.control.calls.length,calls);assert.equal(JSON.stringify(s.getHead()),head);
  for(const [k,v] of local)if(k.includes(':continuity-state')||k.endsWith(':manifest'))assert.equal(s.local.get(k),v);
  api.nativeFetch=old;
 });
 await test('mirror to plugin-only restores server changes before changing route',async s=>{
  await s.f.run();const row=s.storedRows().find(r=>r.value?.schema==='libra.continuity_state.v2');await s.mutate(row.key,{...row.value,mirrorTransitionMarker:true});
  await bridge(s).setMode('plugin_only');assert.equal(await bridge(s).getMode(),'plugin_only');assert.equal(JSON.parse(s.local.get(row.key)).mirrorTransitionMarker,true);
 });
 await test('server Head failure leaves canonical pending and retries without another model call',async s=>{
  s.app.repositories.libra.database.exec("CREATE TEMP TRIGGER mirror_head_fail BEFORE INSERT ON kv WHEN NEW.key LIKE '%:continuity-state' BEGIN SELECT RAISE(ABORT,'mirror_head_failure'); END;");
  await s.f.run();assert.equal(s.getHead(),undefined);assert.equal(s.getMemory().status,'committed');
   assert.ok(![...s.local.keys()].some(k=>k.includes(':continuity-state')));assert.equal(canonicalCalls(s),1);
  s.app.repositories.libra.database.exec('DROP TRIGGER mirror_head_fail');await s.f.r.api.retryPendingUnifiedState();
   assert.equal(s.getHead().throughTurn,5);assert.equal(canonicalCalls(s),1);await s.f.r.api.retryPendingUnifiedVectors();copies(s);
 });
 await test('mirror embedding uses atomic server metadata and mirrors the resulting vector',async s=>{
  let calls=0;await s.f.r.api.saveEmbeddingSettings({enabled:true,provider:'openai',url:'https://synthetic.invalid/v1/embeddings',model:'text-embedding-3-small',key:'synthetic-not-a-real-key',dimensions:256,maxRetries:0});
  s.hooks.externalFetch=async(u,i)=>{calls++;return new Response(JSON.stringify({data:JSON.parse(i.body).input.map((_,index)=>({index,embedding:Array.from({length:256},(_,k)=>k===0?1:0)})),usage:{total_tokens:10}}),{status:200});};
  assert.equal((await s.f.run()).completed,1);await s.f.r.api.retryPendingUnifiedVectors();
  assert.equal(s.getMemory().embedding.status,'ready');assert.equal(calls,1);copies(s);
  const vector=s.getRecords('libra.embedding_projection.v2')[0];assert.ok(vector);assert.equal(s.local.get(vector.key),vector.raw);
 });
 await test('existing plugin-only v4 memories reject mirror and continue on server without reanalysis',async s=>{
  assert.equal((await s.f.run()).completed,1);await s.f.r.api.retryPendingUnifiedVectors();
  assert.equal(s.getHead(),undefined);await assert.rejects(()=>bridge(s).setMode('mirror'),e=>e.code==='MEMORY_SUITE_MIRROR_TRANSITION_ONLY');await bridge(s).setMode('server_only');
  const before=s.getMemory().artifactDigest;fiveMore(s.f);
  const out=await s.f.run();assert.equal(out.completed,1,JSON.stringify(out));await s.f.r.api.retryPendingUnifiedVectors();
   assert.equal(s.getMemory().artifactDigest,before);assert.equal(s.getHead().throughTurn,10);assert.equal(canonicalCalls(s),2);assert.equal(await bridge(s).getMode(),'server_only');
 },'plugin_only');
 console.log(JSON.stringify({test:'libra_mirror_linkage_runtime',passed:results.length,results,boundary:'real SQLite/HTTP and production LIBRA VM; synthetic RisuAI/model'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
