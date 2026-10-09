'use strict';
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const {fixture,artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');

const clone=value=>JSON.parse(JSON.stringify(value));
const waitFor=async(predicate,timeout=5000)=>{const stop=Date.now()+timeout;while(Date.now()<stop){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('timed out waiting for expected owner state');};
const makeArtifact=offset=>{
 const value=artifact();
 for(const row of [...value.entities,...value.facts])for(const span of row.evidenceSpans){
  span.ref=span.ref.replace(/^t(\d+)/,(_,turn)=>`t${Number(turn)+offset}`);
 }
 return value;
};
const addBatch=(chat,start)=>{
 const source=chat.message.slice(0,10);
 for(let i=0;i<source.length;i++){
  const row=clone(source[i]),turn=start+Math.floor(i/2),role=i%2?'a':'u';
  row.chatId=`t${turn}-${role}`;chat.message.push(row);
 }
 chat.messages=chat.message;
};
const makeHost=(chat,character,control)=>({
 getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacter:async()=>character,getChar:async()=>character,
 getCharacterFromIndex:async()=>character,getChat:async()=>chat,getCurrentChat:async()=>chat,getChatFromIndex:async()=>chat,
 getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:[character],plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(key=>[key,db[key]??null])):db;},
 addRisuReplacer:async(mode,fn)=>{control.hooks[mode]=fn;return true;},
 runLLMModel:async(...args)=>{control.calls.push(clone(args));return {type:'success',result:JSON.stringify(control.artifact)};}
});

(async()=>{
 const f=await fixture();let restarted=null;
 try{
  f.control.artifact=makeArtifact(0);
  assert.equal((await f.run()).completed,1);
  for(const start of [6,11]){
   addBatch(f.chat,start);f.control.artifact=makeArtifact(start-1);
   assert.equal((await f.run()).completed,1,`batch at ${start} commits`);
  }
  const refsBefore=f.getManifest().memories;
  assert.deepEqual(Object.keys(refsBefore).sort(),['1','11','6']);

  // Let beforeRequest finish the edit, then persist the same exception the GUI
  // writes and reload the owner journal as a real restart.
  f.chat.message[11].data='지호는 은빛 열쇠를 민아에게 돌려주지 않았다.';
  f.control.onCall=async args=>{
   const encoded=JSON.stringify(args),offset=encoded.includes('[t11-u]')?10:5;
   return {type:'success',result:JSON.stringify(makeArtifact(offset))};
  };
  await f.r.sourceEditBoundary();
  const status=f.r.api.getSourceEditSyncStatus();
  const task=status.tasks.find(item=>item.start===6);
  assert.ok(task?.revisionId&&task.state==='applied','edited T6 range completed automatically');
  const journalKey=[...f.r.values.keys()].find(key=>key.includes(':source-edit-consent:v1'));
  assert.ok(journalKey,'source edit owner journal exists');
  const journal=JSON.parse(f.r.values.get(journalKey));journal.exceptions[task.revisionId]=true;
  f.r.values.set(journalKey,JSON.stringify(journal));
  const values=[...f.r.values.entries()];
  const {chat,character,control}=f;
  await f.r.cleanup();
  restarted=await createLibraVmHarness({},makeHost(chat,character,control),{initialValues:values});

  const callsBefore=control.calls.length;
  await restarted.sourceEditBoundary();
  assert.equal(control.calls.length,callsBefore,'an excepted range is never automatically reanalyzed');
  const viewer=restarted.api.getLastMemoryRecallViewer();
  const runtime=restarted.api.getRuntime();
  const visibleStarts=Array.from(runtime.lastResponseContext?.canonicalRefs||[],ref=>Number(ref.turnRange?.start||0)).filter(Boolean).sort((a,b)=>a-b);
  assert.deepEqual(visibleStarts,[1],'unrelated prefix memory stays in actual response context while T6 and its dependent suffix are suppressed');
  const requestHead=runtime.lastResponseContext?.values?.currentHead||null;
  assert.ok(!requestHead||Number(requestHead.throughTurn||0)<=5,'derived State never carries a later affected turn into the request');
  assert.ok(!JSON.stringify(requestHead||{}).includes(refsBefore['6'].memoryId));
  assert.ok(!JSON.stringify(requestHead||{}).includes(refsBefore['11'].memoryId));
  assert.ok(JSON.stringify(viewer?.rows||[]).includes(refsBefore['1'].memoryId),'unrelated prefix remains usable by the actual recall consumer');
  assert.ok(!JSON.stringify(viewer?.rows||[]).includes(refsBefore['6'].memoryId),'actual recall consumer does not select the excepted ref');
  assert.ok(!JSON.stringify(viewer?.rows||[]).includes(refsBefore['11'].memoryId),'actual recall consumer does not select dependent suffix');
  console.log(JSON.stringify({test:'libra_source_edit_exception_impact_runtime',passed:1,visibleStarts,headThroughTurn:Number(requestHead?.throughTurn||0)}));
 }finally{if(restarted)await restarted.cleanup();else await f.r.cleanup();}

 const timed=await fixture();
 let releaseTimedProvider=null;
 try{
  assert.equal((await timed.run()).completed,1);
  const oldRef=clone(timed.getManifest().memories['1']),oldBytes=timed.r.values.get(oldRef.key);
  const edited='서재에서 준호가 열쇠를 지호에게 건넸지만 지호는 민아에게 돌려주지 않았다. 오늘 반환 약속은 아직 이행되지 않았다. 공연 허가를 누가 내주는지는 아직 밝혀지지 않았다.';
  timed.chat.message[9].data=edited;
  const nextArtifact=artifact();
  for(const row of [...nextArtifact.entities,...nextArtifact.facts])for(const span of row.evidenceSpans)if(span.ref==='t5-a')span.quote=edited;
  nextArtifact.facts.find(row=>row.tempFactId==='f11').values.holderRef='jiho';
  nextArtifact.facts.find(row=>row.tempFactId==='f11').text='지호는 열쇠를 민아에게 아직 반환하지 않았다.';
  nextArtifact.facts.find(row=>row.tempFactId==='f12').values.thread.status='open';
  nextArtifact.facts.find(row=>row.tempFactId==='f12').text='오늘 반환 약속은 아직 이행되지 않았다.';
  let providerEntered;
  const providerGate=new Promise(resolve=>{releaseTimedProvider=resolve;});
  const entered=new Promise(resolve=>{providerEntered=resolve;});
  timed.control.onCall=async()=>{providerEntered();await providerGate;return {type:'success',result:JSON.stringify(nextArtifact)};};
  const request=timed.control.hooks.beforeRequest([{role:'user',content:'열쇠를 누가 가지고 있나요?'}],'model');
  await entered;
  await request; // Resolves at the 8-second request budget while the provider is still held.
  assert.equal(timed.r.api.getSourceEditSyncStatus().tasks[0].state,'running','the request timeout does not mark source processing complete');
  const runtime=timed.r.api.getRuntime(),viewer=timed.r.api.getLastMemoryRecallViewer();
  const visible=Array.from(runtime.lastResponseContext?.canonicalRefs||[],ref=>Number(ref.turnRange?.start||0)).filter(Boolean);
  assert.deepEqual(visible,[],'old affected canonical is hidden while automatic replacement remains in flight');
  assert.ok(!JSON.stringify(viewer?.rows||[]).includes(oldRef.memoryId),'actual recall consumer cannot retrieve the old affected record after 8s');
  timed.chat.message[9].data='서재에서 준호는 열쇠를 지호에게 주지 않았다. 민아는 반환 약속이 지켜졌다고 확인했다. 공연 허가자는 아직 불명이다.';
  releaseTimedProvider();
  await waitFor(()=>timed.r.api.getSourceEditSyncStatus().tasks[0]?.state!=='running');
  assert.equal(timed.r.api.getSourceEditSyncStatus().tasks[0].state,'failed','branch change retires the in-flight source edit');
  assert.equal(timed.getManifest().memories['1'].key,oldRef.key,'late provider result cannot activate after its live source branch changed');
  assert.equal(timed.getManifest().memories['1'].revision,oldRef.revision);
  assert.equal(timed.r.values.get(oldRef.key),oldBytes,'late work leaves immutable prior evidence intact');
  console.log(JSON.stringify({test:'libra_source_edit_timeout_and_stale_branch_runtime',passed:4,prep:runtime.lastSourceEditPreparation||'bounded_request_return'}));
 }finally{releaseTimedProvider?.();await timed.r.cleanup();}

 const shifted=await fixture();let releaseFirst=null,releaseSecond=null;
 try{
  assert.equal((await shifted.run()).completed,1);
  const oldRef=clone(shifted.getManifest().memories['1']);
  const edited='서재에서 준호는 열쇠를 돌려받았지만 아직 반환하지 않았다. 반환 약속은 미뤄졌다. 공연 허가자는 불명이다.';
  shifted.chat.message[9].data=edited;
  const nextArtifact=artifact();
  for(const row of [...nextArtifact.entities,...nextArtifact.facts])for(const span of row.evidenceSpans)if(span.ref==='t5-a')span.quote=edited;
  nextArtifact.facts.find(row=>row.tempFactId==='f11').values.holderRef='junho';
  nextArtifact.facts.find(row=>row.tempFactId==='f11').text='준호는 열쇠를 돌려받았지만 아직 반환하지 않았다.';
  nextArtifact.facts.find(row=>row.tempFactId==='f12').values.thread.status='open';
  nextArtifact.facts.find(row=>row.tempFactId==='f12').text='반환 약속은 미뤄졌다.';
  let callIndex=0,enteredFirst,enteredSecond;
  const firstEntered=new Promise(resolve=>{enteredFirst=resolve;});
  const secondEntered=new Promise(resolve=>{enteredSecond=resolve;});
  const gateFirst=new Promise(resolve=>{releaseFirst=resolve;});
  const gateSecond=new Promise(resolve=>{releaseSecond=resolve;});
  shifted.control.onCall=async()=>{
   const current=++callIndex;
   if(current===1){enteredFirst();await gateFirst;}else{enteredSecond();await gateSecond;}
   return {type:'success',result:JSON.stringify(nextArtifact)};
  };
  const first=shifted.control.hooks.beforeRequest([{role:'user',content:'열쇠의 상태를 알려 주세요.'}],'model');
  await firstEntered;
  // A newer same-scope request invalidates the delayed task even though the source
  // strings still match. The fresh request may then perform its own new attempt.
  const second=shifted.control.hooks.beforeRequest([{role:'user',content:'열쇠의 상태를 다시 알려 주세요.'}],'model');
  releaseFirst();
  await secondEntered;
  await Promise.all([first,second]);
  assert.equal(shifted.getManifest().memories['1'].key,oldRef.key,'the prior request cannot activate its delayed candidate');
  assert.equal(shifted.getManifest().memories['1'].revision,oldRef.revision);
  assert.equal(shifted.r.api.getSourceEditSyncStatus().tasks[0].state,'running','fresh request still owns the replacement attempt');
  releaseSecond();
  await waitFor(()=>shifted.r.api.getSourceEditSyncStatus().tasks[0]?.state==='applied');
  const active=shifted.getManifest().memories['1'];
  assert.ok(active.revision>oldRef.revision,'only the fresh request can commit the current-source replacement');
  console.log(JSON.stringify({test:'libra_source_edit_request_generation_runtime',passed:3,revision:active.revision}));
 }finally{releaseFirst?.();releaseSecond?.();await shifted.r.cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
