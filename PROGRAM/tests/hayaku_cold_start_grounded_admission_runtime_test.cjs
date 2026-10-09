'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
const sentence=n=>`Alice opened box number ${n} and found a ribbon.`;
function entry(n){const packet=createValidPacket({turn:n,subject:'Alice',summary:sentence(n)});for(const a of ['entity','world','narrative','planner'])for(const [k,v]of Object.entries(packet[a]))if(Array.isArray(v))packet[a][k]=[];packet.entity.characters=[{name:'Alice',current_state:'Examining the discovery'}];packet.world.active_events=[{summary:'A ribbon was discovered.'}];packet.narrative.conflict_traces=[{summary:'Unsupported conflict'}];packet.meta.summary_memory={summary:sentence(n)};return {unitOrdinal:n,schema:'hayaku.native_repair_output.v1',packet,grounding:['entity.characters[0]','world.active_events[0]','meta.summary_memory.summary'].map(path=>({path,source:'target',evidence:[sentence(n)]}))};}
const messages=[1,2].flatMap(n=>[{role:'user',id:'u'+n,chatId:'u'+n,data:'Open the box.'},{role:'assistant',id:'a'+n,chatId:'a'+n,data:sentence(n)}]);
(async()=>{
 for(const mode of ['single','batch','damaged','cross_turn']){
  const r=await createHayakuRuntime({autoRepair:false,messages,llmResponder:async()=>{
   if(mode==='single')return {type:'success',result:JSON.stringify(entry(1))};
   if(mode==='damaged')return {type:'success',result:JSON.stringify(entry(1))+'\n{"unitOrdinal":2,"packet":'};
   const rows=[entry(1),entry(2)];if(mode==='cross_turn')rows[1].grounding.forEach(row=>row.evidence=[sentence(1)]);
   return {type:'success',result:JSON.stringify({response:{packets:rows}})};
  }});
  try{
   const api=r.hayaku._test,scope=await api.currentChatScope();
   const units=[1,2].map(n=>({ordinal:n,turn:n,startTurn:n,endTurn:n,kind:'completed_turn',text:sentence(n),chunkHash:'hash'+n}));
   const out=await api.executeNativeColdStartBatchAttempt(mode==='single'?units.slice(0,1):units,{scopeKey:scope.key,extraCalls:0});
   assert.equal(out.results.length,mode==='batch'?2:1,mode+JSON.stringify(out));
   assert.equal(out.failures.length,mode==='damaged'||mode==='cross_turn'?1:0);
   for(const row of out.results){assert.equal(row.analyzed.packet.meta.record_admission.status,'complete');assert.equal(row.analyzed.packet.meta.stateAuthority,false);assert.equal(row.analyzed.packet.narrative.conflict_traces.length,0);assert(row.analyzed.packet.meta.record_admission.derived.length);}
   assert.equal(r.llmCalls.length,1,'no extra paid repair');
  }finally{await r.dispose();}
 }
 const single=await createHayakuRuntime({autoRepair:false,messages:messages.slice(0,2),llmResponder:async()=>({type:'success',result:JSON.stringify(entry(1))})});
 try{const result=await single.hayaku.recovery.coldStart({resume:true,batchTurns:1});assert.equal(result.completed,true,JSON.stringify(result));const ledger=await single.hayaku.ledger.inspect({includeRecords:true});assert(ledger.records.some(row=>row.captureSource==='bridge_cold_start'&&row.recordState==='historical'));assert.equal(single.llmCalls.length,1);}finally{await single.dispose();}
 console.log('PASS cold-start single/batch: grounded paraphrases complete, unsupported item isolated, wrapper and damaged sibling recovery, cross-turn evidence excluded, single normal ledger readback, one model call');
})().catch(e=>{console.error(e);process.exitCode=1;});
