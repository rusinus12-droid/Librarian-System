'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const OLD='Alice signed the office agreement.';
const NEW='Alice did not sign the office agreement.';
const results=[];
function envelope(sourceText){
 const packet=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:sourceText});
 packet.entity.characters=[{name:'Alice'}];
 packet.planner.continuity_locks=[sourceText];
 const grounding=[];
 const walk=(value,path)=>{
  if(Array.isArray(value)){value.forEach((item,index)=>{if(item!=null&&(typeof item!=='string'||item.trim()))grounding.push({path:path+'['+index+']',source:'target',evidence:[sourceText]});});return;}
  if(value&&typeof value==='object')for(const [key,item] of Object.entries(value))walk(item,path?path+'.'+key:key);
 };
 for(const key of ['entity','world','narrative','planner'])walk(packet[key],key);
 grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[sourceText]});
 return {schema:'hayaku.native_repair_output.v1',packet,grounding};
}
async function fixture(){
 const packet=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:OLD});
 const rt=await createHayakuRuntime({autoRepair:false,messages:[
  {role:'user',id:'u1',chatId:'u1',data:'What does Alice do?'},
  {role:'assistant',id:'a1',chatId:'a1',data:hiddenPacketMessage(OLD,packet)}
 ]});
 const t=rt.hayaku._test,scope=await t.currentChatScope();
 await t.reconcileObservedChatTopology(scope,t.authoritativeChatSnapshot(scope.chatMessages,scope),'review-fixture');
 const before=await rt.hayaku.ledger.inspect({includeRecords:true});
 const edit=async()=>{
  rt.chat.message[1].data=hiddenPacketMessage(NEW,packet);
  rt.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
  await rt.callBeforeRequest([{role:'user',content:'Continue after the changed source.'}],'model');
  const status=rt.hayaku.getSourceEditSyncStatus();
  const review=await t.loadHayakuSourceReview(status.tasks,scope.key);
  return {status,review};
 };
 return {rt,t,scope,before,edit};
}
async function test(name,fn){const f=await fixture();try{await fn(f);results.push(name);}finally{await f.rt.dispose();}}
(async()=>{
 await test('normal packet saves actual U+A and raw carrier separately',async f=>{
  const active=f.before.records.find(record=>record.sourceEvidenceRef);
  assert.ok(active,'source ref written in ordinary successful ledger capture');
  const raw=JSON.parse(f.rt.pluginStorage.values.get(active.sourceEvidenceRef.key));
  assert.equal(raw.rows.length,1);assert.equal(raw.rows[0].assistantText,OLD);
  assert.match(raw.rows[0].assistantRaw,/HAYAKU_STATE_PACKET_START/);
  assert.notEqual(raw.rows[0].assistantText,active.raw);
  assert.equal(f.rt.llmCalls.length,0,'observation does not perform analysis');
 });
 await test('beforeRequest automatically reanalyzes and saves the actual source change',async f=>{
  const {status,review}=await f.edit();
  assert.equal(f.rt.llmCalls.length,1);
  assert.equal(status.tasks[0].state,'applied');
  assert.equal(review.rows.length,1);
  const row=review.rows[0];
  assert.equal(row.previousUnavailable,false);assert.equal(row.currentValid,true);
  assert.match(row.beforeText,/Alice signed/);assert.match(row.afterText,/Alice did not sign/);
  assert.doesNotMatch(row.beforeText,/hayaku_packet_v1/);assert.match(row.beforeRaw,/hayaku_packet_v1/);
 });
 await test('missing prior raw evidence never fabricates old text or a diff',async f=>{
  for(const key of [...f.rt.pluginStorage.values.keys()])if(key.startsWith('hayaku.v2.source-evidence.'))f.rt.pluginStorage.values.delete(key);
  const {status,review}=await f.edit();
  assert.equal(f.rt.llmCalls.length,1,'current source is still automatically rebuilt');
  assert.equal(status.tasks[0].state,'applied');
  assert.equal(status.tasks[0].originalEvidenceUnavailable,true);
  assert.equal(review.rows[0].previousUnavailable,true);
  assert.equal(review.rows[0].beforeText,'');
  assert.match(review.rows[0].afterText,/Alice did not sign/);
 });
 await test('tampered prior evidence is rejected while current source rebuild remains automatic',async f=>{
  const key=[...f.rt.pluginStorage.values.keys()].find(item=>item.startsWith('hayaku.v2.source-evidence.'));
  const raw=JSON.parse(f.rt.pluginStorage.values.get(key));raw.rows[0].userText='forged';
  f.rt.pluginStorage.values.set(key,JSON.stringify(raw));
  const {status,review}=await f.edit();
  assert.equal(f.rt.llmCalls.length,1);assert.equal(status.tasks[0].state,'applied');
  assert.equal(status.tasks[0].originalEvidenceUnavailable,true);
  assert.equal(review.rows[0].previousUnavailable,true);assert.equal(review.rows[0].beforeText,'');
  assert.match(review.rows[0].previousError,/DIGEST_MISMATCH/);
 });
 await test('wrong scope evidence read is rejected without another provider call',async f=>{
  await assert.rejects(()=>f.t.loadHayakuSourceReview([],f.scope.key+'foreign'),/SCOPE_CHANGED/);
  assert.equal(f.rt.llmCalls.length,0);
 });
 console.log(JSON.stringify({test:'hayaku_source_review_v2',passed:results.length,results,environment:'full deployed HAYAKU + test host storage'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
