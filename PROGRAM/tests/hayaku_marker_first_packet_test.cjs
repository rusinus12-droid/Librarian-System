'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,createStore,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
test('marker-first public inspection accepts envelope variants and preserves schema rejection',async t=>{
 const r=await createHayakuRuntime({autoRepair:false});t.after(()=>r.dispose());
 const json=JSON.stringify(createValidPacket());
 for(const body of [json,`>>>\n${json}\n<<<`,`\n\x60\x60\x60json\n${json}\n\x60\x60\x60`,`\n${json}\n<!-- `]){
  const text=`Visible prose.\nHAYAKU_STATE_PACKET_START${body}\nHAYAKU_STATE_PACKET_END`;
  const result=r.hayaku.packet.parse(text);assert.equal(result.valid,true,JSON.stringify({status:result.status,body:body.slice(0,20)}));assert.equal(result.packetCount,1);
 }
 for(const body of [`prose ${json}`,`${json} prose`,'{"meta":{"schema":"unrelated"}}',json.slice(0,-1)]){
  assert.equal(r.hayaku.packet.parse(`HAYAKU_STATE_PACKET_START\n${body}\nHAYAKU_STATE_PACKET_END`).valid,false);
 }
 const wrong=createValidPacket();wrong.meta.lineage={request_nonce:'foreign'};
 const result=r.hayaku.packet.parse(`HAYAKU_STATE_PACKET_START\n${JSON.stringify(wrong)}\nHAYAKU_STATE_PACKET_END`);
 assert.equal(result.packets[0].packet.meta.lineage.request_nonce,'foreign','detection never invents or overwrites identity');
});

for(const decoration of ['angles','fence','stray_comment'])test(`marker-first ${decoration} reaches durable regular capture without recovery calls`,async t=>{
 const store=createStore();await store.setItem('hayaku.v2.settings.source-tracking.v1',JSON.stringify({mode:'off',epoch:0}));
 const r=await createHayakuRuntime({pluginStorage:store,messages:[{role:'user',chatId:'u1',data:'Alice-1 completes the established event for turn 1.'}],autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,arguments:{hayaku_packet_recovery:'false'}});t.after(()=>r.dispose());
 await r.callBeforeRequest([{role:'system',content:'Continue the story.'},...r.chat.message]);
 const scope=await r.hayaku._test.currentChatScope(),pending=r.hayaku._test.selectPendingCapture([],scope,'model'),l=pending.lineage,packet=createValidPacket();
 packet.meta.lineage={request_nonce:l.requestNonce,parent_turn_node_id:l.parentTurnNodeId,logical_turn_id:l.logicalTurnId,identity_version:l.identityVersion,lineage_schema:l.lineageSchema,turn_owner_key:l.turnOwnerKey,generation_attempt_id:l.generationAttemptId};
 const json=JSON.stringify(packet),inner=decoration==='angles'?` >>>\n${json}\n<<< `:decoration==='fence'?`\n\x60\x60\x60json\n${json}\n\x60\x60\x60\n`:`\n${json}\n<!-- `;
 const response=`Alice-1 completed the established event for turn 1.\nHAYAKU_STATE_PACKET_START${inner}HAYAKU_STATE_PACKET_END`;
 await r.callAfterRequest(response);r.chat.message.push({role:'assistant',chatId:'a1',data:response});r.chat.messages=r.chat.message;
 await r.callChatOutput({char:r.character,chat:r.chat,characterIndex:0,chatIndex:0,messageIndex:1});
 await waitFor(()=>r.hayaku.lastDebug().lastStorageCapture?.durable===true,'decorated packet durable capture');
 const observed=await r.hayaku._test.currentChatScope();
 await r.hayaku._test.reconcileObservedChatTopology(observed,r.hayaku._test.authoritativeChatSnapshot(observed.chatMessages,observed),'marker_first_regression');
 assert.equal(r.fetchCalls.length,0);assert.equal(r.llmCalls.length,0);
 const ledger=[...store.values].find(([key])=>key.startsWith('hayaku.v2.ledger.'));assert.ok(ledger,'physical ledger exists');
 const record=JSON.parse(ledger[1]).records[0];assert.equal(record.packetType,'current_snapshot');
 assert.ok(record.ownerTurnNodeId,'record binds to the observed native turn');
 const raw=await store.getItem(record.captureRawRef.storageKey);assert.ok(raw.includes('Alice-1'),'referenced physical packet retains its content');
});
