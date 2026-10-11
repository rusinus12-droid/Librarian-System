'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createRootBoundary}=require('./fixtures/source_edit_root_boundary.cjs');
const waitRoot=async root=>{for(let i=0;i<400;i++){if(await root.ready())return;await new Promise(r=>setTimeout(r,5));}throw Error('root dialog timeout');};
const OLD='Alice signed the agreement.',NEW='Alice did not sign the agreement.';
function envelope(quote){const p=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:quote});p.entity.characters=[{name:'Alice'}];p.planner.continuity_locks=[quote];const grounding=[];const walk=(v,path)=>{if(Array.isArray(v)){v.forEach((x,i)=>{if(x!=null&&(typeof x!=='string'||x.trim()))grounding.push({path:`${path}[${i}]`,source:'target',evidence:[quote]})});return;}if(v&&typeof v==='object')for(const[k,x]of Object.entries(v))walk(x,path?path+'.'+k:k);};for(const a of ['entity','world','narrative','planner'])walk(p[a],a);grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[quote]});return{schema:'hayaku.native_repair_output.v1',packet:p,grounding};}
(async()=>{
 const packet=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:OLD}),root=createRootBoundary();
 const runtime=await createHayakuRuntime({autoRepair:false,pluginSourceFile:process.env.HAYAKU_TEST_PLUGIN,messages:[{role:'user',id:'u1',chatId:'u1',data:'What does Alice do?'},{role:'assistant',id:'a1',chatId:'a1',data:hiddenPacketMessage(OLD,packet)}]});
 try{
  runtime.host.getRootDocument=async()=>root.root;
  await runtime.callBeforeRequest([{role:'user',content:'Initial recall.'}],'model');await runtime.callAfterRequest('', 'model');
  const before=await runtime.hayaku.ledger.inspect({includeRecords:true});assert.ok(before.records.length,'initial owner record persisted');
  runtime.chat.message[1].data=hiddenPacketMessage(NEW,packet);

  assert.equal(runtime.hayaku.getReanalysisStatus().running,false);assert.equal(typeof runtime.hayaku.getSourceEditSyncStatus,'undefined','automatic source journals are retired');
  runtime.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
  await runtime.callBeforeRequest([{role:'user',content:'Continue.'}],'model');
  assert.equal(await root.ready(),false,'request source observation opens no dialog');
  assert.equal(runtime.llmCalls.length,0,'source edit inspection never calls Other Ax');
  await runtime.callAfterRequest('', 'model');
  const ticket=await runtime.hayaku.previewSourceEdits(['1']);assert.equal(ticket.allowed,true,JSON.stringify(ticket));
  assert.equal(runtime.llmCalls.length,0,'explicit preview is model-free');
  const result=await runtime.hayaku.applySourceEdits(ticket);assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(runtime.llmCalls.length,1,'explicit apply reuses one existing Other Ax call');
  assert.equal((await runtime.hayaku.applySourceEdits(ticket)).status,'blocked');
  const after=await runtime.hayaku.ledger.inspect({includeRecords:true});const active=after.records.filter(r=>r.recordState==='active');
  assert.ok(active.some(r=>r.body?.includes(NEW)||r.raw?.includes(NEW)||JSON.stringify(r).includes(NEW)),JSON.stringify({status:runtime.hayaku.getReanalysisStatus(),records:after.records.map(r=>({state:r.recordState,raw:r.raw,body:r.body,reason:r.divergenceReason}))}));
  assert.equal(runtime.chat.message[1].data,hiddenPacketMessage(NEW,packet),'visible/source chat not rewritten');
  assert.equal(runtime.hayaku.getReanalysisStatus().lastResult.ok,true);assert.equal(runtime.hayaku.getReanalysisStatus().error,'');
  console.log(JSON.stringify({test:'source_edit_hayaku_runtime',passed:5}));
 }finally{await runtime.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1});
