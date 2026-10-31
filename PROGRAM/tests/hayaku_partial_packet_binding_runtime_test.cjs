'use strict';
// 2026-10-31 live trace: the packet viewer showed T6's canonical packet as active,
// while the range check reported T6 missing (declared_parent_mismatch). T5's
// assistant message had changed in place after T6 was bound, so the reconcile
// minted a new T5 node; T6's packet still declared the previous T5 node, and the
// supersession link is only written after the reconcile loop, so the existing
// cascade rebase could not see it. Separately, a main-output packet cut off by the
// length limit was unusable as a whole; its finished axes are now salvaged and the
// stored packet is marked "일부 적용" in the ledger viewer.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHayakuRuntime,createStore,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');

const lineageOf=l=>({request_nonce:l.requestNonce,parent_turn_node_id:l.parentTurnNodeId,logical_turn_id:l.logicalTurnId,
  identity_version:l.identityVersion,lineage_schema:l.lineageSchema,turn_owner_key:l.turnOwnerKey,generation_attempt_id:l.generationAttemptId});
const visibleFor=n=>`Alice-${n} completed the established event for turn ${n}.`;
const wrapRaw=(visible,raw)=>`${visible}\n<!-- HAYAKU_STATE_PACKET_START ${raw} HAYAKU_STATE_PACKET_END -->`;

async function runtime(){
  const store=createStore();
  await store.setItem('hayaku.v2.settings.source-tracking.v1',JSON.stringify({mode:'off',epoch:0}));
  return await createHayakuRuntime({messages:[],pluginStorage:store,autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,
    pluginSourceFile:process.env.HAYAKU_TEST_SOURCE||undefined,
    arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('MODEL_PROHIBITED');}});
}
// One real turn: beforeRequest issues the lineage, the response carries a packet
// with it, then afterRequest and the committed chat output capture and bind it.
async function turn(h,n,render=(visible,packet)=>hiddenPacketMessage(visible,packet)){
  h.chat.message.push({role:'user',chatId:'u'+n,data:`User turn ${n}.`});h.chat.messages=h.chat.message;
  await h.callBeforeRequest([{role:'system',content:'Continue.'},...h.chat.message]);
  const t=h.hayaku._test,scope=await t.currentChatScope(),pending=t.selectPendingCapture([],scope,'model');
  const visible=visibleFor(n),packet=createValidPacket({turn:n,summary:visible});packet.meta.lineage=lineageOf(pending.lineage);
  const response=render(visible,packet);
  await h.callAfterRequest(response);
  h.chat.message.push({role:'assistant',chatId:'a'+n,data:response});h.chat.messages=h.chat.message;
  await h.callChatOutput({char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:h.chat.message.length-1});
  await new Promise(resolve=>setTimeout(resolve,400));
}
// The exact authority the range check uses: live snapshot, reconcile, bind, coverage.
async function coverage(h){
  const t=h.hayaku._test,scope=await t.currentChatScope(),snapshot=t.authoritativeChatSnapshot(scope.chatMessages,scope);
  const ledger=await t.loadStorageLedger(scope,{hydrateArchive:false,authoritativeSnapshot:snapshot});
  const worldline=t.reconcileTurnWorldline(ledger.worldline,snapshot,scope);
  const bound=t.bindStorageLedgerToSnapshot({...ledger,worldline},snapshot,worldline).ledger;
  return {rows:t.exactHayakuTurnCoverage(snapshot,bound,scope.key).rows,worldline,ledger};
}

test('a parent turn edited in place keeps the already bound child packet covered',async()=>{
  const h=await runtime();
  try{
    await turn(h,1);await turn(h,2);await turn(h,3);
    assert.equal(JSON.stringify((await coverage(h)).rows.map(row=>row.state)),JSON.stringify(['covered','covered','covered']));
    // T2's assistant text changes after T3 was bound (same message id and packet).
    h.chat.message[3].data=h.chat.message[3].data.replace('for turn 2.','for turn 2!');
    const {rows,worldline}=await coverage(h);
    const t3=rows.find(row=>row.turn===3);
    assert.equal(t3.state,'covered',JSON.stringify(t3));
    assert.notEqual(t3.reason,'declared_parent_mismatch');
    const node3=worldline.nodes.find(node=>node.pairIndex===3&&node.status==='active');
    assert.equal(node3.packetLineageStatus,'rebased');
    assert.equal(node3.packetLineageReason,'verified_upstream_cascade_rebase');
  }finally{await h.dispose();}
});

// The same-pass rebase only accepts the previous active node of the same user
// turn. A live packet declaring an unrelated parent stays quarantined.
test('a live packet declaring a foreign parent is still quarantined',async()=>{
  const h=await runtime();
  try{
    const packetFor=(n,lineage)=>{const packet=createValidPacket({turn:n,summary:visibleFor(n)});if(lineage)packet.meta.lineage=lineage;return hiddenPacketMessage(visibleFor(n),packet);};
    h.setMessages([
      {role:'user',chatId:'u1',data:'User turn 1.'},{role:'assistant',chatId:'a1',data:packetFor(1)},
      {role:'user',chatId:'u2',data:'User turn 2.'},{role:'assistant',chatId:'a2',data:packetFor(2)},
      {role:'user',chatId:'u3',data:'User turn 3.'},{role:'assistant',chatId:'a3',data:packetFor(3,{parent_turn_node_id:'h64notarealnode1',logical_turn_id:'h64notarealturn1',request_nonce:'h64notarealnonce'})}
    ]);
    const {rows,worldline}=await coverage(h);
    const t3=rows.find(row=>row.turn===3);
    assert.equal(t3.state,'missing',JSON.stringify(t3));assert.equal(t3.reason,'declared_parent_mismatch');
    assert.equal(worldline.nodes.find(node=>node.pairIndex===3).packetLineageStatus,'quarantined');
  }finally{await h.dispose();}
});

test('a packet cut off after finished axes is salvaged, bound and shown as partially applied',async()=>{
  const h=await runtime();
  try{
    const t=h.hayaku._test;
    // Cut-offs inside the meta axis carry no usable lineage and stay unusable.
    const raw=JSON.stringify(createValidPacket({turn:2,summary:visibleFor(2)}));
    assert.equal(t.conservativeJsonSyntaxRepair(raw.slice(0,60)).ok,false);
    const salvage=t.conservativeJsonSyntaxRepair(raw.slice(0,raw.indexOf('"planner"'))+'"planner":{"continuity_locks":[{"summary":"Alice rem');
    assert.equal(salvage.ok,true);assert.equal(JSON.stringify(salvage.droppedAxes),'["planner","importance"]');
    await turn(h,1);
    await turn(h,2,(visible,packet)=>{const full=JSON.stringify(packet);return wrapRaw(visible,full.slice(0,full.indexOf('"planner"'))+'"planner":{"continuity_locks":[{"summary":"Alice rem');});
    const {rows,ledger}=await coverage(h);
    assert.equal(rows.find(row=>row.turn===2).state,'covered',JSON.stringify(rows));
    const record=ledger.records.find(row=>row.targetPairIndex===2&&row.recordState!=='audit');
    assert.ok(record,'the salvaged packet is stored');
    const stored=JSON.parse(record.raw);
    assert.equal(stored.entity.characters[0].name,'Alice-2','finished axes are kept verbatim');
    assert.equal(JSON.stringify(stored.meta.record_admission.normalized.filter(row=>row.reason==='truncated_output_axis_dropped').map(row=>row.path)),'["planner","importance"]');
    const partial=t.viewerRecordPartialApply(record);
    assert.equal(JSON.stringify(partial.truncated),'["planner","importance"]');
    assert.match(t.viewerRecordOriginBadge(record),/data-origin="partial-apply"[^>]*>일부 적용</);
    // An intact packet carries no badge.
    const intact=ledger.records.find(row=>row.targetPairIndex===1);
    assert.equal(t.viewerRecordPartialApply(intact),null);
    assert.doesNotMatch(t.viewerRecordOriginBadge(intact),/일부 적용/);
  }finally{await h.dispose();}
});
