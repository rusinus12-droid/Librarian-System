'use strict';
const assert=require('node:assert/strict');const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');const results=[];
const {countCalls}=require('./fixtures/libra_provider_call_kinds.cjs');
const config={enabled:true,provider:'openai',url:'https://synthetic.invalid/v1/embeddings',model:'text-embedding-3-small',key:'synthetic-not-a-real-key',dimensions:256,maxRetries:0};
const response=init=>{const input=JSON.parse(init.body).input;return new Response(JSON.stringify({data:input.map((_,index)=>({index,embedding:Array.from({length:256},(_,i)=>i===0?1:0)})),usage:{total_tokens:10}}),{status:200});};
async function test(name,fn){const f=await fixture();try{await fn(f);results.push(name);}finally{await f.r.cleanup();}}
(async()=>{
 await test('actual Classic beforeRequest injection includes terminal fact, no analysis extra calls',async f=>{
  await f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});await f.run();
  const q='민아의 은빛 열쇠 소유자와 현재 소지자는 누구야?',out=await f.control.hooks.beforeRequest([{role:'system',content:'장면을 이어가세요.'},{role:'user',content:q}],'model');
  const block=out.find(x=>x.content?.includes('[LIBRA CLASSIC RECALL'));assert.ok(block);assert.ok(block.content.includes('지호가 열쇠를 민아에게 반환했다.'));assert.ok(block.content.includes('은빛 열쇠의 소유자는 민아다.'));assert.ok(block.content.includes('[세계와 장면]'));assert.equal(f.control.calls.length,1);
  const recall=await f.r.api.previewUnifiedMemoryRecall(q);for(const row of recall.memories){assert.ok(row.excerpt.text.length<=row.excerpt.requestedChars);assert.ok(row.excerpt.sections.every(s=>['chronology','characters_relations','world_scene','narrative_open_threads','facts_uncertainty'].includes(s.sectionKey)));}
 });
 await test('saved Planner alias dispatches Classic with conditional canonical evidence through T5 and no helper call',async f=>{
  await f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'planner'});
  const saved=await f.r.api.getLibraProviderConfig();
  assert.equal(saved.responseFamily,'libra');assert.equal(saved.libraResponseMode,'classic');assert.equal(saved.injectionMode,'classic');
  await f.run();await f.r.api.getWorldManagerNarrative();
  const read=f.r.api.getCurrentStateHead(),library=read.world.find(x=>x.name==='도서관');
  assert.equal(read.throughTurn,5);assert.equal(library.state.rule.exceptions.length,1);
  assert.equal(library.state.rule.exceptions[0].condition,'허가된 공연 중');assert.equal(library.state.rule.exceptions[0].effect,'정숙 규칙 예외');
  const hall=f.r.api.getUnifiedWorldReadContext(read,'공연실');
  assert.deepEqual(f.clone(hall.rules[0].conditionalExceptions),[{location:'공연실',condition:'허가된 공연 중',effect:'정숙 규칙 예외',conditionStatus:'not_evaluated'}]);
  f.control.onCall=async()=>{throw new Error('retired helper must not run during Classic recall');};
  const out=await f.control.hooks.beforeRequest([{role:'user',content:'민아의 은빛 열쇠와 공연실의 정숙 규칙'}],'model');
  const block=out.find(x=>x.content?.includes('[LIBRA CLASSIC RECALL'));assert.ok(block,'the registered hook must inject Classic recall');
  // Classic quotes canonical fact text; the typed exception remains conditional in the UI Head.
  assert.ok(block.content.includes('도서관의 정숙 규칙은 공연실의 허가된 공연 동안만 예외다.'),'preserve the complete conditional rule in actual canonical injection');
  const manifest=f.getManifest(),context=f.r.api.getLastResponseContext();
  assert.equal(manifest.frontiers.contiguousCommittedTurn,5);assert.equal(context.route,'classic');assert.equal(context.canonicalRefs.length,1);
  const ref=context.canonicalRefs[0],active=manifest.memories['1'];
  for(const field of ['key','memoryId','revision','sourceDigest','artifactDigest'])assert.equal(ref[field],active[field],`request-bound canonical ${field}`);
  assert.deepEqual(f.clone(ref.turnRange),{start:1,end:5});
  assert.ok(block.content.includes('TURN 1~5'));assert.ok(block.content.includes(`memory ${ref.memoryId} r${ref.revision}`));
  assert.equal((await f.r.api.validateResponseContext(context)).ok,true,'the injected request still has current canonical authority');
  assert.deepEqual(countCalls(f.control),{total:1,micro:0,canonical:1,other:0},'exactly one Librarian call and no retired response helper');
 });
 await test('embedding await begins after public canonical/State completion and is independent',async f=>{
  await f.r.api.saveEmbeddingSettings(config);let entered=false,release;let calls=0;
  f.r.context.risuai.nativeFetch=async(url,init)=>{calls++;assert.equal(f.getManifest().memories['1'].status,'committed');assert.equal(f.getHead().throughTurn,5);assert.ok(f.getMemory());entered=true;await new Promise(resolve=>{release=resolve;});return response(init);};
  const result=await f.run();assert.equal(result.completed,1);await waitFor(()=>entered);assert.equal(f.getMemory().embedding.status,'pending');assert.equal(f.control.calls.length,1);release();
  await waitFor(()=>f.getMemory()?.embedding.status==='ready');assert.equal(calls,1);assert.equal(f.getMemory().embedding.dimensions,256);assert.equal(f.control.calls.length,1);
 });
 await test('failed embedding preserves canonical and sparse recall; explicit retry uses embedding only',async f=>{
  await f.r.api.saveEmbeddingSettings(config);let calls=0;f.r.context.risuai.nativeFetch=async()=>{calls++;throw new Error('deliberate_embedding_failure');};await f.run();await waitFor(()=>f.getMemory()?.embedding.status==='retry_pending');
  const m=f.getMemory(),head=JSON.stringify(f.getHead());assert.equal(f.control.calls.length,1);const recall=await f.r.api.previewUnifiedMemoryRecall('민아 은빛 열쇠');assert.ok(recall.memories.length);assert.equal(f.getMemory().artifactDigest,m.artifactDigest);
  f.r.context.risuai.nativeFetch=async(url,init)=>{calls++;return response(init);};const retry=await f.r.api.retryPendingUnifiedVectors();assert.equal(retry.completed,1,JSON.stringify(retry));assert.equal(f.getMemory().embedding.status,'ready');assert.equal(f.getMemory().artifactDigest,m.artifactDigest);assert.equal(JSON.stringify(f.getHead()),head);assert.equal(f.control.calls.length,1);assert.ok(calls>=2);
 });
 for(const change of ['source','model','scope'])await test(`${change} change while embedding is pending cannot attach old vector`,async f=>{
  await f.r.api.saveEmbeddingSettings(config);let entered=false,release,returned=false;
  f.r.context.risuai.nativeFetch=async(url,init)=>{entered=true;await new Promise(resolve=>{release=resolve;});returned=true;return response(init);};await f.run();await waitFor(()=>entered);const m=f.getMemory();
  if(change==='source')f.chat.message[0].data+=' 바뀐 원문';else if(change==='scope'){f.chat.id='new-chat';f.chat.chatId='new-chat';}else await f.r.api.saveEmbeddingSettings({...config,model:'text-embedding-3-large'});
  release();await waitFor(()=>returned);await new Promise(resolve=>setTimeout(resolve,80));
  assert.notEqual(f.getMemory()?.embedding.status,'ready');assert.equal(f.getMemory()?.artifactDigest,m.artifactDigest);assert.equal(f.control.calls.length,1);assert.equal(f.getRecords('libra.embedding_projection.v2').length,0);
 });
 console.log(JSON.stringify({test:'libra_unified_recall_vector_v1',passed:results.length,results,boundary:'actual host replacer/recall/embedding adapter; controlled nativeFetch without internet'}));
})().catch(e=>{console.error(e);process.exitCode=1});
