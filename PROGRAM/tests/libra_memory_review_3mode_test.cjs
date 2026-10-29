'use strict';
const assert=require('node:assert/strict');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
(async()=>{
 for(const mode of ['plugin_only','mirror','server_only']){
  let listener;const fx=await serverFixture({mode,host:{addRisuChatListener:async(_,fn)=>{listener=fn;return true;}}});
  try{
   const {f}=fx;assert.equal((await f.run()).completed,1);
   f.chat.message.push({role:'user',chatId:'t6-u',data:'문은?'},{role:'assistant',chatId:'t6-a',data:'도서관 문이 열렸다. 도서관 문이 닫혔다.'});f.chat.messages=f.chat.message;
   f.control.onCall=async()=>{
    const r=(await f.r.api.debugReadActiveCompletedTurnReceipt(6)).receipt;
    return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',scopeKey:r.scopeKey,worldlineId:r.worldlineId,sessionEpoch:0,turn:6,sourceRevisionId:r.revisionId,sourceDigest:r.sourceDigest,
     claims:['열렸다','닫혔다'].map(value=>{const quote='도서관 문이 '+value,startOffset=r.assistant.text.indexOf(quote);return {changeKind:'world',text:quote,actor:'',target:'도서관',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'set',stateIntent:{domain:'world',target:{entityName:'도서관'},field:'doorStatus',operation:'set',value},evidence:{role:'assistant',messageId:'t6-a',startOffset,endOffset:startOffset+quote.length,exactQuote:quote}};})}})};
   };
   listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:11});await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.turn===6,15000);
   const calls=f.control.calls.length;
   let p=await f.r.api.listMemoryReviews();assert.equal(p.rows.length,2);assert.ok(p.rows.every(r=>r.risk==='high'&&r.stateEligible));
   fx.local.set('__memory_suite_internal_scope_routes_v1__:libra',JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'libra',pluginId:'LIBRA',legacyGlobalModeImported:true,entries:{[p.scopeKey]:{scopeId:p.scopeKey,scopeKey:p.scopeKey,mode,origin:'user_explicit',updatedAt:1}}}));
   const current=async()=>(await f.r.api.debugLoadContinuityStateForResponse()).head.world.find(r=>r.name==='도서관').state.doorStatus;
   assert.equal(await current(),'닫혔다');
   const close=p.rows.find(r=>r.text.includes('닫혔다'));
   assert.equal((await f.r.api.setMemoryReviewDecision({scopeKey:p.scopeKey,previewDigest:p.previewDigest,ids:[close.id],status:'rejected'})).ok,true);
   assert.equal(await current(),'열렸다');
   await assert.rejects(f.r.api.setMemoryReviewDecision({scopeKey:p.scopeKey,previewDigest:p.previewDigest,ids:[close.id],status:'confirmed'}),/PREVIEW_CHANGED/);
   p=await f.r.api.listMemoryReviews();assert.equal(p.rows.find(r=>r.id===close.id).status,'rejected');assert.equal(p.rows.find(r=>r.id===close.id).risk,'high');
   assert.equal((await f.r.api.setMemoryReviewDecision({scopeKey:p.scopeKey,previewDigest:p.previewDigest,ids:[close.id],status:'confirmed'})).ok,true);assert.equal(await current(),'닫혔다');
   assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);assert.equal(await current(),'닫혔다');
   if(mode!=='mirror'){const graph=await f.r.api.getMemoryGraphProjectionPage({nodeLimit:2048});assert.equal(graph.units.filter(r=>r.family==='micro').length,2);}
   else await assert.rejects(f.r.api.getMemoryGraphProjectionPage({nodeLimit:2048}),/READ_ROUTE_MODE_UNAVAILABLE/,'the retired mirror graph reader remains unsupported');
   assert.equal(f.control.calls.length,calls,'no review provider calls');console.log('PASS '+mode+' review auto application, CAS stale refusal, rejection/confirmation, rebuild and graph recall');
  }finally{await fx.cleanup();}
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
