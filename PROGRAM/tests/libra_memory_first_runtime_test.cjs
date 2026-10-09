'use strict';
const assert=require('node:assert/strict');
const {fixture,artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
const results=[];
const success=x=>({type:'success',result:typeof x==='string'?x:JSON.stringify(x)});
const secondArtifact=()=>{const a=artifact();for(const x of [...a.entities,...a.facts])for(const e of x.evidenceSpans)e.ref=e.ref.replace(/^t(\d+)/,(_,n)=>`t${Number(n)+5}`);return a;};
const append=f=>f.chat.message.push(...f.chat.message.slice(0,10).map((m,i)=>({...m,chatId:`t${6+Math.floor(i/2)}-${i%2?'a':'u'}`})));
async function test(name,fn){const f=await fixture();try{await fn(f);results.push(name);}finally{await f.r.cleanup();}}
(async()=>{
 await test('single object inside prose is admitted with nested braces and escaped quotes',async f=>{
  f.control.onCall=async()=>success('분석 결과입니다.\n```json\n'+JSON.stringify(f.control.artifact)+'\n```\n분석을 마쳤습니다.');
  const r=await f.run();assert.equal(r.completed,1,JSON.stringify(r));assert.equal(countCalls(f.control).canonical,1);assert.ok(f.getMemory());assert.equal(f.getHead().throughTurn,5);
 });
 for(const [name,wrap] of [['multiple',s=>'결과 '+s+'\n'+s],['truncated',s=>'결과 '+s.slice(0,-1)],['array',s=>'결과 ['+s+']'],['quoted',s=>'결과 '+JSON.stringify(s)]])await test(name+' JSON cannot activate memory',async f=>{
  f.control.onCall=async()=>success(wrap(JSON.stringify(f.control.artifact)));const r=await f.run();assert.equal(r.completed,0,JSON.stringify(r));assert.equal(f.getMemory(),null);assert.equal(f.getHead(),null);assert.equal(countCalls(f.control).canonical,1);
 });
 await test('fixed State mapping is filled locally from an explicit fact reference',async f=>{
  f.control.artifact.stateBindings=f.control.artifact.stateBindings.map(b=>({factTempId:b.factTempId}));const r=await f.run();assert.equal(r.completed,1,JSON.stringify(r));assert.equal(f.getHead().throughTurn,5);assert.deepEqual(f.getMemory().canonicalArtifact,artifact());assert.equal(countCalls(f.control).canonical,1);
 });
 await test('invalid optional binding keeps facts and uses their fixed State destination',async f=>{
  f.control.artifact.stateBindings[0].stateField='not-a-real-field';const r=await f.run();assert.equal(r.completed,1,JSON.stringify(r));assert.deepEqual(f.getMemory().canonicalArtifact.facts,artifact().facts);assert.ok(f.getMemory().artifactValidation.stateBindingIssues.length);assert.equal(f.getHead().status,'ready');assert.equal(f.getHead().world.find(r=>r.name==='서재').state.parentRef,f.getHead().world.find(r=>r.name==='도서관').id);assert.equal(countCalls(f.control).canonical,1);
 });
 await test('a failed first batch does not block the second; filling the gap replays saved memory',async f=>{
  append(f);f.control.onCall=async()=>f.control.calls.length===1?success('bad JSON'):success(secondArtifact());
  const first=await f.run();assert.equal(first.completed,1,JSON.stringify(first));assert.equal(f.getMemory(),null);assert.ok(f.getMemory(6));assert.equal(f.getHead(),null);assert.equal(countCalls(f.control).canonical,2);
  const recall=await f.r.api.previewUnifiedMemoryRecall('민아 은빛 열쇠');assert.ok(recall.memories.some(row=>row.memory.turnRange.start===6),'saved memory remains searchable before State catches up');assert.equal(countCalls(f.control).canonical,2);
  const saved=f.getMemory(6).artifactDigest;f.control.onCall=async()=>success(artifact());
  const retry=await f.r.api.retryFailedMemoryAnalysis({startTurns:[1]});assert.equal(retry.completed,1,JSON.stringify(retry));assert.equal(countCalls(f.control).canonical,3);assert.equal(f.getMemory(6).artifactDigest,saved);assert.equal(f.getHead().throughTurn,10);assert.equal(f.getHead().status,'ready');
  const headBefore=JSON.stringify(f.getHead());await f.r.api.retryPendingUnifiedState();assert.equal(countCalls(f.control).canonical,3);assert.equal(JSON.stringify(f.getHead()),headBefore,'already replayed chain does not write State again');
 });
 await test('a gap replay storage failure keeps both memories and retries locally',async f=>{
  append(f);f.control.onCall=async()=>f.control.calls.length===1?success('bad JSON'):success(secondArtifact());await f.run();f.control.onCall=async()=>success(artifact());
  const storage=f.r.context.risuai.pluginStorage,original=storage.setItem;let hit=false;
  storage.setItem=async(k,v)=>{if(!hit&&JSON.parse(v)?.schema==='libra.continuity_state.v2'){hit=true;return true;}return original(k,v);};
  let job;try{job=await f.r.api.retryFailedMemoryAnalysis({startTurns:[1]});}finally{storage.setItem=original;}
  assert.ok(hit);assert.equal(job.completed,1);assert.ok(f.getMemory());assert.ok(f.getMemory(6));assert.equal(f.getHead(),null);
  await f.r.api.retryPendingUnifiedState();assert.equal(f.getHead().throughTurn,10);assert.equal(countCalls(f.control).canonical,3);
 });
 await test('changed source in a saved later range prevents gap replay from overwriting State',async f=>{
  append(f);f.control.onCall=async()=>f.control.calls.length===1?success('bad JSON'):success(secondArtifact());await f.run();
  f.control.onCall=async()=>success(artifact());f.chat.message[10].data+=' source changed';
  const job=await f.r.api.retryFailedMemoryAnalysis({startTurns:[1]});assert.equal(job.completed,1);assert.ok(f.getMemory());assert.ok(f.getMemory(6));assert.equal(f.getHead(),null);await f.r.api.retryPendingUnifiedState();assert.equal(f.getHead(),null);assert.equal(countCalls(f.control).canonical,3);
 });
 console.log(JSON.stringify({test:'libra_memory_first_runtime',passed:results.length,results,boundary:'full deployed plugin with controlled provider; physical mock storage readback'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
