'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
const sentence=n=>`Alice opened box number ${n} and found a ribbon.`;
function entry(n){const packet=createValidPacket({turn:n,subject:'Alice',summary:sentence(n)});for(const a of ['entity','world','narrative','planner'])for(const [k,v]of Object.entries(packet[a]))if(Array.isArray(v))packet[a][k]=[];packet.entity.characters=[{name:'Alice',current_state:'Examining the discovery'}];packet.world.active_events=[{summary:'A ribbon was discovered.'}];packet.narrative.conflict_traces=[{summary:'Unsupported conflict'}];packet.meta.summary_memory={summary:sentence(n)};return {unitOrdinal:n,schema:'hayaku.native_repair_output.v1',packet,grounding:['entity.characters[0]','world.active_events[0]','meta.summary_memory.summary'].map(path=>({path,source:'target',evidence:[sentence(n)]}))};}
const messages=[1,2].flatMap(n=>[{role:'user',id:'u'+n,chatId:'u'+n,data:'Open the box.'},{role:'assistant',id:'a'+n,chatId:'a'+n,data:sentence(n)}]);

(async()=>{
 const r=await createHayakuRuntime({autoRepair:false,messages,llmResponder:async()=>{const bad=entry(2);bad.grounding.forEach(row=>row.evidence=['Absent quote']);return {type:'success',result:JSON.stringify({packets:[entry(1),bad]})};}});
 try{
  const first=await r.hayaku.recovery.coldStart({resume:true,batchTurns:5});assert.equal(first.ok,true);assert.equal(first.completed,false);assert.equal(first.awaitingUserReview,false);assert.equal(first.adoption.durable,true);
  // The rejected turn is re-analyzed once on its own inside the same run; this responder keeps
  // answering with the bad batch, so the retry also fails and the run stays partial.
  assert.equal(JSON.stringify(first.automaticRetry),JSON.stringify({budget:5,attempted:1,recovered:0}));assert.equal(r.llmCalls.length,2);
  let ledger=await r.hayaku.ledger.inspect({includeRecords:true});assert.equal(ledger.records.filter(row=>row.captureSource==='bridge_cold_start').length,1);
  r.setLlmResponder(async()=>({type:'success',result:JSON.stringify(entry(2))}));
  const resumed=await r.hayaku.recovery.coldStart({resume:true,batchTurns:5});assert.equal(resumed.completed,true,JSON.stringify(resumed));assert.equal(resumed.reusedChunks,1);assert.equal(r.llmCalls.length,3);
  ledger=await r.hayaku.ledger.inspect({includeRecords:true});assert.equal(ledger.records.filter(row=>row.captureSource==='bridge_cold_start').length,2);
 }finally{await r.dispose();}
 for(const mode of ['retry','salvage']){
  let calls=0;
  const r=await createHayakuRuntime({autoRepair:false,messages,llmResponder:async()=>{calls++;if(mode==='retry'&&calls===1)return {type:'success',result:'{}',finish_reason:'stop'};const rows=[entry(1),entry(2)];if(mode==='salvage')rows.forEach(row=>row.packet.extra_metadata={note:'extra'});return {type:'success',result:JSON.stringify({packets:rows}),finish_reason:'stop'};}});
  try{
   const api=r.hayaku._test,scope=await api.currentChatScope();const units=api.collectNativeColdStartEvidence(scope).units.map((u,i)=>({...u,ordinal:i+1,startTurn:u.turn,endTurn:u.turn,targetPairIndex:u.turn}));
   const out=await api.executeNativeColdStartBatchAttempt(units,{scopeKey:scope.key,extraCalls:mode==='retry'?1:0});
   if(mode==='retry'){assert.equal(calls,2);assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.results.length,2);assert.equal(out.failures.length,0);}
   else{assert.equal(calls,1);assert.equal(out.failures.length,2);assert(out.failures.every(row=>row.error.partialMemory.saved&&row.error.partialMemory.durable));}
  }finally{await r.dispose();}
 }
 let fault;
 fault=await createHayakuRuntime({autoRepair:false,messages,llmResponder:async()=>{
  for(const store of [fault.pluginStorage,fault.safeLocalStorage]){const write=store.setItem.bind(store);store.setItem=async(key,value)=>String(key).startsWith('hayaku.v2.ledger.')?false:write(key,value);}
  const bad=entry(2);bad.grounding.forEach(row=>row.evidence=['Absent quote']);return {type:'success',result:JSON.stringify({packets:[entry(1),bad]})};
 }});
 try{await assert.rejects(()=>fault.hayaku.recovery.coldStart({resume:true,batchTurns:5}),/adoption_failed|storage|write|readback/i);const ledger=await fault.hayaku.ledger.inspect({includeRecords:true});assert.equal(ledger.records.filter(row=>row.captureSource==='bridge_cold_start').length,0,'failed physical write never claims adopted packet');}finally{await fault.dispose();}
 console.log('PASS audit: mixed batch durable adoption, resume reuses success/no duplicates, paid bounded retry success not held for review, batch salvage durable result propagation, write-failure not adopted');
})().catch(e=>{console.error(e);process.exitCode=1;});
