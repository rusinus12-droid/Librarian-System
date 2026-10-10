'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const source=fs.readFileSync(path.join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');
const summary='Alice opened the cedar chest and found a blue ribbon.';
const packet=createValidPacket({turn:2,subject:'Alice',summary});packet.entity.characters=[{name:'Alice'}];packet.planner.continuity_locks=[summary];
const grounding=[];for(const axis of ['entity','world','narrative','planner'])for(const [key,list] of Object.entries(packet[axis]))if(Array.isArray(list))list.forEach((_,i)=>grounding.push({path:`${axis}.${key}[${i}]`,source:'target',evidence:[summary]}));grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[summary]});
const envelope={schema:'hayaku.native_repair_output.v1',packet,grounding,providerNote:'extra envelope metadata'};
const msg=(role,id,data)=>({role,id,chatId:id,data});
(async()=>{
const r=await createHayakuRuntime({autoRepair:false,failedRecoveryAutomation:'retry_once',messages:[msg('user','u1','Enter.'),msg('assistant','a1',hiddenPacketMessage('Alice entered.',createValidPacket({turn:1}))),msg('user','u2','Open the chest.'),msg('assistant','a2',summary)],llmResponder:async()=>({type:'success',result:'FAILED_RAW_SENTINEL'})});
try{
 const first=await r.hayaku.recovery.repairNow();assert.equal(first.ok,false);assert.equal(first.reason,'no_storable_memory');assert.equal(first.awaitingUserReview,false);assert.equal(r.llmCalls.length,1);
 assert.equal(r.hayaku.recovery.failedAnalysis.automationStatus().mode,'off');
 const list=await r.hayaku.recovery.failedAnalysis.list();assert.ok(list.entries.length);const id=list.entries[0].failureId;
 const before=await r.hayaku.recovery.failedAnalysis.read(id);assert.equal(before.durable,true);
 const retired=await r.hayaku.recovery.failedAnalysis.resolve(id,'llm');assert.equal(retired.reason,'failed_recovery_retired_use_missing_turn_generation');assert.equal(r.llmCalls.length,1);
 const status=await r.hayaku.recovery.status({includeDebts:true,refreshDebts:true});assert.ok(status.debt.coverage.repairableTurns.includes(2));
 r.setLlmResponder(async call=>{assert.ok(!JSON.stringify(call.messages).includes('FAILED_RAW_SENTINEL'));return {type:'success',result:JSON.stringify(envelope)};});
 const second=await r.hayaku.recovery.repairNow();assert.equal(second.repaired,true,JSON.stringify(second));assert.equal(r.llmCalls.length,2);
 assert.equal((await r.hayaku.recovery.failedAnalysis.read(id)).durable,true,'legacy diagnostics preserved');
 const ledger=await r.hayaku.ledger.inspect({includeRecords:true});assert.ok(ledger.records.some(x=>x.captureSource==='bridge_incremental_recovery'&&x.recordState==='active'));
 const again=await r.hayaku.recovery.repairNow();assert.equal(r.llmCalls.length,2,'already repaired turn incurs no new model call');
 assert.ok(!source.includes('data-hayaku-viewer-panel="failed_recovery"'));assert.ok(!source.includes('id="hayakuViewerTabFailedRecovery"'));
 assert.ok(!source.includes('if (record.failedAnalysisId && failedAutoMode()'));
 console.log('PASS simple recovery: legacy paid setting disabled, retired API blocked, failed turn visible, fresh source generation, durable ledger and old diagnostics, no duplicate call, retired screen absent');
}finally{await r.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
