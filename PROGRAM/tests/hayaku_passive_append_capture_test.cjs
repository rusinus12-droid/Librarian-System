'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const L=require('node:path').resolve(__dirname,'..');
const {OLD,NEW}=require(L+'/tests/fixtures/shared_reanalysis_owner_fixture.cjs');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage,waitFor}=require(L+'/tests/fixtures/hayaku_runtime_harness.cjs');
test('request-owned append after passive older carrier edit preserves approved prior identity',async()=>{
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
  const response=hiddenPacketMessage(text,packet);assert.equal(f.api._test.packetCaptureInspectionFromText(response).validCount,1);
  await f.r.callAfterRequest(response);f.chat.message.push({role:'assistant',id:'a2',chatId:'a2',data:response});f.chat.messages=f.chat.message;
  await f.r.callChatOutput({char:f.r.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:3});
  await waitFor(()=>f.api.lastDebug().lastCaptureReceipt!==null,'appended raw receipt observed');
  await waitFor(()=>f.api.lastDebug().captureQueues.chatOutput.completed>0&&f.api.lastDebug().captureQueues.chatOutput.pending===0,'appended capture queue terminal');
  await waitFor(()=>f.api.lastDebug().lastStorageBinding!==null,'finalized binding outcome');
  console.log(JSON.stringify({control:'passive-prefix-append',pending,debug:f.api.lastDebug(),records:active()}));
  assert.equal(f.api.lastDebug().lastStorageCapture?.durable,true,'new request-owned capture is durably admitted');
  const ledger=await f.api._test.loadStorageLedger(scope);
  assert.deepEqual(ledger.records.filter(r=>r.recordState==='active'&&before.some(x=>x[0]===r.recordId)).map(r=>[r.recordId,r.hash,r.raw,r.ownerTurnNodeId]),before,'old approved identity remains active and exact');assert(ledger.records.some(r=>r.recordState==='active'&&r.raw===JSON.stringify(packet)),'new request-owned packet is active');
  assert.equal(ledger.records.some(r=>r.recordState==='active'&&r.raw===JSON.stringify(paste)),false,'passive prior carrier is not admitted');
  assert.equal(f.calls(),0);assert.equal(f.r.fetchCalls.length,0);
 }finally{console.log(JSON.stringify({terminalDebug:f.api.lastDebug()}));await f.dispose();}
});
