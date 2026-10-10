'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {ownerFixture,OLD,NEW}=require('./fixtures/shared_reanalysis_owner_fixture.cjs');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const context=output=>output.filter(row=>row.memo==='hayaku-runtime-context-v3').map(row=>row.content||'').join('\n');
for(const claimedLineage of [false,true])test('passive pasted carrier preserves approved canon across repeat and restart'+(claimedLineage?' despite unowned lineage claims':''),async()=>{
 const f=await ownerFixture('hayaku');let restarted;
 try{
  const key=[...f.store.values.keys()].find(key=>key.startsWith('hayaku.v2.ledger.'));assert(key);
  const approved=()=>JSON.parse(f.store.values.get(key)).records.filter(r=>r.recordState==='active'&&!r.auditRetained).map(r=>[r.recordId,r.hash,r.raw,r.ownerTurnNodeId]);
  const before=approved();assert(before.length>0);
  const packet=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:NEW});
  if(claimedLineage)packet.meta.lineage={request_nonce:'unowned-paste',parent_turn_node_id:'foreign-parent',logical_turn_id:'foreign-logical',identity_version:2,lineage_schema:'hayaku_request_lineage_v2',turn_owner_key:'foreign-owner',generation_attempt_id:'unowned-paste'};
  const body=hiddenPacketMessage(NEW,packet);assert.equal(f.api._test.packetCaptureInspectionFromText(body).validCount,1,'the pasted carrier is structurally valid; no capture/adoption occurred');
  f.chat.message[1].data=body;
  for(let i=0;i<3;i++){
   const output=await f.r.callBeforeRequest([{role:'user',content:'What did Alice sign?'}],'model');
   assert(context(output).includes(OLD),'approved old fact remains recall eligible');assert.equal(context(output).includes(NEW),false,'unadopted new fact is never published');
   assert.deepEqual(approved(),before,'ordinary admission neither replaces nor duplicates approved canonical records');
  }
  assert.equal(f.calls(),0);await f.dispose();
  restarted=await createHayakuRuntime({messages:f.chat.message,pluginStorage:f.store,chatId:f.chat.id,characterId:f.r.character.id,pluginSourceFile:process.env.HAYAKU_TEST_PLUGIN,autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('PASSIVE_TEST_MODEL_FORBIDDEN');}});
  const output=await restarted.callBeforeRequest([{role:'user',content:'What did Alice sign?'}],'model');
  assert(context(output).includes(OLD));assert.equal(context(output).includes(NEW),false);assert.deepEqual(approved(),before);assert.equal(restarted.llmCalls.length,0);assert.equal(restarted.fetchCalls.length,0);
 }finally{if(restarted)await restarted.dispose();await f.dispose();}
});
