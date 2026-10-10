'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const L=require('node:path').resolve(__dirname,'..');
const {OLD,NEW}=require(L+'/tests/fixtures/shared_reanalysis_owner_fixture.cjs');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage,waitFor}=require(L+'/tests/fixtures/hayaku_runtime_harness.cjs');
test('foreign appended packet rejection preserves approved prior identity',async()=>{
 const initial=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:OLD});
 const r=await createHayakuRuntime({autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,arguments:{hayaku_packet_recovery:'false'},messages:[{role:'user',id:'u1',chatId:'u1',data:'What does Alice do?'},{role:'assistant',id:'a1',chatId:'a1',data:hiddenPacketMessage(OLD,initial)}]});
 const f={r,api:r.hayaku,chat:r.chat,store:r.pluginStorage,calls:()=>r.llmCalls.length,dispose:r.dispose};
 await r.callBeforeRequest([{role:'user',content:'Initial recall.'}],'model');
 try{
  const key=[...f.store.values.keys()].find(k=>k.startsWith('hayaku.v2.ledger.'));assert(key);
  const active=()=>JSON.parse(f.store.values.get(key)).records.filter(r=>r.recordState==='active'&&!r.auditRetained);
  const seedScope=await f.api._test.currentChatScope();
  const before=(await f.api._test.loadStorageLedger(seedScope)).records.filter(r=>r.recordState==='active'&&!r.auditRetained).map(r=>[r.recordId,r.hash,r.raw,r.ownerTurnNodeId]);assert(before.length);
  const paste=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:NEW});f.chat.message[1].data=hiddenPacketMessage(NEW,paste);
  await f.r.callBeforeRequest([{role:'user',content:'Recall approved Alice facts.'}],'model');
  f.chat.message.push({role:'user',id:'u2',chatId:'u2',data:'Where does Bob go?'});f.chat.messages=f.chat.message;
  await f.r.callBeforeRequest([{role:'system',content:'Continue the story.'},...f.chat.message],'model');
  const scope=await f.api._test.currentChatScope(),pending=f.api._test.selectPendingCapture([],scope,'model');assert(pending);assert.equal(pending.lineage.targetPairIndex,2);
  const text='Bob went to the garden.',packet=createValidPacket({turn:2,subject:'Bob',scene:'garden',summary:text}),l=pending.lineage;
  packet.meta.lineage={request_nonce:l.requestNonce,parent_turn_node_id:l.parentTurnNodeId,logical_turn_id:l.logicalTurnId,identity_version:l.identityVersion,lineage_schema:l.lineageSchema,turn_owner_key:l.turnOwnerKey,generation_attempt_id:l.generationAttemptId};
  packet.meta.lineage.request_nonce='foreign-request';packet.meta.lineage.generation_attempt_id='foreign-request';
  const response=hiddenPacketMessage(text,packet);assert.equal(f.api._test.packetCaptureInspectionFromText(response).validCount,1);
  f.chat.message.push({role:'assistant',id:'a2',chatId:'a2',data:response});f.chat.messages=f.chat.message;
  const outcome=await f.api._test.attemptFinalizedBindingTimeoutReconcile({pending,startedAt:Date.now()},await f.api._test.currentChatScope());
  const ledger=await f.api._test.loadStorageLedger(scope);
  console.log(JSON.stringify({control:'foreign-rejection-after-passive-edit',outcome,ledger}));
  assert.equal(outcome.rejectionDurable,true,'exact foreign hash rejection persists');
  assert.equal(outcome.reason,'finalized_packet_request_nonce_mismatch');
  assert.deepEqual(ledger.records.filter(r=>r.recordState==='active'&&before.some(x=>x[0]===r.recordId)).map(r=>[r.recordId,r.hash,r.raw,r.ownerTurnNodeId]),before,'old approved identity remains active and exact');
  const oldOwner=ledger.worldline.nodes.find(n=>n.turnNodeId===before[0][3]);assert.equal(oldOwner?.status,'active','rejection cannot retire unrelated approved owner');
  assert.equal(ledger.records.some(r=>r.recordState==='active'&&r.raw===JSON.stringify(paste)),false);
  assert.equal(f.calls(),0);assert.equal(f.r.fetchCalls.length,0);
 }finally{console.log(JSON.stringify({terminalDebug:f.api.lastDebug()}));await f.dispose();}
});
