'use strict';
const assert=require('node:assert/strict');
const {create,until,pause}=require('./fixtures/libra_gui_memory_dom_host.cjs');
const {artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const input=require('./fixtures/unified_vertical_source.json');
const sourceRows=()=>input.sourceRows.map(row=>({role:row.role,chatId:row.ref,data:row.text}));
async function openMicro(f,turn){
 if(!f.doc.querySelector('[data-micro-reader-turn]')){
  f.doc.querySelector('.sidebar [data-go="memory"]').click();await pause(150);
  f.doc.querySelector('[data-memory-reader-kind="micro"]').click();
 }
 await until(()=>f.doc.querySelector(`[data-micro-reader-turn="${turn}"]`),'Micro list');
 f.doc.querySelector(`[data-micro-reader-turn="${turn}"]`).click();
 await until(()=>f.doc.querySelector(`[data-micro-reader-detail="${turn}"] [data-micro-state-admission]`),'final State panel',10000);
 return f.doc.querySelector(`[data-micro-reader-detail="${turn}"] [data-micro-state-admission]`);
}


async function conflictingClaims(onReady){
 let f,listener,calls=0;
 try{
  f=await create('LIBRA','Full',{pluginPath:process.env.LIBRA_TEST_PLUGIN,initialChat:sourceRows(),host:{
   addRisuChatListener:async(_,fn)=>{listener=fn;return true;},
   runLLMModel:async()=>{
    calls++;const active=await f.api.debugReadActiveCompletedTurnReceipt(6);
    if(active.status!=='verified')return{type:'success',result:JSON.stringify(artifact())};
    const r=active.receipt,body=r.assistant.text;
    const claims=['열렸다','닫혔다'].map(value=>{
     const quote=`도서관 문이 ${value}`,startOffset=body.indexOf(quote);
     return{changeKind:'world',text:quote,actor:'',target:'도서관',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'set',
      stateIntent:{domain:'world',target:{entityName:'도서관'},field:'doorStatus',operation:'set',value},
      evidence:{role:'assistant',messageId:'t6-a',startOffset,endOffset:startOffset+quote.length,exactQuote:quote}};
    });
    return{type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},
     micro:{schema:'libra.micro_memory.v1',scopeKey:r.scopeKey,worldlineId:r.worldlineId,sessionEpoch:0,turn:6,sourceRevisionId:r.revisionId,sourceDigest:r.sourceDigest,claims}})};
   }
  }});
  await f.open();assert.equal((await f.api.runManualColdStart()).completed,1);
  const character=await f.host.getCharacter(),chat=character.chats[0];
  chat.message.push({role:'user',chatId:'t6-u',data:'문 상태를 확인해 줘.'},{role:'assistant',chatId:'t6-a',data:'도서관 문이 열렸다. 도서관 문이 닫혔다.'});chat.messages=chat.message;
  listener({char:character,chat,characterIndex:0,chatIndex:0,messageIndex:11});
  await until(()=>f.api.getCaptureBackendState().lastMicroPublication?.turn===6,'conflicting Micro',10000);
  // Both individual decisions pass. Only the actual projection detects their conflict.
  assert.equal(f.api.getCaptureBackendState().lastMicroPublication.stateAdmission.admitted,2);
  const before=f.writes.length,modelCalls=calls;
  const inspected=await f.api.readMicroStateAdmissionForTurn(6);
  assert.equal(inspected.status,'verified');assert.equal(inspected.decisions.length,2);
  for(const row of inspected.decisions){assert.equal(row.status,'admitted');assert.equal(row.reason,'automatic_review');}
  assert.equal(f.writes.length,before);assert.equal(calls,modelCalls);
  const view=await f.api.debugLoadContinuityStateForResponse();
  assert.equal(view.authority.microProjection.pendingClaims.length,0);assert.equal(view.head.throughTurn,6);
  assert.equal(view.head.world.find(row=>row.name==='도서관').state.doorStatus,'닫혔다');
  assert.equal(view.authority.current,true);assert.equal(view.head.microProjection.status,'current');assert.ok(view.head.microProjection.transitions.some(r=>r.field==='doorStatus'&&r.reviewId),'automatic changes remain wired to prompt field projection');
  assert.equal(view.head.memoryReview.rows.filter(row=>row.risk==='high').length,2,'source-verified conflicts apply with explicit high risk');
  const panel=await openMicro(f,6);
  assert.equal(panel.dataset.microStateAdmission,'ready');assert.match(panel.textContent,/반영 2개.*보류 0개/);
  assert.ok(panel.textContent.includes('기억·상태 자동 반영 검토'));assert.deepEqual(f.errors,[]);

  let catalog=await f.api.listMemoryReviews();assert.equal(catalog.rows.length,2);assert.ok(catalog.rows.every(r=>r.risk==='high'&&r.verification==='source_storage_scope_verified'));
  const first=catalog.rows.find(r=>r.text.includes('열렸다')),second=catalog.rows.find(r=>r.text.includes('닫혔다'));
  await assert.rejects(f.api.setMemoryReviewDecision({scopeKey:'other',previewDigest:catalog.previewDigest,ids:[first.id],status:'confirmed'}));
  const decide=async(ids,status)=>{const p=await f.api.listMemoryReviews();return f.api.setMemoryReviewDecision({scopeKey:p.scopeKey,previewDigest:p.previewDigest,ids,status});};
  assert.equal((await decide([first.id],'confirmed')).ok,true);
  await assert.rejects(f.api.setMemoryReviewDecision({scopeKey:catalog.scopeKey,previewDigest:catalog.previewDigest,ids:[second.id],status:'rejected'}),/PREVIEW_CHANGED/);
  assert.equal((await decide([second.id],'rejected')).ok,true);
  let reviewed=await f.api.debugLoadContinuityStateForResponse();assert.equal(reviewed.head.world.find(r=>r.name==='도서관').state.doorStatus,'열렸다');
  catalog=await f.api.listMemoryReviews();assert.equal(catalog.rows.find(r=>r.id===first.id).risk,'high');assert.equal(catalog.rows.find(r=>r.id===first.id).status,'confirmed');
  f.values.set('__memory_suite_internal_scope_routes_v1__:libra',JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'libra',pluginId:'LIBRA',legacyGlobalModeImported:true,entries:{[catalog.scopeKey]:{scopeId:catalog.scopeKey,scopeKey:catalog.scopeKey,mode:'plugin_only',origin:'user_explicit',updatedAt:1}}}));
  const graph=await f.api.getMemoryGraphProjectionPage({limit:50,nodeLimit:2048});
  assert.equal(graph.units.filter(r=>r.family==='micro').length,1);assert.ok(graph.units.filter(r=>r.family==='micro').every(r=>!r.text.includes('닫혔다')),'rejection removes only that Micro claim from recall');
  await decide([first.id],'rejected');reviewed=await f.api.debugLoadContinuityStateForResponse();assert.equal(Object.hasOwn(reviewed.head.world.find(r=>r.name==='도서관').state,'doorStatus'),false);
  await decide([second.id],'automatic');reviewed=await f.api.debugLoadContinuityStateForResponse();assert.equal(reviewed.head.world.find(r=>r.name==='도서관').state.doorStatus,'닫혔다');
  const savedPolicy=[...f.values].find(([k])=>k.includes(':memory-review:v1:')),setter=f.host.pluginStorage.setItem;
  try{f.host.pluginStorage.setItem=async(k,v)=>k===savedPolicy[0]?true:setter.call(f.host.pluginStorage,k,v);await assert.rejects(decide([second.id],'rejected'),'a dropped policy write must never be acknowledged');}
  finally{f.host.pluginStorage.setItem=setter;}
  assert.equal(f.values.get(savedPolicy[0]),savedPolicy[1],'failed write retains previous verified decisions');
  const restarted=await create('LIBRA','Full',{initialValues:[...f.values],initialChat:structuredClone(chat.message)});
  try{const p=await restarted.api.listMemoryReviews();assert.equal(p.rows.find(r=>r.id===first.id).status,'rejected');assert.equal(p.rows.find(r=>r.id===second.id).risk,'high');assert.equal((await restarted.api.debugLoadContinuityStateForResponse()).head.world.find(r=>r.name==='도서관').state.doorStatus,'닫혔다');}finally{await restarted.close();}
  if(onReady)await onReady(f);
  assert.equal(calls,modelCalls,'review decisions never call a provider');
  chat.message[11].data+=' 수정된 원문.';assert.equal((await f.api.listMemoryReviews()).rows.length,0,'edited raw source cannot be auto approved');
  console.log('PASS same-turn conflict matches final projection and real GUI; edited source refused');
 }finally{await f?.close();}
}


module.exports={conflictingClaims};
if(require.main===module)conflictingClaims().catch(e=>{console.error(e);process.exitCode=1;});
