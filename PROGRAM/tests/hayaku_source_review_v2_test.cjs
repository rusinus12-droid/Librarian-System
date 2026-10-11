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
  assert.equal(rt.llmCalls.length,0,'ordinary request never reanalyzes a source edit');
  await rt.callAfterRequest('');
  const ticket=await rt.hayaku.previewSourceEdits(['1']);assert.equal(ticket.allowed,true,JSON.stringify(ticket));
  const result=await rt.hayaku.applySourceEdits(ticket);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.committed,true);
  const current=await t.currentChatScope(),snapshot=t.authoritativeChatSnapshot(current.chatMessages,current);
  const unit=t.hayakuReviewUnit(current,snapshot.conversationPairs[0]);
  const evidence=await t.getHayakuSourceEvidence().get(current.key,unit,{original:false});
  assert.equal(evidence.available,true);assert.equal(evidence.rows[0].assistantText,NEW);
  return {result,evidence};
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
 await test('explicit reanalysis saves current U+A while prior raw evidence stays immutable',async f=>{
  const original=f.before.records.find(record=>record.sourceEvidenceRef),bytes=f.rt.pluginStorage.values.get(original.sourceEvidenceRef.key);
  const {evidence}=await f.edit();assert.equal(f.rt.llmCalls.length,1);
  assert.match(evidence.rows[0].assistantRaw,/hayaku_packet_v1/);assert.notEqual(evidence.ref.key,original.sourceEvidenceRef.key);
  assert.equal(f.rt.pluginStorage.values.get(original.sourceEvidenceRef.key),bytes,'old evidence bytes are immutable');
  const after=(await f.rt.hayaku.ledger.inspect({includeRecords:true})).records;
  assert(after.some(row=>row.recordState==='active'&&row.sourceEvidenceRef?.key===evidence.ref.key));
 });
 await test('missing prior evidence is unavailable and never fabricates previous text',async f=>{
  const snapshot=f.t.authoritativeChatSnapshot(f.scope.chatMessages,f.scope),unit=f.t.hayakuReviewUnit(f.scope,snapshot.conversationPairs[0]);
  for(const key of [...f.rt.pluginStorage.values.keys()])if(key.startsWith('hayaku.v2.source-evidence.'))f.rt.pluginStorage.values.delete(key);
  const old=await f.t.getHayakuSourceEvidence().get(f.scope.key,unit,{original:false});assert.equal(old.available,false);assert.equal(old.rows,undefined);
  await f.edit();assert.equal(f.rt.llmCalls.length,1,'explicit rebuild independently pins current evidence');
 });
 await test('tampered prior evidence is rejected and cannot become current-source authority',async f=>{
  const snapshot=f.t.authoritativeChatSnapshot(f.scope.chatMessages,f.scope),unit=f.t.hayakuReviewUnit(f.scope,snapshot.conversationPairs[0]);
  const key=f.before.records.find(row=>row.sourceEvidenceRef).sourceEvidenceRef.key,raw=JSON.parse(f.rt.pluginStorage.values.get(key));raw.rows[0].userText='forged';
  f.rt.pluginStorage.values.set(key,JSON.stringify(raw));
  await assert.rejects(()=>f.t.getHayakuSourceEvidence().get(f.scope.key,unit,{original:false}),/DIGEST_MISMATCH/);
  const {evidence}=await f.edit();assert.equal(f.rt.llmCalls.length,1);assert(!JSON.stringify(evidence.rows).includes('forged'));
  assert.equal(f.rt.pluginStorage.values.get(key),JSON.stringify(raw),'current rebuild never overwrites corrupted prior bytes');
 });
 await test('wrong-scope selection and evidence lookup never reveal previous source or call provider',async f=>{
  const snapshot=f.t.authoritativeChatSnapshot(f.scope.chatMessages,f.scope),unit=f.t.hayakuReviewUnit(f.scope,snapshot.conversationPairs[0]);
  const foreign=await f.t.getHayakuSourceEvidence().get(f.scope.key+'foreign',unit,{original:false});assert.equal(foreign.available,false);assert.equal(foreign.rows,undefined);
  const inventory=await f.rt.hayaku.listReanalysisRanges();
  const result=await f.rt.hayaku.reanalyzeSelectedRanges({...inventory,scopeKey:f.scope.key+'foreign'});assert.equal(result.ok,false);assert.match(result.reason,/SCOPE/);
  assert.equal(f.rt.llmCalls.length,0);
 });
 console.log(JSON.stringify({test:'hayaku_source_review_v2',passed:results.length,results,environment:'full deployed HAYAKU + test host storage'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
