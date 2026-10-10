'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createRootBoundary}=require('./fixtures/source_edit_root_boundary.cjs');
const OLD='Alice signed the agreement.',NEW='Alice did not sign the agreement.';
function envelope(quote,turn=1){const p=createValidPacket({turn,subject:'Alice',scene:'office',summary:quote});p.entity.characters=[{name:'Alice'}];p.planner.continuity_locks=[quote];const grounding=[];const walk=(v,path)=>{if(Array.isArray(v)){v.forEach((x,i)=>{if(x!=null&&(typeof x!=='string'||x.trim()))grounding.push({path:`${path}[${i}]`,source:'target',evidence:[quote]})});return;}if(v&&typeof v==='object')for(const[k,x]of Object.entries(v))walk(x,path?path+'.'+k:k);};for(const a of ['entity','world','narrative','planner'])walk(p[a],a);grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[quote]});return{schema:'hayaku.native_repair_output.v1',packet:p,grounding};}
(async()=>{
  const packet=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:OLD}),second=createValidPacket({turn:2,subject:'Alice',scene:'office',summary:'Alice waited outside.'}),root=createRootBoundary();
  const runtime=await createHayakuRuntime({autoRepair:false,messages:[{role:'user',id:'u1',chatId:'u1',data:'What does Alice do?'},{role:'assistant',id:'a1',chatId:'a1',data:hiddenPacketMessage(OLD,packet)},{role:'user',id:'u2',chatId:'u2',data:'What happens next?'},{role:'assistant',id:'a2',chatId:'a2',data:hiddenPacketMessage('Alice waited outside.',second)}]});
  try{
    runtime.host.getRootDocument=async()=>root.root;const t=runtime.hayaku._test,scope=await t.currentChatScope();
    await t.reconcileObservedChatTopology(scope,t.authoritativeChatSnapshot(scope.chatMessages,scope),'source_edit_test_initial');
    assert.ok((await runtime.hayaku.ledger.inspect({includeRecords:true})).records.length,'initial owner records persist');
    runtime.chat.message[1].data=hiddenPacketMessage(NEW,packet);
    const editedScope=await t.currentChatScope();await t.reconcileObservedChatTopology(editedScope,t.authoritativeChatSnapshot(editedScope.chatMessages,editedScope),'source_edit_test');
    runtime.setLlmResponder(async(_call,n)=>({type:'success',result:JSON.stringify(n===1?envelope(NEW):envelope('Alice waited outside.',2))}));
    await t.handleBeforeRequest([{role:'user',content:'Continue.'}],'model');
    assert.equal(runtime.llmCalls.length,2,'the direct edit and affected suffix are rebuilt before the new request');
    assert.equal(await root.ready(),false,'automatic reconciliation creates no dialog');
    const status=runtime.hayaku.getSourceEditSyncStatus();assert.deepEqual(Array.from(status.tasks,task=>task.state),['applied','applied']);
    assert.equal(status.tasks[0].changeKind,'source_changed');assert.equal(status.tasks[1].changeKind,'dependency_affected');
    const after=await runtime.hayaku.ledger.inspect({includeRecords:true}),active=after.records.filter(r=>r.recordState==='active');
    assert.ok(active.some(r=>r.body?.includes(NEW)||r.raw?.includes(NEW)||JSON.stringify(r).includes(NEW)),'replacement packet was adopted');
    assert.equal(runtime.chat.message[1].data,hiddenPacketMessage(NEW,packet),'source chat remains unchanged');
    assert.equal((await runtime.hayaku.reviewSourceEdits()).reason,'automatic_before_request_only','the old manual entry point cannot prompt');
    assert.equal(runtime.llmCalls.length,2);
    console.log(JSON.stringify({test:'source_edit_hayaku_dependency',passed:8}));
  }finally{await runtime.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1});
