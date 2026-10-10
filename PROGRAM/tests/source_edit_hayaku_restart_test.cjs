'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createRootBoundary}=require('./fixtures/source_edit_root_boundary.cjs');
const OLD='Alice signed the agreement.',NEW='Alice did not sign the agreement.';
function envelope(quote){const p=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:quote});p.entity.characters=[{name:'Alice'}];p.planner.continuity_locks=[quote];const grounding=[];const walk=(v,path)=>{if(Array.isArray(v)){v.forEach((x,i)=>{if(x!=null&&(typeof x!=='string'||x.trim()))grounding.push({path:`${path}[${i}]`,source:'target',evidence:[quote]})});return;}if(v&&typeof v==='object')for(const[k,x]of Object.entries(v))walk(x,path?path+'.'+k:k);};for(const a of ['entity','world','narrative','planner'])walk(p[a],a);grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[quote]});return{schema:'hayaku.native_repair_output.v1',packet:p,grounding};}
(async()=>{
  const packet=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:OLD}),root=createRootBoundary();let totalCalls=0;
  const messages=[{role:'user',id:'u1',chatId:'u1',data:'What does Alice do?'},{role:'assistant',id:'a1',chatId:'a1',data:hiddenPacketMessage(OLD,packet)}];
  let runtime=await createHayakuRuntime({autoRepair:false,pluginSourceFile:process.env.HAYAKU_TEST_PLUGIN,messages});
  try{
    runtime.host.getRootDocument=async()=>root.root;await runtime.callBeforeRequest([{role:'user',content:'Initial.'}],'model');await runtime.callAfterRequest('', 'model');
    assert.ok((await runtime.hayaku.ledger.inspect({includeRecords:true})).records.length,'initial owner packet is durable');
    runtime.chat.message[1].data=hiddenPacketMessage(NEW,packet);

    runtime.setLlmResponder(async()=>{totalCalls++;return{type:'success',result:'not a valid HAYAKU packet'};});
    await runtime.callBeforeRequest([{role:'user',content:'Continue.'}],'model');await runtime.callAfterRequest('', 'model');
    assert.equal(totalCalls,0,'request detection has no model call');const firstTicket=await runtime.hayaku.previewSourceEdits(['1']);assert.equal(firstTicket.allowed,true);await runtime.hayaku.applySourceEdits(firstTicket);
    assert.equal(totalCalls,1);assert.equal(await root.ready(),false);
    assert.equal(runtime.hayaku.getSourceEditSyncStatus().tasks[0].state,'failed');
    const protectedBeforeRestart=(await runtime.hayaku.ledger.inspect({includeRecords:true})).records.filter(r=>r.recordState==='active');
    assert.ok(protectedBeforeRestart.length,'failed replacement leaves the prior packet active');
    const pluginStorage=runtime.pluginStorage,safeLocalStorage=runtime.safeLocalStorage,editedMessages=runtime.chat.message;
    await runtime.dispose();

    runtime=await createHayakuRuntime({autoRepair:false,pluginSourceFile:process.env.HAYAKU_TEST_PLUGIN,pluginStorage,safeLocalStorage,messages:editedMessages});runtime.host.getRootDocument=async()=>root.root;
    await runtime.callBeforeRequest([{role:'user',content:'Restart inspection.'}],'model');await runtime.callAfterRequest('', 'model');
    assert.equal(runtime.hayaku.getSourceEditSyncStatus().tasks[0].state,'failed','failure receipt survives restart');
    assert.equal(totalCalls,1,'restart inspection does not make an extra model call');
    runtime.setLlmResponder(async()=>{totalCalls++;return{type:'success',result:JSON.stringify(envelope(NEW))};});
    await runtime.callBeforeRequest([{role:'user',content:'Continue again.'}],'model');await runtime.callAfterRequest('', 'model');
    assert.equal(totalCalls,1,'next request never automatically retries failed work');const nextTicket=await runtime.hayaku.previewSourceEdits(['1']);assert.equal(nextTicket.allowed,true);await runtime.hayaku.applySourceEdits(nextTicket);
    assert.equal(totalCalls,2,'new explicit preview/apply retries the failed task');assert.equal(await root.ready(),false);
    const status=runtime.hayaku.getSourceEditSyncStatus();assert.equal(status.tasks[0].state,'applied');
    const finalLedger=await runtime.hayaku.ledger.inspect({includeRecords:true}),active=finalLedger.records.filter(r=>r.recordState==='active');
    assert.ok(active.some(r=>r.body?.includes(NEW)||r.raw?.includes(NEW)||JSON.stringify(r).includes(NEW)),'replacement packet became active after readback');
    assert.equal(runtime.chat.message[1].data,hiddenPacketMessage(NEW,packet),'chat source remains unchanged');
    console.log(JSON.stringify({test:'source_edit_hayaku_restart',passed:10}));
  }finally{await runtime.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1});
