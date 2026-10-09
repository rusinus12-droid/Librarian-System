'use strict';
const assert=require('node:assert/strict');const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');const results=[];
const config={enabled:true,provider:'openai',url:'https://synthetic.invalid/v1/embeddings',model:'text-embedding-3-small',key:'synthetic-not-a-real-key',dimensions:256,maxRetries:0};
const response=i=>new Response(JSON.stringify({data:JSON.parse(i.body).input.map((_,index)=>({index,embedding:Array.from({length:256},(_,k)=>k===0?1:0)})),usage:{total_tokens:10}}),{status:200});
async function wait(fn){for(let i=0;i<1200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('server vector observation timeout');}
async function test(name,fn){const s=await serverFixture();try{await fn(s);results.push(name);console.log('PASS',name);}finally{await s.cleanup();}}
(async()=>{
 await test('disabled embedding metadata is committed after canonical/state without analysis',async s=>{await s.f.run();const r=await s.f.r.api.retryPendingUnifiedVectors();assert.equal(s.getMemory().embedding.status,'disabled',JSON.stringify(r));assert.equal(s.getManifest().memories['1'].embeddingStatus,'disabled');assert.equal(s.f.control.calls.length,1);assert.ok(s.batches.some(b=>b.mutations.some(m=>m.key.includes(':memory:'))&&b.mutations.some(m=>m.key.endsWith(':manifest'))));});
 await test('server vector and exact memory/manifest metadata complete separately from normal five-turn job',async s=>{
  let entered=false,release,calls=0;await s.f.r.api.saveEmbeddingSettings(config);s.hooks.externalFetch=async(u,i)=>{calls++;entered=true;assert.equal(s.getHead().throughTurn,5);await new Promise(r=>release=r);return response(i);};
  const job=await s.f.run();assert.equal(job.completed,1);await wait(()=>entered);assert.equal(s.getMemory().embedding.status,'pending');release();await wait(()=>s.getMemory().embedding.status==='ready');assert.equal(s.getMemory().embedding.dimensions,256);assert.equal(s.getManifest().memories['1'].embeddingStatus,'ready');assert.equal(s.getRecords('libra.embedding_projection.v2').length,1);assert.equal(calls,1);assert.equal(s.f.control.calls.length,1);
 });
 await test('failed metadata SQL commit keeps pending memory and retries staged vector without calling provider again',async s=>{
  let entered=false,release,calls=0;await s.f.r.api.saveEmbeddingSettings(config);s.hooks.externalFetch=async(u,i)=>{calls++;entered=true;await new Promise(r=>release=r);return response(i);};await s.f.run();await wait(()=>entered);const key=s.getManifest().memories['1'].key;
  s.app.repositories.libra.database.exec(`CREATE TEMP TRIGGER vector_meta_fail BEFORE UPDATE ON kv WHEN NEW.key='${key}' BEGIN SELECT RAISE(ABORT,'vector_metadata_failure'); END;`);release();await wait(()=>s.getRecords('libra.unified_server_vector_tx.v1').some(r=>r.value.serverPrepared));
  await s.f.r.api.retryPendingUnifiedVectors();assert.equal(s.getMemory().embedding.status,'pending');assert.equal(calls,1);assert.equal(s.getRecords('libra.embedding_projection.v2').length,1);
  s.app.repositories.libra.database.exec('DROP TRIGGER vector_meta_fail');const retry=await s.f.r.api.retryPendingUnifiedVectors();assert.equal(retry.completed,1,JSON.stringify(retry));assert.equal(s.getMemory().embedding.status,'ready');assert.equal(s.getManifest().memories['1'].embeddingStatus,'ready');assert.equal(calls,1);assert.equal(s.f.control.calls.length,1);assert.equal(s.getRecords('libra.unified_server_vector_tx.v1').length,0);
 });
 await test('embedding failure preserves sparse recall and explicit retry only re-embeds',async s=>{
  await s.f.r.api.saveEmbeddingSettings(config);let calls=0;s.hooks.externalFetch=async()=>{calls++;throw Error('controlled_embedding_failure');};await s.f.run();await wait(()=>s.getMemory().embedding.status==='retry_pending');const a=s.getMemory().artifactDigest;
  const recall=await s.f.r.api.previewUnifiedMemoryRecall('민아 은빛 열쇠');assert.ok(recall.memories.length);s.hooks.externalFetch=async(u,i)=>{calls++;return response(i);};const r=await s.f.r.api.retryPendingUnifiedVectors();assert.equal(r.completed,1,JSON.stringify(r));assert.equal(s.getMemory().embedding.status,'ready');assert.equal(s.getMemory().artifactDigest,a);assert.equal(s.f.control.calls.length,1);assert.ok(calls>=2);
 });
 await test('definite metadata-only conflict rebases once, preserving progress and the original staged vector',async s=>{
  let calls=0,raced=false;await s.f.r.api.saveEmbeddingSettings(config);s.hooks.externalFetch=async(u,i)=>{calls++;return response(i);};
  s.hooks.beforeBatch=async b=>{const m=b.mutations.find(m=>m.key.includes(':memory:'));if(raced||!m||JSON.parse(m.value).embedding?.status!=='ready')return;raced=true;const mk=b.mutations.find(m=>m.key.endsWith(':manifest')).key;const old=s.getManifest();await s.mutate(mk,{...old,stats:{...old.stats,seventhProgressMarker:77}});};
  await s.f.run();await wait(()=>s.getMemory()?.embedding?.status==='ready');assert.equal(raced,true);assert.equal(calls,1);assert.equal(s.getManifest().stats.seventhProgressMarker,77);assert.equal(s.f.control.calls.length,1);
  const batches=s.batches.filter(b=>b.mutations.some(m=>m.key.includes(':memory:')&&JSON.parse(m.value).embedding?.status==='ready'));assert.ok(batches.length>=2);assert.notEqual(batches[0].operationId,batches[1].operationId);assert.equal(s.getRecords('libra.embedding_projection.v2').length,1);
 });
 await test('metadata rebase cannot refresh a changed canonical revision into success',async s=>{
  let raced=false;await s.f.r.api.saveEmbeddingSettings(config);s.hooks.externalFetch=async(u,i)=>response(i);
  s.hooks.beforeBatch=async b=>{const m=b.mutations.find(m=>m.key.includes(':memory:'));if(raced||!m||JSON.parse(m.value).embedding?.status!=='ready')return;raced=true;const old=s.getMemory();await s.mutate(m.key,{...old,seventhExternalCorrection:'preserve'});};
  await s.f.run();await wait(()=>raced);await new Promise(r=>setTimeout(r,120));const out=await s.f.r.api.retryPendingUnifiedVectors();assert.equal(out.completed,0,JSON.stringify(out));assert.equal(s.getMemory().seventhExternalCorrection,'preserve');assert.notEqual(s.getMemory().embedding.status,'ready');assert.equal(s.f.control.calls.length,1);
 });
 for(const change of ['source','model','ABA'])await test(`${change} during embedding wait rejects stale vector without canonical loss`,async s=>{
  let entered=false,release,returned=false;await s.f.r.api.saveEmbeddingSettings(config);s.hooks.externalFetch=async(u,i)=>{entered=true;await new Promise(r=>release=r);returned=true;return response(i);};await s.f.run();await wait(()=>entered);const a=s.getMemory().artifactDigest;
  if(change==='source')s.f.chat.message[0].data+=' changed';else if(change==='model')await s.f.r.api.saveEmbeddingSettings({...config,model:'text-embedding-3-large'});else{const k=s.getManifest().memories['1'].key,m=s.getMemory();await s.mutate(k,{...m,externalMarker:'ABA'});await s.mutate(k,m);}
  release();await wait(()=>returned);await new Promise(r=>setTimeout(r,120));assert.notEqual(s.getMemory().embedding.status,'ready');assert.equal(s.getMemory().artifactDigest,a);assert.equal(s.getRecords('libra.embedding_projection.v2').length,0);assert.equal(s.f.control.calls.length,1);
 });
 console.log(JSON.stringify({test:'libra_unified_server_vector_v1',passed:results.length,results,boundary:'production LIBRA embedding path and real server; controlled external embedding responses only'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
