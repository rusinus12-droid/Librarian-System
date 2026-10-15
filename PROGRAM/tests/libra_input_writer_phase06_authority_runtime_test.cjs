'use strict';
// The Writer prompt/provider is retired. Retain canonical-vs-State priority and
// verify the actual Classic route delivers only validated canonical evidence.
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {actualClassicPacket}=require('./fixtures/libra_actual_classic_request.cjs');
(async()=>{
 const f=await fixture();try{
  const row=(id,start)=>({memoryId:id,revision:1,sourceDigest:'digest-'+id,sessionEpoch:0,turnRange:{start,end:start+4},text:id});
  const old=row('HISTORICAL',1),newer=row('NEWER',11),layers={memory:[old,newer],entity:[],world:[],narrative:[]};
  const saved=JSON.stringify(layers),api=f.r.api;
  const current=api.debugRecallCanonicalPriorityPartition(layers,{current:true,pending:false,authority:'current',boundaryEvidence:old});
  assert.equal(current.stateCurrent,true);assert.equal(current.statePending,false);
  assert.deepEqual(Array.from(current.newerThanState.memory,x=>x.memoryId),['NEWER']);assert.deepEqual(Array.from(current.historicalAtOrBeforeState.memory,x=>x.memoryId),['HISTORICAL']);
  const pending=api.debugRecallCanonicalPriorityPartition(layers,{current:false,pending:true,pendingDomains:['world'],authority:'last_known_pending'});
  assert.equal(pending.stateCurrent,false);assert.equal(pending.statePending,true);assert.equal(pending.newerCount,2);assert.equal(pending.historicalCount,0);assert.deepEqual(Array.from(pending.pendingDomains),['world']);assert.equal(JSON.stringify(layers),saved);
  assert.equal((await f.run()).completed,1);const ref=f.getManifest().memories['1'],before=f.r.values.get(ref.key),head=f.getRecords('libra.continuity_state.v2')[0],headBefore=f.r.values.get(head.key),calls=f.control.calls.length;
  const packet=await actualClassicPacket(f,'민아 지호 신뢰 은빛 열쇠',f.getManifest().scopeKey);
  assert(packet.actualClassic.deliveredRows.some(x=>x.memoryId===ref.memoryId&&x.revision===ref.revision));
  // Only the wording changed when the unified engine took over the classic block. The priority statement
  // and the guard against reading last-known values as confirmed facts must both survive.
  assert.match(packet.actualClassic.block,/current user input and the visible scene (?:take priority|outrank)/i);
  assert.match(packet.actualClassic.block,/do not treat attempts, plans or last-known values as confirmed current facts/i);
  assert.doesNotMatch(packet.actualClassic.block,/CURRENT STATE HEAD|continuity_state_prompt|cs_rel_|ce_/);
  assert.equal(f.r.values.get(ref.key),before);assert.equal(f.r.values.get(head.key),headBefore);assert.equal(f.control.calls.length,calls);
  const stale=structuredClone(packet.actualClassic.context);stale.values.currentInput='changed';assert.equal((await api.validateResponseContext(stale)).current,false);
 }finally{await f.r.cleanup();}
 console.log('libra_input_writer_phase06_authority_runtime_test: PASS (priority and Classic successor; Writer prompt ordering/provider retired)');
})().catch(e=>{console.error(e);process.exitCode=1;});
