'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createRootBoundary}=require('./fixtures/source_edit_root_boundary.cjs');

const OLD='Alice signed the agreement.',EDIT_ONE='Alice did not sign the agreement.',EDIT_TWO='Alice never signed the agreement.';
function envelope(quote){
  const p=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:quote});p.entity.characters=[{name:'Alice'}];p.planner.continuity_locks=[quote];
  const grounding=[],walk=(v,path)=>{if(Array.isArray(v)){v.forEach((x,i)=>{if(x!=null&&(typeof x!=='string'||x.trim()))grounding.push({path:`${path}[${i}]`,source:'target',evidence:[quote]});});return;}
    if(v&&typeof v==='object')for(const[k,x]of Object.entries(v))walk(x,path?path+'.'+k:k);};
  for(const key of ['entity','world','narrative','planner'])walk(p[key],key);grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[quote]});
  return{schema:'hayaku.native_repair_output.v1',packet:p,grounding};
}

(async()=>{
  const packet=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:OLD}),root=createRootBoundary();
  const runtime=await createHayakuRuntime({autoRepair:false,messages:[
    {role:'user',id:'u1',chatId:'u1',data:'What does Alice do?'},
    {role:'assistant',id:'a1',chatId:'a1',data:hiddenPacketMessage(OLD,packet)}
  ]});
  try{
    runtime.host.getRootDocument=async()=>root.root;
    const t=runtime.hayaku._test,scope=await t.currentChatScope();
    await t.reconcileObservedChatTopology(scope,t.authoritativeChatSnapshot(scope.chatMessages,scope),'source_edit_race_initial');
    assert.ok((await runtime.hayaku.ledger.inspect({includeRecords:true})).records.length,'initial packet is durable');
    runtime.chat.message[1].data=hiddenPacketMessage(EDIT_ONE,packet);
    let releaseFirst,startedFirst;
    const firstStarted=new Promise(resolve=>{startedFirst=resolve;}),firstResult=new Promise(resolve=>{releaseFirst=resolve;});
    runtime.setLlmResponder(async(_call,n)=>{
      if(n===1){startedFirst();return await firstResult;}
      return{type:'success',result:JSON.stringify(envelope(EDIT_TWO))};
    });

    const firstRequest=runtime.callBeforeRequest([{role:'user',content:'Continue after edit one.'}],'model');
    await waitFor(()=>runtime.llmCalls.length===1,'first automatic source analysis');await firstStarted;
    runtime.chat.message[1].data=hiddenPacketMessage(EDIT_TWO,packet);
    const secondRequest=runtime.callBeforeRequest([{role:'user',content:'Continue after edit two.'}],'model');
    releaseFirst({type:'success',result:JSON.stringify(envelope(EDIT_ONE))});
    await firstRequest;await secondRequest;
    await waitFor(()=>runtime.hayaku.getSourceEditSyncStatus().tasks.some(task=>task.state==='applied'),'latest automatic source replacement');

    assert.equal(runtime.llmCalls.length,2,'stale result is rejected and the new request reanalyzes the current source');
    assert.equal(await root.ready(),false,'neither automatic request creates a consent dialog');
    const status=runtime.hayaku.getSourceEditSyncStatus(),task=status.tasks.find(row=>row.key==='1');
    assert.equal(task.state,'applied');
    const latest=await t.hayakuSourceEditSnapshot(await t.currentChatScope());
    assert.equal(task.sourceDigest,latest.units.find(unit=>unit.key==='1').sourceDigest);
    const active=(await runtime.hayaku.ledger.inspect({includeRecords:true})).records.filter(record=>record.recordState==='active');
    assert.ok(active.some(record=>JSON.stringify(record).includes(EDIT_TWO)),'the latest source result is durably active');
    assert.equal(active.some(record=>JSON.stringify(record).includes(EDIT_ONE)),false,'the stale model result was never adopted');
    assert.equal(runtime.chat.message[1].data,hiddenPacketMessage(EDIT_TWO,packet),'source chat is not rewritten by analysis');
    console.log(JSON.stringify({test:'source_tracking_hayaku_request_patch',passed:8}));
  }finally{await runtime.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
