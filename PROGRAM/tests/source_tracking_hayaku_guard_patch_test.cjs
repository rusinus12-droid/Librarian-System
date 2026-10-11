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
    const t=runtime.hayaku._test,scope=await t.currentChatScope();
    await t.reconcileObservedChatTopology(scope,t.authoritativeChatSnapshot(scope.chatMessages,scope),'source_edit_exception_initial');
    assert.ok((await runtime.hayaku.ledger.inspect({includeRecords:true})).records.length,'initial packet records are durable');
    runtime.chat.message[1].data=hiddenPacketMessage(NEW,first);
    const editedScope=await t.currentChatScope();await t.reconcileObservedChatTopology(editedScope,t.authoritativeChatSnapshot(editedScope.chatMessages,editedScope),'source_edit_exception_changed');
    runtime.setLlmResponder(async(_call,n)=>({type:'success',result:JSON.stringify(n===1?envelope(NEW):envelope('Alice waited outside.',2))}));
    await runtime.callBeforeRequest([{role:'user',content:'Continue with the edit.'}],'model');await runtime.callAfterRequest('', 'model');
    assert.equal(runtime.llmCalls.length,0,'ordinary request never analyzes a source edit');
    const inventory=await runtime.hayaku.listReanalysisRanges(),calls=runtime.llmCalls.length;
    for(const invalid of [{...inventory,ranges:[]},{...inventory,ranges:[inventory.ranges[0],inventory.ranges[0]]},{...inventory,scopeKey:'wrong'},{...inventory,topology:'wrong'},{...inventory,ranges:[{...inventory.ranges[0],identity:'wrong'}]},{...inventory,ranges:Array.from({length:129},()=>inventory.ranges[0])}]){
      const result=await runtime.hayaku.reanalyzeSelectedRanges(invalid);assert.equal(result.ok,false,JSON.stringify(result));assert.equal(runtime.llmCalls.length,calls,'invalid scope/topology/selection cannot dispatch a provider');
    }
    const oldLedger=await runtime.hayaku.ledger.inspect({includeRecords:true}),unselected=oldLedger.records.filter(r=>r.targetPairIndex===2&&r.recordState==='active').map(r=>({id:r.recordId,raw:r.raw}));
    assert.ok(unselected.length,'a durable unselected suffix exists');
    const result=await runtime.hayaku.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.key==='1')});
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(runtime.llmCalls.length,1,'one selected turn makes one existing provider call');
    const finalLedger=await runtime.hayaku.ledger.inspect({includeRecords:true}),active=finalLedger.records.filter(r=>r.recordState==='active');
    assert.ok(active.some(r=>Number(r.targetPairIndex)===1&&JSON.stringify(r).includes(NEW)),'selected replacement becomes durable');
    for(const old of unselected)assert.ok(active.some(r=>r.recordId===old.id&&r.raw===old.raw),'unselected suffix stays byte-identical and active');
    assert.equal(runtime.chat.message[1].data,hiddenPacketMessage(NEW,first));assert.equal((await runtime.hayaku.reviewSourceEdits()).reason,'explicit_selection_required');
    console.log(JSON.stringify({test:'source_tracking_hayaku_guard_patch',passed:9}));
  }finally{await runtime.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
