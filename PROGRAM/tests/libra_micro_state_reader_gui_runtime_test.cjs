'use strict';
const assert=require('node:assert/strict');
const {create,until,pause}=require('./fixtures/libra_gui_memory_dom_host.cjs');
const {artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const input=require('./fixtures/unified_vertical_source.json');
(async()=>{
 let f,listener,calls=0;
 try{
  f=await create('LIBRA','Full',{initialChat:input.sourceRows.map(r=>({role:r.role,chatId:r.ref,data:r.text})),host:{
   addRisuChatListener:async(_kind,fn)=>{listener=fn;return true;},
   runLLMModel:async()=>{
    calls++;const active=await f.api.debugReadActiveCompletedTurnReceipt(6);
    if(active.status!=='verified')return{type:'success',result:JSON.stringify(artifact())};
    const receipt=active.receipt,quote=receipt.assistant.text;
    return{type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',scopeKey:receipt.scopeKey,worldlineId:receipt.worldlineId,sessionEpoch:0,turn:6,sourceRevisionId:receipt.revisionId,sourceDigest:receipt.sourceDigest,claims:[{changeKind:'person',text:quote,actor:'민아',target:'',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'set',stateIntent:{domain:'character',target:{entityName:'민아'},field:'locationRef',operation:'set',value:'제어실'},evidence:{role:'assistant',messageId:'t6-a',startOffset:0,endOffset:quote.length,exactQuote:quote}}]}})};
   }
  }});
  await f.open();assert.equal((await f.api.runManualColdStart()).completed,1);
  const character=await f.host.getCharacter(),chat=character.chats[0];chat.message.push({role:'user',chatId:'t6-u',data:'민아는 어디로 갔어?'},{role:'assistant',chatId:'t6-a',data:'민아는 제어실로 이동했다.'});chat.messages=chat.message;
  listener({char:character,chat,characterIndex:0,chatIndex:0,messageIndex:11});
  await until(()=>f.api.getCaptureBackendState().lastMicroPublication?.turn===6,'published Micro',10000);
  const micro=await f.api.readActiveMicroMemoryForTurn(6);assert.equal(micro.record.analysisStatus,'verified');
  const before=f.writes.length,modelCalls=calls;
  const admission=await f.api.readMicroStateAdmissionForTurn(6,micro.record.scopeKey,micro.record.analysisRevisionId);
  assert.equal(admission.status,'verified');assert.equal(admission.decisions.length,1);assert.equal(admission.decisions[0].status,'pending');assert.equal(admission.decisions[0].reason,'registry_location_unresolved');
  assert.equal((await f.api.readMicroStateAdmissionForTurn(6,'other-scope',micro.record.analysisRevisionId)).status,'scope_mismatch');
  assert.equal((await f.api.readMicroStateAdmissionForTurn(6,micro.record.scopeKey,'changed-revision')).status,'stale_source');
  assert.equal(f.writes.length,before,'state decision inspection cannot mutate storage');assert.equal(calls,modelCalls);
  f.doc.querySelector('.sidebar [data-go="memory"]').click();await pause(200);f.doc.querySelector('[data-memory-reader-kind="micro"]').click();
  await until(()=>f.doc.querySelector('[data-micro-reader-turn="6"]'),'Micro list');f.doc.querySelector('[data-micro-reader-turn="6"]').click();
  await until(()=>f.doc.querySelector('[data-micro-state-pending-reason="registry_location_unresolved"]'),'actual pending reason in the viewer',10000);
  const panel=f.doc.querySelector('[data-micro-state-admission="pending"]');assert.ok(panel.textContent.includes('장소'));assert.ok(panel.textContent.includes('상태 승인 다시 확인'));
  assert.equal(f.api.getCurrentStateHead().throughTurn,5,'an unknown location must never be auto-approved by the reader');
  assert.equal(calls,2);assert.deepEqual(f.errors,[]);
  console.log('libra_micro_state_reader_gui_runtime_test: PASS (source-bound pending reasons, real viewer, scope/revision refusal, zero reader writes/model calls)');
 }finally{await f?.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
