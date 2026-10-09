'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');

const OLD='Alice signed the agreement.',NEW='Alice did not sign the agreement.';
function envelope(quote,turn=1){
  const p=createValidPacket({turn,subject:'Alice',scene:'office',summary:quote});p.entity.characters=[{name:'Alice'}];p.planner.continuity_locks=[quote];
  const grounding=[],walk=(v,path)=>{if(Array.isArray(v)){v.forEach((x,i)=>{if(x!=null&&(typeof x!=='string'||x.trim()))grounding.push({path:`${path}[${i}]`,source:'target',evidence:[quote]});});return;}
    if(v&&typeof v==='object')for(const[k,x]of Object.entries(v))walk(x,path?path+'.'+k:k);};
  for(const key of ['entity','world','narrative','planner'])walk(p[key],key);grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[quote]});
  return{schema:'hayaku.native_repair_output.v1',packet:p,grounding};
}

(async()=>{
  const first=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:OLD});
  const second=createValidPacket({turn:2,subject:'Alice',scene:'office',summary:'Alice waited outside.'});
  const runtime=await createHayakuRuntime({autoRepair:false,messages:[
    {role:'user',id:'u1',chatId:'u1',data:'What does Alice do?'},{role:'assistant',id:'a1',chatId:'a1',data:hiddenPacketMessage(OLD,first)},
    {role:'user',id:'u2',chatId:'u2',data:'What happens next?'},{role:'assistant',id:'a2',chatId:'a2',data:hiddenPacketMessage('Alice waited outside.',second)}
  ]});
  try{
    const t=runtime.hayaku._test,scope=await t.currentChatScope(),edits=t.getHayakuSourceEdits();
    await t.reconcileObservedChatTopology(scope,t.authoritativeChatSnapshot(scope.chatMessages,scope),'source_edit_exception_initial');
    assert.ok((await runtime.hayaku.ledger.inspect({includeRecords:true})).records.length,'initial packet records are durable');
    runtime.chat.message[1].data=hiddenPacketMessage(NEW,first);
    const editedScope=await t.currentChatScope();await t.reconcileObservedChatTopology(editedScope,t.authoritativeChatSnapshot(editedScope.chatMessages,editedScope),'source_edit_exception_changed');
    runtime.setLlmResponder(async(_call,n)=>({type:'success',result:JSON.stringify(n===1?envelope(NEW):envelope('Alice waited outside.',2))}));
    await t.handleBeforeRequest([{role:'user',content:'Continue with the edit.'}],'model');
    assert.equal(runtime.llmCalls.length,2,'the direct edit and affected suffix are automatically reconciled');
    assert.equal(runtime.hayaku.getSourceEditSyncStatus().tasks.every(task=>task.state==='applied'),true);

    const task=edits.status().tasks.find(row=>row.key==='1'),event=edits.status().events.find(row=>row.key==='1');
    const oldHash=task.oldPacketHashes[0];assert.ok(oldHash);
    await edits.setException(scope.key,'1',task.revisionId,true);
    const callsBeforeGuard=runtime.llmCalls.length;
    assert.equal(edits.canWrite(scope.key,'1',task.sourceDigest),false);
    assert.equal(edits.rejectsPacket(scope.key,'1',oldHash),true,'exception blocks the stale carrier even after replacement');
    await assert.rejects(()=>runtime.hayaku.recovery.regenerateTurns({targetTurns:[1],allowMissing:true}),/SOURCE_EDIT_CONSENT_REQUIRED/);
    assert.equal(runtime.llmCalls.length,callsBeforeGuard,'the recovery path cannot bypass the exception');

    await edits.deleteEvent(scope.key,event.id);
    assert.equal(edits.status().events.some(row=>row.id===event.id),false);
    assert.equal(edits.status().tasks.find(row=>row.key==='1').excluded,true,'event deletion does not clear the exception');
    assert.equal(edits.canWrite(scope.key,'1',task.sourceDigest),false);
    assert.equal((await runtime.hayaku.reviewSourceEdits()).reason,'automatic_before_request_only');
    console.log(JSON.stringify({test:'source_tracking_hayaku_guard_patch',passed:9}));
  }finally{await runtime.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
