'use strict';
const assert=require('node:assert/strict');
const {create,until,pause}=require('./fixtures/libra_gui_memory_dom_host.cjs');
const {artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const input=require('./fixtures/unified_vertical_source.json');
async function unknownLocation(){
 let f,listener,calls=0;
 try{
  f=await create('LIBRA','Full',{pluginPath:process.env.LIBRA_TEST_PLUGIN,initialChat:input.sourceRows.map(r=>({role:r.role,chatId:r.ref,data:r.text})),host:{
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
  console.log('PASS unknown location stays pending; scope/revision refusal; zero reader writes/model calls');
 }finally{await f?.close();}
}

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

async function conflictingClaims(){
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
  assert.equal(view.head.memoryReview.rows.filter(row=>row.risk==='high').length,2,'source-verified conflicts apply with explicit high risk');
  const panel=await openMicro(f,6);
  assert.equal(panel.dataset.microStateAdmission,'ready');assert.match(panel.textContent,/반영 2개.*보류 0개/);
  assert.ok(panel.querySelector('[data-micro-state-review]'));assert.deepEqual(f.errors,[]);
  // Change a persisted decision after projection, while the final proof is read.
  const entry=[...f.values].find(([,raw])=>{try{const row=JSON.parse(raw);return row.schema==='libra.micro_state_admission.v1'&&row.turn===6&&row.claimIndex===0;}catch{return false;}});
  assert.ok(entry);const [decisionKey,saved]=entry,getItem=f.host.pluginStorage.getItem;
  let reads=0;
  try{
   f.host.pluginStorage.getItem=async key=>{
    if(key===decisionKey&&++reads===2)f.values.set(key,JSON.stringify({...JSON.parse(saved),status:'pending'}));
    return getItem.call(f.host.pluginStorage,key);
   };
   assert.equal((await f.api.readMicroStateAdmissionForTurn(6)).status,'unavailable');
   assert.ok(reads>=2,'fault occurs at the final physical proof read');
  }finally{f.host.pluginStorage.getItem=getItem;f.values.set(decisionKey,saved);}
  // Editing the source invalidates the result instead of reusing the prior decision.
  chat.message[11].data+=' 수정된 원문.';
  assert.notEqual((await f.api.readMicroStateAdmissionForTurn(6)).status,'verified');
  console.log('PASS same-turn conflict matches final projection and real GUI; edited source refused');
 }finally{await f?.close();}
}

async function pendingBeyondDiagnosticLimit(){
 let f,listener;
 try{
  f=await create('LIBRA','Full',{pluginPath:process.env.LIBRA_TEST_PLUGIN,initialChat:[],host:{
   addRisuChatListener:async(_,fn)=>{listener=fn;return true;},
   runLLMModel:async request=>{
    const messages=request.messages;
    if(!String(messages[0]?.content||'').includes('[LIBRA MICRO SOURCE CONTRACT]'))return{type:'error',result:'Canonical intentionally unavailable'};
    const source=JSON.parse(messages[1].content),quote=source.assistant.text;
    return{type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},
     micro:{schema:'libra.micro_memory.v1',...source.binding,claims:Array.from({length:16},(_,i)=>({changeKind:'world',text:quote,actor:'',target:'제어실',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'set',
      stateIntent:{domain:'world',target:{entityName:'제어실'},field:`doorStatus${i}`,operation:'set',value:'열렸다'},
      evidence:{role:'assistant',messageId:source.assistant.messageId,startOffset:0,endOffset:quote.length,exactQuote:quote}}))}})};
   }
  }});
  const character=await f.host.getCharacter(),chat=character.chats[0];
  for(let turn=1;turn<=5;turn++){
   chat.message.push({role:'user',chatId:`t${turn}-u`,data:'문 상태는?'},{role:'assistant',chatId:`t${turn}-a`,data:'제어실 문이 열렸다.'});chat.messages=chat.message;
   listener({char:character,chat,characterIndex:0,chatIndex:0,messageIndex:turn*2-1});
   await until(()=>f.api.getCaptureBackendState().lastMicroPublication?.turn===turn,`pending T${turn}`,10000);
  }
  const view=await f.api.debugLoadContinuityStateForResponse();assert.equal(view.authority.microProjection.pendingClaims.length,64);
  assert.equal(view.authority.microProjection.pendingClaims.some(row=>row.turn===5),false,'target lies beyond the public diagnostic cap');
  const inspected=await f.api.readMicroStateAdmissionForTurn(5);assert.equal(inspected.status,'verified');assert.equal(inspected.decisions.length,16);
  for(const row of inspected.decisions){assert.equal(row.status,'pending');assert.equal(row.reason,'registry_target_unresolved');}
  console.log('PASS selected-turn pending reasons survive the global 64-row diagnostic limit');
 }finally{await f?.close();}
}

async function canonicalAbsorption(){
 let f,listener,calls=0,canonicalCalls=0,allowCanonical=false,offset=0;
 const original=sourceRows(),observations=new Map([[1,'도서관 전체는 정숙 구역'],[3,'준호가 지호에게서 열쇠를 받아 들었다'],[5,'공연 허가를 누가 내주는지는 아직 밝혀지지 않았다']]);
 try{
  f=await create('LIBRA','Full',{pluginPath:process.env.LIBRA_TEST_PLUGIN,initialChat:original.slice(0,2),host:{
   addRisuChatListener:async(_,fn)=>{listener=fn;return true;},
   runLLMModel:async request=>{
    calls++;const messages=request.messages;
    if(!String(messages[0]?.content||'').includes('[LIBRA MICRO SOURCE CONTRACT]')){
     canonicalCalls++;
     assert.equal(allowCanonical,true,'Canonical runs only at an explicit fixture step');
     const canonical=artifact();canonical.facts.find(row=>row.tempFactId==='f13').values.thread.summary=observations.get(5);
     return{type:'success',result:JSON.stringify(canonical).replace(/t([1-5])-a/g,(_,n)=>`t${Number(n)+offset}-a`)};
    }
    const source=JSON.parse(messages[1].content),value=observations.get(source.binding.turn);
    const startOffset=source.assistant.text.indexOf(value);
    return{type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},
     micro:{schema:'libra.micro_memory.v1',...source.binding,claims:value?[{changeKind:'event',text:value,actor:'',target:'',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'set',
      stateIntent:{domain:'narrative',target:{scope:'current_narrative'},field:'summary',operation:'set',value},
      evidence:{role:'assistant',messageId:source.assistant.messageId,startOffset,endOffset:startOffset+value.length,exactQuote:value}}]:[]}})};
   }
  }});
  // This scenario owns Canonical steps explicitly. A default T5 automatic scan
  // can otherwise race the manual job and leave it with zero new batches.
  await f.api.saveLibraMemorySettings({...await f.api.getLibraMemorySettings(),autoAnalyze:false});
  await f.open();const character=await f.host.getCharacter(),chat=character.chats[0];
  for(let turn=1;turn<=5;turn++){
   chat.message=original.slice(0,turn*2);chat.messages=chat.message;
   listener({char:character,chat,characterIndex:0,chatIndex:0,messageIndex:turn*2-1});
   await until(()=>f.api.getCaptureBackendState().lastMicroPublication?.turn===turn,`T${turn} Micro`,10000);
  }
  await until(()=>{const s=f.api.getCaptureBackendState();return s.microQueuedJobs===0&&s.receiptCaptureJobs===0&&s.receiptQueueScopes===0;},'completed Micro capture before manual Canonical',10000);
  assert.equal(canonicalCalls,0,'Micro capture never starts the fixture-owned Canonical step');
  allowCanonical=true;const firstCanonical=await f.api.runManualColdStart();
  assert.equal(firstCanonical.completed,1,JSON.stringify(firstCanonical));assert.equal(canonicalCalls,1);await pause(160);
  let panel=await openMicro(f,5);assert.ok(panel.querySelector('[data-micro-state-disposition="absorbed"]'));
  // Keep an older selected row open while Canonical advances without a new Micro.
  await openMicro(f,3);
  offset=5;chat.message.push(...original.map(row=>({...row,chatId:row.chatId.replace(/t([1-5])/,(_,n)=>`t${Number(n)+5}`)})));chat.messages=chat.message;
  assert.equal((await f.api.runManualColdStart()).completed,1);await pause(180);
  await until(()=>f.doc.querySelector('[data-micro-reader-turn="10"]'),'open Micro catalog refreshes after Canonical',10000);
  assert.ok(f.doc.querySelector('[data-micro-reader-detail="3"]'),'older selection survives the automatic refresh');
  // The old current-basis lookup is missing; final projection has already absorbed it.
  assert.equal((await f.api.debugReadCurrentMicroStateAdmission(5,0)).reason,'admission_decision_missing');
  const before=f.writes.length,modelCalls=calls;
  const absorbed=await f.api.readMicroStateAdmissionForTurn(5),corrected=await f.api.readMicroStateAdmissionForTurn(3);
  assert.equal(absorbed.status,'verified');assert.equal(absorbed.decisions[0].disposition,'absorbed');
  assert.equal(corrected.status,'verified');assert.equal(corrected.decisions[0].status,'superseded');assert.equal(corrected.decisions[0].disposition,'corrected');
  assert.equal(f.writes.length,before,'inspection never regenerates missing historical decisions');assert.equal(calls,modelCalls);
  const view=await f.api.debugLoadContinuityStateForResponse();assert.equal(view.head.throughTurn,10);assert.equal(view.authority.microProjection.pendingClaims.length,0);
  panel=await openMicro(f,5);assert.equal(panel.dataset.microStateAdmission,'ready');assert.match(panel.textContent,/정본·교정에 반영 1개.*보류 0개/);
  panel=await openMicro(f,3);assert.equal(panel.dataset.microStateAdmission,'ready');assert.match(panel.textContent,/이후 변경으로 대체 1개.*보류 0개/);
  assert.ok(panel.querySelector('[data-micro-state-disposition="corrected"]'));assert.deepEqual(f.errors,[]);
  console.log('PASS T10 Canonical absorption/replacement, automatic open catalog refresh, no reader writes/model calls');
 }finally{await f?.close();}
}

(async()=>{await unknownLocation();await conflictingClaims();await canonicalAbsorption();await pendingBeyondDiagnosticLimit();
 console.log('libra_micro_state_reader_gui_runtime_test: PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
