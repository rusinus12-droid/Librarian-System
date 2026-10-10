'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const summary='Alice opened the cedar chest and found a blue ribbon.';
const message=(role,n,data)=>({role,chatId:role+n,id:role+n,data});
const packet=()=>{const p=createValidPacket({turn:2,subject:'Alice',summary});p.entity.characters=[{name:'Alice'}];p.planner.continuity_locks=[summary];return p;};
const envelope=p=>{const grounding=[];for(const axis of ['entity','world','narrative','planner'])for(const [key,list]of Object.entries(p[axis]))if(Array.isArray(list))list.forEach((_,i)=>grounding.push({path:`${axis}.${key}[${i}]`,source:'target',evidence:[axis==='world'&&key==='active_events'&&String(list[i]?.summary).includes('invented')?'QUOTE_NOT_PRESENT_IN_SOURCE':summary]}));grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[summary]});return {schema:'hayaku.native_repair_output.v1',packet:p,grounding};};
(async()=>{
let checks=0;
// Current admission filters invalid records while retaining independent supported facts.
for(const mode of ['recovery','cold','batch']){
 const bad=packet();bad.entity.relations.push({from:'Alice',text:'incomplete relation'});bad.world.active_events.push({summary:'An invented event without supporting evidence.'});
 const wrapped=envelope(bad),raw=mode==='batch'?JSON.stringify({schema:'hayaku.native_cold_start_batch_output.v1',packets:[{unitOrdinal:1,packet:bad,grounding:wrapped.grounding},{unitOrdinal:2,packet:packet(),grounding:envelope(packet()).grounding}]}):JSON.stringify(wrapped);
 const messages=mode==='recovery'?[message('user',1,'Enter.'),message('assistant',1,hiddenPacketMessage('Alice entered.',createValidPacket({turn:1}))),message('user',2,'Open the chest.'),message('assistant',2,summary)]:[message('user',1,'Open the chest.'),message('assistant',1,summary)];
 if(mode==='batch')messages.push(message('user',2,'Open the chest.'),message('assistant',2,summary));
 const r=await createHayakuRuntime({autoRepair:false,messages,llmResponder:async()=>({type:'success',result:raw})});
 try{
 const result=mode==='recovery'?await r.hayaku.recovery.repairNow():await r.hayaku.recovery.coldStart({resume:true,batchTurns:mode==='batch'?5:1});
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.adoption.durable,true);assert.equal(r.llmCalls.length,1);
 const kind=mode==='recovery'?'bridge_incremental_recovery':'bridge_cold_start';
 const read=async rt=>(await rt.hayaku.ledger.inspect({includeRecords:true})).records.filter(row=>row.captureSource===kind);
 const rows=await read(r);assert.equal(rows.length,mode==='batch'?2:1);
 const stored=JSON.parse(rows[0].raw);assert.equal(stored.entity.relations.length,0);assert(stored.world.active_events.some(row=>row.summary===summary));assert(!stored.world.active_events.some(row=>row.summary.includes('invented')));
 assert.equal(stored.meta.stateAuthority,false);assert.equal(stored.meta.record_admission.authoritative,false);assert(stored.meta.record_admission.rejected.some(row=>row.reason==='native_repair_grounding_invalid'));
 const reload=await createHayakuRuntime({autoRepair:false,messages:r.chat.message,pluginStorage:r.pluginStorage,safeLocalStorage:r.safeLocalStorage});
 try{assert.equal(JSON.stringify((await read(reload)).map(row=>row.raw)),JSON.stringify(rows.map(row=>row.raw)),'fresh runtime reads identical committed packets');}finally{await reload.dispose();}
 checks++;
 }finally{await r.dispose();}
}
const r=await createHayakuRuntime({autoRepair:false});try{
 const api=r.hayaku._test;
 for(const kind of ['cold_start','incremental_recovery']){
  const p=packet();p.entity.characters=[{title:'Alice'}];const out=api.normalizeNativeAnalysisPacket(p,kind,{turn:2,text:summary},{});assert.equal(out.packet.entity.characters[0].name,'Alice');checks++;
  const bad=packet();bad.world.active_events=[{id:'a',text:summary,dependsOn:['b']},{id:'b',text:summary,dependsOn:['a']}];
  assert.equal(api.normalizeNativeAnalysisPacket(bad,kind,{turn:2,text:summary},{}).packet.world.active_events.length,0,'cyclic records filtered without rejecting independent facts');checks++;
  const refs=packet();refs.entity.characters=[{id:'a',name:'Alice',dependsOn:['b']},{id:'b',name:'Bob',dependsOn:['a']}];refs.entity.relations=[{from:'Alice',to:'Bob'}];
  assert.equal(api.normalizeNativeAnalysisPacket(refs,kind,{turn:2,text:summary},{}).packet.entity.relations.length,0,'dependent relation cannot survive rejected cyclic endpoints');checks++;
 }
}finally{await r.dispose();}
const fault=await createHayakuRuntime({autoRepair:false,messages:[message('user',1,'Open.'),message('assistant',1,summary)],llmResponder:async()=>{const p=packet();p.entity.relations=[{from:'Alice'}];return {type:'success',result:'INVALID_JSON_FOR_DURABLE_FAILURE_TEST'};}});
try{
 for(const store of [fault.pluginStorage,fault.safeLocalStorage]){const original=store.setItem;store.setItem=async(k,v)=>String(k).includes('failed_analysis_')?true:original.call(store,k,v);}
 const result=await fault.hayaku.recovery.coldStart({resume:true});assert.notEqual(result.ok,true);assert.notEqual(result.completed,true);
 const failures=await fault.hayaku.recovery.failedAnalysis.list();for(const entry of failures.entries){const read=await fault.hayaku.recovery.failedAnalysis.read(entry.failureId);assert.notEqual(read.durable,true,'volatile fallback cannot report durable preservation');}
 assert.ok(![...fault.pluginStorage.values.keys(),...fault.safeLocalStorage.values.keys()].some(k=>k.includes('failed_analysis_manifest.')||k.includes('failed_analysis_chunk.')));checks++;
}finally{await fault.dispose();}
console.log(`PASS record admission ${checks}: durable filtered recovery/cold/batch, fresh readback, rejected records excluded from state authority, safe aliases, cyclic dependencies`);
})().catch(e=>{console.error(e);process.exitCode=1;});
