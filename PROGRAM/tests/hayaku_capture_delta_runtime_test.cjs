'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {createHayakuRuntime,createStore,createValidPacket,hiddenPacketMessage,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const PREFIX='hayaku.v2.storage_reconciliation_journal.capture_delta::';
async function start(store=createStore(),userPayload='Alice-1 completes the established event for turn 1.'){
  await store.setItem('hayaku.v2.settings.source-tracking.v1',JSON.stringify({mode:'off',epoch:0}));
  const messages=[{role:'user',chatId:'capture-user',data:userPayload}];
  const h=await createHayakuRuntime({messages,pluginStorage:store,autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,
    pluginSourceFile:process.env.HAYAKU_TEST_SOURCE||undefined,
    arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('MODEL_PROHIBITED');}});
  await h.callBeforeRequest([{role:'system',content:'Continue the story.'},...messages]);
  const scope=await h.hayaku._test.currentChatScope(),pending=h.hayaku._test.selectPendingCapture([],scope,'model');assert.ok(pending);
  const visible='Alice-1 completed the established event for turn 1.',packet=createValidPacket({summary:visible});const l=pending.lineage;
  packet.meta.lineage={request_nonce:l.requestNonce,parent_turn_node_id:l.parentTurnNodeId,logical_turn_id:l.logicalTurnId,
    identity_version:l.identityVersion,lineage_schema:l.lineageSchema,turn_owner_key:l.turnOwnerKey,generation_attempt_id:l.generationAttemptId};
  const response=hiddenPacketMessage(visible,packet);assert.equal(h.hayaku._test.packetCaptureInspectionFromText(response).validCount,1);
  return {h,scope,pending,response,raw:JSON.stringify(packet)};
}
async function emit(h,response){await h.callAfterRequest(response);h.chat.message.push({role:'assistant',chatId:'capture-assistant',data:response});h.chat.messages=h.chat.message;
  await h.callChatOutput({char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:h.chat.message.length-1});}
test('registered committed output durably acknowledges latest exact raw delta before full ledger queue completes',async()=>{
  const store=createStore();let release;const held=new Promise(r=>release=r),set=store.setItem;let ledgerEntered=false,holdLedger=false;
  store.setItem=async(key,value)=>{if(holdLedger&&key.startsWith('hayaku.v2.ledger.')){ledgerEntered=true;await held;}return set(key,value);};
  const {h,scope,response,raw}=await start(store);holdLedger=true;
  try{const began=performance.now();await emit(h,response);const returnMs=performance.now()-began;await waitFor(()=>ledgerEntered,'canonical ledger queue entry');
    const receipt=h.hayaku.lastDebug().lastCaptureReceipt;assert.equal(receipt?.rawDurable,true,'latest raw must have its own exact durable readback before the held full ledger');
    assert.equal(receipt.memoryReady,false);assert.equal(receipt.scopeKey,scope.key);assert.ok(receipt.durableAckAt>=receipt.observedAt);
    const deltas=[...store.values].filter(([key])=>key.startsWith(PREFIX));assert.equal(deltas.length,1);const body=JSON.parse(deltas[0][1]);
    assert.equal(body.packets[0].raw,raw);assert.equal(body.sourcePayload.assistant,response);assert.equal(body.sourcePayload.user,h.chat.message[0].data);
    release();await waitFor(()=>h.hayaku.lastDebug().lastStorageCapture?.durable===true,'canonical memory commit');
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);console.log(JSON.stringify({control:'actual registered capture delta/ledger readiness',returnMs,receipt,queues:h.hayaku.lastDebug().captureQueues,capture:h.hayaku.lastDebug().lastStorageCapture}));
  }finally{release();await h.dispose();}
});
test('a failed canonical write remains retryable by the same registered finalized callback',async()=>{
  const store=createStore(),set=store.setItem;let fail=false,failed=false;
  store.setItem=async(key,value)=>{if(fail&&key.startsWith('hayaku.v2.ledger.')){failed=true;throw Error('CONTROL_CANONICAL_WRITE_FAILED');}return set(key,value);};
  const {h,response}=await start(store);try{
    fail=true;await emit(h,response);await waitFor(()=>failed&&h.hayaku.lastDebug().lastStorageCapture?.durable===false,'first failure reported');
    fail=false;
    await h.callChatOutput({char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:1});
    await waitFor(()=>h.hayaku.lastDebug().lastStorageCapture?.durable===true,'same callback durable retry');
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});
test('latest edited output receipt acknowledges before a blocked canonical queue and stale commit cannot publish readiness',async()=>{
  const store=createStore(),set=store.setItem;let hold=false,entered=false,release;const held=new Promise(r=>release=r);
  store.setItem=async(key,value)=>{if(hold&&key.startsWith('hayaku.v2.ledger.')){entered=true;await held;}return set(key,value);};
  const {h,response,pending}=await start(store);try{
    hold=true;await emit(h,response);await waitFor(()=>entered,'first canonical blocked');
    const visible='Alice-1 completed the established event for turn 1 with a revised detail.',packet=createValidPacket({summary:visible});
    const l=pending.lineage;packet.meta.lineage={request_nonce:l.requestNonce,parent_turn_node_id:l.parentTurnNodeId,logical_turn_id:l.logicalTurnId,
      identity_version:l.identityVersion,lineage_schema:l.lineageSchema,turn_owner_key:l.turnOwnerKey,generation_attempt_id:l.generationAttemptId};
    const edited=hiddenPacketMessage(visible,packet),first=h.hayaku.lastDebug().lastCaptureReceipt?.storageKey;
    h.chat.message[1].data=edited;await h.callChatOutput({char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:1});
    await waitFor(()=>h.hayaku.lastDebug().lastCaptureReceipt?.rawDurable&&h.hayaku.lastDebug().lastCaptureReceipt?.storageKey!==first,'edited durable receipt before queue');
    assert.equal(h.hayaku.lastDebug().lastCaptureReceipt.memoryReady,false);
    assert.ok(h.hayaku.lastDebug().captureQueues.chatOutput.pending>=2);
    release();await waitFor(()=>h.hayaku.lastDebug().lastStorageCapture?.durable===true&&h.hayaku.lastDebug().captureQueues.chatOutput.pending===0,'latest queued canonical commit');
    const ledger=await h.hayaku._test.loadStorageLedger(await h.hayaku._test.currentChatScope());
    assert.ok(ledger.records.some(record=>record.raw===JSON.stringify(packet)));
    const receipts=[...store.values].filter(([key])=>key.startsWith(PREFIX));assert.equal(receipts.length,2);
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{release();await h.dispose();}
});
test('canonical captured packet references exact durable delta bytes and hydrates through existing restart ledger consumer',async()=>{
  const store=createStore(),{h,response,raw}=await start(store);let next;
  try{
    await emit(h,response);await waitFor(()=>h.hayaku.lastDebug().lastStorageCapture?.durable===true,'canonical memory commit');
    const physical=[...store.values].find(([key])=>key.startsWith('hayaku.v2.ledger.'));assert.ok(physical);
    const ledger=JSON.parse(physical[1]),record=ledger.records.find(record=>record.requestNonce);assert.ok(record.captureRawRef);
    assert.equal(record.raw,undefined,'the metadata ledger must not rewrite the old canonical raw corpus');
    const messages=h.chat.message.map(message=>({...message}));await h.dispose();
    next=await createHayakuRuntime({messages,pluginStorage:store,autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,
      arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('MODEL_PROHIBITED');}});
    const scope=await next.hayaku._test.currentChatScope(),hydrated=await next.hayaku._test.loadStorageLedger(scope);
    assert.equal(hydrated.records.find(item=>item.recordId===record.recordId)?.raw,raw);
    const key=record.captureRawRef.storageKey;await store.setItem(key,'corrupt receipt');
    await assert.rejects(()=>next.hayaku._test.loadStorageLedger(scope),/CAPTURE_RAW_REFERENCE_READBACK_FAILED/);
    assert.equal(next.llmCalls.length,0);assert.equal(next.fetchCalls.length,0);
  }finally{if(next)await next.dispose();else await h.dispose();}
});
test('receipt-only interrupted canonical commit replays exact bytes through existing persistence after restart',async()=>{
  const store=createStore(),set=store.setItem;let fail=false;
  store.setItem=async(key,value)=>{if(fail&&key.startsWith('hayaku.v2.ledger.'))throw Error('CONTROL_INTERRUPTED_LEDGER');return set(key,value);};
  const {h,response,raw}=await start(store);let next;
  try{
    fail=true;await emit(h,response);await waitFor(()=>h.hayaku.lastDebug().lastStorageCapture?.durable===false,'failed canonical commit');
    assert.equal(h.hayaku.lastDebug().lastCaptureReceipt.rawDurable,true);const messages=h.chat.message.map(message=>({...message}));
    await h.dispose();fail=false;
    next=await createHayakuRuntime({messages,pluginStorage:store,autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,
      arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('MODEL_PROHIBITED');}});
    await next.callBeforeRequest([{role:'system',content:'Continue the story.'},...messages]);
    await waitFor(()=>next.hayaku.lastDebug().captureRawReplay?.replayed>=1,'durable orphan raw replay');
    const ledger=await next.hayaku._test.loadStorageLedger(await next.hayaku._test.currentChatScope());
    assert.ok(ledger.records.some(record=>record.raw===raw));
    assert.equal(next.llmCalls.length,0);assert.equal(next.fetchCalls.length,0);
    console.log(JSON.stringify({control:'receipt-only restart replay',replay:next.hayaku.lastDebug().captureRawReplay}));
  }finally{if(next)await next.dispose();else await h.dispose();}
});
test('raw-store failure stays truthful and preserves original source transport for explicit retry',async()=>{
  const store=createStore(),set=store.setItem;let fail=false;
  store.setItem=async(key,value)=>{if(fail&&key.startsWith(PREFIX))throw Error('CONTROL_RAW_STORE_FAILED');return set(key,value);};
  const {h,response}=await start(store);try{
    fail=true;await emit(h,response);await waitFor(()=>h.hayaku.lastDebug().lastCaptureReceipt!==null,'raw failure outcome');
    assert.equal(h.hayaku.lastDebug().lastCaptureReceipt.rawDurable,false);assert.equal(h.chat.message[1].data,response);
    await waitFor(()=>h.hayaku.lastDebug().captureQueues.chatOutput.pending===0,'failed receipt fallback completes');
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});
test('actual provider replacement during raw write rejects the old receipt and retains exact original bytes',async()=>{
  const store=createStore(),set=store.setItem;let hold=false,entered=false,release;const held=new Promise(r=>release=r);
  store.setItem=async(key,value)=>{if(hold&&key.startsWith(PREFIX)){entered=true;await held;}return set(key,value);};
  const {h,response}=await start(store);try{
    hold=true;await emit(h,response);await waitFor(()=>entered,'raw write entered');
    const replacement=createStore();h.host.pluginStorage=replacement;release();
    await waitFor(()=>h.hayaku.lastDebug().lastCaptureReceipt!==null,'changed provider receipt result');
    assert.equal(h.hayaku.lastDebug().lastCaptureReceipt.rawDurable,false);
    assert.equal([...replacement.values.keys()].filter(key=>key.startsWith(PREFIX)).length,0);
    assert.equal(h.chat.message[1].data,response);
    const old=[...store.values].find(([key])=>key.startsWith(PREFIX));assert.ok(old);assert.equal(JSON.parse(old[1]).sourcePayload.assistant,response);
    await waitFor(()=>h.hayaku.lastDebug().captureQueues.chatOutput.pending===0,'replacement fallback completed');
    for(const [key,value]of replacement.values)if(key.startsWith('hayaku.v2.ledger.'))assert.ok(JSON.parse(value).records.every(record=>!record.captureRawRef));
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{release();await h.dispose();}
});
test('deleted source during raw write cannot publish receipt readiness',async()=>{
  const store=createStore(),set=store.setItem;let hold=false,entered=false,release;const held=new Promise(r=>release=r);
  store.setItem=async(key,value)=>{if(hold&&key.startsWith(PREFIX)){entered=true;await held;}return set(key,value);};
  const {h,response}=await start(store);try{
    hold=true;await emit(h,response);await waitFor(()=>entered,'raw write entered');h.chat.message.splice(1,1);release();
    await waitFor(()=>h.hayaku.lastDebug().lastCaptureReceipt!==null,'deleted source receipt result');
    assert.equal(h.hayaku.lastDebug().lastCaptureReceipt.rawDurable,false);assert.equal(h.hayaku.lastDebug().lastCaptureReceipt.memoryReady,false);
    const old=[...store.values].find(([key])=>key.startsWith(PREFIX));assert.ok(old);assert.equal(JSON.parse(old[1]).sourcePayload.assistant,response);
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{release();await h.dispose();}
});
test('receipt retention saturation reports shortage without dropping original committed output',async()=>{
  const store=createStore(),{h,scope,response}=await start(store);try{
    for(let i=0;i<4096;i++)await store.setItem(PREFIX+scope.key+'::reserved::'+i,'reserved');
    await emit(h,response);await waitFor(()=>h.hayaku.lastDebug().lastCaptureReceipt!==null,'saturation result');
    assert.equal(h.hayaku.lastDebug().lastCaptureReceipt.rawDurable,false);
    assert.equal(h.hayaku.lastDebug().lastCaptureReceipt.reason,'capture_delta_retention_limit');assert.equal(h.chat.message[1].data,response);
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});
test('actual committed raw acknowledges before fixture analysis authoring and later canonical memory commit',async()=>{
  const store=createStore(),{h,pending}=await start(store);try{
    const visible='Alice-1 completed the established event for turn 1.';await emit(h,visible);
    await waitFor(()=>h.hayaku.lastDebug().lastCaptureReceipt?.rawDurable===true,'raw source before fixture analysis');
    const rawReceipt=h.hayaku.lastDebug().lastCaptureReceipt;
    assert.equal(rawReceipt.packetGroupVerified,false);assert.equal(rawReceipt.packetCount,0);assert.equal(rawReceipt.memoryReady,false);
    const physical=JSON.parse(store.values.get(rawReceipt.storageKey));assert.equal(physical.sourcePayload.assistant,visible);
    const fixtureBegan=performance.now(),packet=createValidPacket({summary:visible}),l=pending.lineage;
    packet.meta.lineage={request_nonce:l.requestNonce,parent_turn_node_id:l.parentTurnNodeId,logical_turn_id:l.logicalTurnId,
      identity_version:l.identityVersion,lineage_schema:l.lineageSchema,turn_owner_key:l.turnOwnerKey,generation_attempt_id:l.generationAttemptId};
    const response=hiddenPacketMessage(visible,packet),fixtureLatencyMs=performance.now()-fixtureBegan;
    h.chat.message[1].data=response;await h.callChatOutput({char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:1});
    await waitFor(()=>h.hayaku.lastDebug().lastStorageCapture?.packetGroupComplete===true,'fixture canonical commit');
    assert.equal(h.hayaku.lastDebug().lastCaptureReceipt.packetGroupVerified,true);
    assert.equal(h.hayaku.lastDebug().lastStorageCapture.captureTimings.embeddingReadyAt,null);
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
    console.log(JSON.stringify({control:'raw before fixture analysis',fixtureLatencyMs,rawReceipt,canonical:h.hayaku.lastDebug().lastStorageCapture.captureTimings}));
  }finally{await h.dispose();}
});
test('duplicate finalized callbacks coalesce bounded canonical work after exact raw acknowledgement',async()=>{
  const store=createStore(),set=store.setItem;let hold=false,entered=false,release;const held=new Promise(r=>release=r);
  store.setItem=async(key,value)=>{if(hold&&key.startsWith('hayaku.v2.ledger.')){entered=true;await held;}return set(key,value);};
  const {h,response}=await start(store);try{
    hold=true;await emit(h,response);await waitFor(()=>entered,'canonical queue entered');
    for(let i=0;i<16;i++)await h.callChatOutput({char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:1});
    await waitFor(()=>h.hayaku.lastDebug().captureQueues.chatOutput.pending>1||h.hayaku.lastDebug().captureQueues.canonical?.coalesced>=16,'duplicate canonical joins');
    assert.equal(h.hayaku.lastDebug().captureQueues.chatOutput.pending,1,'identical callbacks must not enqueue repeated full canonical work');
    assert.equal(h.hayaku.lastDebug().captureQueues.canonical.pending,1);
    assert.equal([...store.values].filter(([key])=>key.startsWith(PREFIX)).length,1);
    release();await waitFor(()=>h.hayaku.lastDebug().captureQueues.canonical.pending===0,'joined canonical completes');
    assert.equal(h.hayaku.lastDebug().lastStorageCapture.packetGroupComplete,true);
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{release();await h.dispose();}
});
test('raw-only durable source preserves multilingual UTF16 text and original UTF8 bytes including CRLF and literal escapes',async()=>{
  const user='Alice-1 completes the established event.\r\n한국어 日本語 🐈‍⬛ "quotes" \\u2028 &lt;source&gt;';
  const assistant='Alice-1 completed the event.\r\n日本語 한국어 💾 \\n literal &lt;result&gt;';
  const store=createStore(),{h}=await start(store,user);try{
    await emit(h,assistant);await waitFor(()=>h.hayaku.lastDebug().lastCaptureReceipt?.rawDurable===true,'multilingual exact raw readback');
    const receipt=h.hayaku.lastDebug().lastCaptureReceipt,physical=JSON.parse(store.values.get(receipt.storageKey));
    assert.equal(physical.sourcePayload.user,user);assert.equal(physical.sourcePayload.assistant,assistant);
    assert.deepEqual(Buffer.from(physical.sourcePayload.user,'utf8'),Buffer.from(user,'utf8'));
    assert.deepEqual(Buffer.from(physical.sourcePayload.assistant,'utf8'),Buffer.from(assistant,'utf8'));
    assert.equal(receipt.packetGroupVerified,false);assert.equal(receipt.memoryReady,false);
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});
test('first legacy reference migration is explicit and subsequent edit never rewrites old packet corpus',async()=>{
  const store=createStore(),{h,scope,response,pending}=await start(store);try{
    const ledger=await h.hayaku._test.loadStorageLedger(scope),records=Array.from({length:100},(_,i)=>{
      const raw=JSON.stringify(createValidPacket({turn:i+1,summary:`seed history ${i}`}));
      return {raw,recordId:`seed-${i}`,packetType:'current_snapshot',targetPairIndex:i+1,
        inheritedSessionHistory:true,permanentSessionHistory:true,recordState:'historical',memoryClass:'historical',captureSource:'inline_fixture'};
    });
    assert.equal((await h.hayaku._test.writeStorageLedgerDirect(scope,{...ledger,records},'fixture_inline')).durable,true);
    await emit(h,response);await waitFor(()=>h.hayaku.lastDebug().lastStorageCapture?.packetGroupComplete===true,'first compact canonical commit');
    const first=h.hayaku.lastDebug().lastStorageCapture;assert.equal(first.rawMigrationWrites,100);
    const visible='Alice-1 completed the established event for turn 1 with a revised detail.',packet=createValidPacket({summary:visible}),l=pending.lineage;
    packet.meta.lineage={request_nonce:l.requestNonce,parent_turn_node_id:l.parentTurnNodeId,logical_turn_id:l.logicalTurnId,
      identity_version:l.identityVersion,lineage_schema:l.lineageSchema,turn_owner_key:l.turnOwnerKey,generation_attempt_id:l.generationAttemptId};
    h.chat.message[1].data=hiddenPacketMessage(visible,packet);await h.callChatOutput({char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:1});
    await waitFor(()=>h.hayaku.lastDebug().lastStorageCapture?.revision===2&&h.hayaku.lastDebug().lastStorageCapture?.packetGroupComplete===true,'next compact canonical edit');
    const next=h.hayaku.lastDebug().lastStorageCapture;assert.equal(next.rawMigrationWrites,0);assert.equal(next.rawMigrationWriteChars,0);
    const physical=JSON.parse(store.values.get('hayaku.v2.ledger.'+scope.key));assert.ok(physical.records.every(record=>record.raw===undefined&&record.captureRawRef));
    assert.equal(next.ledgerWritePolicy,'compact_metadata_with_verified_raw_references');assert.ok(next.rawReferenceVerificationReads>=100);
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
    console.log(JSON.stringify({control:'legacy migration versus incremental raw write',firstMigrationWrites:first.rawMigrationWrites,
      firstMigrationChars:first.rawMigrationWriteChars,nextMigrationWrites:next.rawMigrationWrites,metadataChars:next.ledgerWriteChars,
      oldRawVerificationReads:next.rawReferenceVerificationReads,oldRawVerificationChars:next.rawReferenceVerificationChars}));
  }finally{await h.dispose();}
});
test('existing portable export and same-scope restore preserve captured raw reference dependencies',async()=>{
  const store=createStore(),{h,response,raw}=await start(store);let next;
  try{
    await emit(h,response);await waitFor(()=>h.hayaku.lastDebug().lastStorageCapture?.packetGroupComplete===true,'canonical commit for portable');
    const portable=await waitFor(()=>h.context.__HAYAKUPortableMemoryBackup,'portable source API'),envelope=await portable.exportCurrentScope();
    const receipt=h.hayaku.lastDebug().lastCaptureReceipt;
    assert.ok(envelope.records.some(record=>record.key===receipt.storageKey),'scope-owned raw dependency must enter existing portable graph');
    const messages=h.chat.message.map(message=>({...message}));await h.dispose();
    const target=createStore();await target.setItem('hayaku.v2.settings.source-tracking.v1',JSON.stringify({mode:'off',epoch:0}));
    next=await createHayakuRuntime({messages,pluginStorage:target,autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,
      arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('MODEL_PROHIBITED');}});
    const api=await waitFor(()=>next.context.__HAYAKUPortableMemoryBackup,'portable target API');await api.restoreCurrentScope(envelope);
    const ledger=await next.hayaku._test.loadStorageLedger(await next.hayaku._test.currentChatScope());
    assert.ok(ledger.records.some(record=>record.raw===raw&&record.captureRawRef));
    assert.equal(next.llmCalls.length,0);assert.equal(next.fetchCalls.length,0);
  }finally{if(next)await next.dispose();else await h.dispose();}
});
test('source edited before immutable receipt write preserves both exact observed variants and adopts only the current one',async()=>{
  const store=createStore(),get=store.getItem;let hold=false,entered=false,release;const held=new Promise(r=>release=r);
  store.getItem=async(key)=>{if(hold&&key.startsWith(PREFIX)){entered=true;await held;}return get(key);};
  const {h,response,pending}=await start(store);try{
    hold=true;await emit(h,response);await waitFor(()=>entered,'first raw receipt pre-write read');
    const visible='Alice-1 completed the established event with the current revised detail.',packet=createValidPacket({summary:visible}),l=pending.lineage;
    packet.meta.lineage={request_nonce:l.requestNonce,parent_turn_node_id:l.parentTurnNodeId,logical_turn_id:l.logicalTurnId,
      identity_version:l.identityVersion,lineage_schema:l.lineageSchema,turn_owner_key:l.turnOwnerKey,generation_attempt_id:l.generationAttemptId};
    const currentResponse=hiddenPacketMessage(visible,packet),currentRaw=JSON.stringify(packet);
    h.chat.message[1].data=currentResponse;await h.callChatOutput({char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:1});
    release();await waitFor(()=>h.hayaku.lastDebug().captureQueues.chatOutput.pending===0&&Number(h.hayaku.lastDebug().captureRawQueue?.pending||0)===0,'both observed variants finish');
    const bodies=[...store.values].filter(([key])=>key.startsWith(PREFIX)).map(([,value])=>JSON.parse(value));
    assert.ok(bodies.some(body=>body.sourcePayload?.assistant===response),'obsolete observed bytes must remain in their immutable audit receipt');
    assert.ok(bodies.some(body=>body.sourcePayload?.assistant===currentResponse),'current observed bytes must have their own immutable receipt');
    const ledger=await h.hayaku._test.loadStorageLedger(await h.hayaku._test.currentChatScope());
    assert.ok(ledger.records.some(record=>record.raw===currentRaw));assert.equal(h.hayaku.lastDebug().lastStorageCapture.packetGroupComplete,true);
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{release();await h.dispose();}
});
test('completed duplicate callback cannot borrow old provider acknowledgement and fresh reader requires physical raw dependencies',async()=>{
  const store=createStore(),{h,response,raw}=await start(store);let next;
  try{
    await emit(h,response);await waitFor(()=>h.hayaku.lastDebug().lastStorageCapture?.packetGroupComplete===true,'old provider canonical commit');
    const scope=await h.hayaku._test.currentChatScope(),receipt=h.hayaku.lastDebug().lastCaptureReceipt,ledgerKey='hayaku.v2.ledger.'+scope.key;
    const replacement=createStore();await replacement.setItem('hayaku.v2.settings.source-tracking.v1',JSON.stringify({mode:'off',epoch:0}));
    h.host.pluginStorage=replacement;await h.callChatOutput({char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:1});
    await waitFor(()=>replacement.values.has(receipt.storageKey)&&replacement.values.has(ledgerKey),'replacement own durable receipt and canonical commit');
    const physical=JSON.parse(replacement.values.get(ledgerKey));assert.ok(physical.records.some(record=>record.captureRawRef?.storageKey===receipt.storageKey));
    const messages=h.chat.message.map(message=>({...message}));await h.dispose();
    const incomplete=createStore();await incomplete.setItem('hayaku.v2.settings.source-tracking.v1',JSON.stringify({mode:'off',epoch:0}));
    await incomplete.setItem(ledgerKey,replacement.values.get(ledgerKey));
    next=await createHayakuRuntime({messages,pluginStorage:incomplete,autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,
      arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('MODEL_PROHIBITED');}});
    const targetScope=await next.hayaku._test.currentChatScope();
    await assert.rejects(()=>next.hayaku._test.loadStorageLedger(targetScope),/CAPTURE_RAW_REFERENCE_READBACK_FAILED/);
    await incomplete.setItem(receipt.storageKey,replacement.values.get(receipt.storageKey));
    const restored=await next.hayaku._test.loadStorageLedger(targetScope);assert.ok(restored.records.some(record=>record.raw===raw));
    assert.equal(next.llmCalls.length,0);assert.equal(next.fetchCalls.length,0);
  }finally{if(next)await next.dispose();else await h.dispose();}
});
test('distinct pending raw variants hit bounded queue shortage and retry current original bytes without losing accepted audit receipts',async()=>{
  const store=createStore(),set=store.setItem;let hold=false,entered=false,release;const held=new Promise(r=>release=r);
  store.setItem=async(key,value)=>{if(hold&&key.startsWith(PREFIX)){entered=true;await held;}return set(key,value);};
  const {h,response,pending}=await start(store);try{
    hold=true;await emit(h,response);await waitFor(()=>entered,'held raw variant queue');
    const variants=[response],callbacks=[],l=pending.lineage;
    for(let i=1;i<=64;i++){
      const visible=`Alice-1 completed the established event with distinct variant ${i}.`,packet=createValidPacket({summary:visible});
      packet.meta.lineage={request_nonce:l.requestNonce,parent_turn_node_id:l.parentTurnNodeId,logical_turn_id:l.logicalTurnId,
        identity_version:l.identityVersion,lineage_schema:l.lineageSchema,turn_owner_key:l.turnOwnerKey,generation_attempt_id:l.generationAttemptId};
      const variant=hiddenPacketMessage(visible,packet);variants.push(variant);h.chat.message[1].data=variant;
      callbacks.push(h.callChatOutput({char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:1}));
    }
    await Promise.all(callbacks);
    await waitFor(()=>h.hayaku.lastDebug().lastCaptureReceipt?.reason==='capture_observation_queue_saturated','bounded observed raw queue shortage');
    assert.equal(h.hayaku.lastDebug().lastCaptureReceipt.rawDurable,false);assert.equal(h.hayaku.lastDebug().captureObservationQueue.pending,64);
    assert.equal(h.chat.message[1].data,variants[64]);
    await waitFor(()=>h.hayaku.lastDebug().captureRawQueue.pending===64,'admitted observed variants enter bounded raw work');
    release();await waitFor(()=>h.hayaku.lastDebug().captureObservationQueue.pending===0&&h.hayaku.lastDebug().captureRawQueue.pending===0&&h.hayaku.lastDebug().captureQueues.chatOutput.pending===0,'pending obsolete variants preserved');
    const bodies=[...store.values].filter(([key])=>key.startsWith(PREFIX)).map(([,value])=>JSON.parse(value));
    assert.ok(bodies.some(body=>body.sourcePayload?.assistant===variants[0]));assert.equal(bodies.length,64);
    await h.callChatOutput({char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:1});
    await waitFor(()=>h.hayaku.lastDebug().lastCaptureReceipt?.rawDurable===true&&h.hayaku.lastDebug().lastStorageCapture?.packetGroupComplete===true,'current source explicit retry');
    const accepted=JSON.parse(store.values.get(h.hayaku.lastDebug().lastCaptureReceipt.storageKey));assert.equal(accepted.sourcePayload.assistant,variants[64]);
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{release();await h.dispose();}
});
test('same-tick finalized callbacks preserve callback-observed source bytes before deferred worker begins',async()=>{
  const store=createStore(),{h,response,pending}=await start(store);try{
    await h.callAfterRequest(response);h.chat.message.push({role:'assistant',chatId:'capture-assistant',data:response});h.chat.messages=h.chat.message;
    const event={char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:1},first=h.callChatOutput(event);
    const visible='Alice-1 completed the event with the same-tick current variant.',packet=createValidPacket({summary:visible}),l=pending.lineage;
    packet.meta.lineage={request_nonce:l.requestNonce,parent_turn_node_id:l.parentTurnNodeId,logical_turn_id:l.logicalTurnId,
      identity_version:l.identityVersion,lineage_schema:l.lineageSchema,turn_owner_key:l.turnOwnerKey,generation_attempt_id:l.generationAttemptId};
    const next=hiddenPacketMessage(visible,packet);h.chat.message[1].data=next;const second=h.callChatOutput(event);await Promise.all([first,second]);
    await waitFor(()=>h.hayaku.lastDebug().captureRawQueue.pending===0&&h.hayaku.lastDebug().lastStorageCapture?.packetGroupComplete===true,'same-tick captures settle');
    const bodies=[...store.values].filter(([key])=>key.startsWith(PREFIX)).map(([,value])=>JSON.parse(value));
    assert.ok(bodies.some(body=>body.sourcePayload?.assistant===response),'first callback exact raw must survive the deferred worker boundary');
    assert.ok(bodies.some(body=>body.sourcePayload?.assistant===next));
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});
test('timed-out raw provider write stays indeterminate until actual late completion and fresh exact readback',async()=>{
  const store=createStore(),set=store.setItem;let hold=false,entered=false,release;const held=new Promise(r=>release=r);
  store.setItem=async(key,value)=>{if(hold&&key.startsWith(PREFIX)){entered=true;await held;}return set(key,value);};
  const {h,response}=await start(store);try{
    hold=true;await emit(h,response);await waitFor(()=>entered,'raw underlying provider entered');
    await waitFor(()=>h.hayaku.lastDebug().lastCaptureReceipt?.storageState==='indeterminate','raw outcome timeout');
    assert.equal(h.hayaku.lastDebug().lastCaptureReceipt.rawDurable,false);assert.equal([...store.values.keys()].filter(key=>key.startsWith(PREFIX)).length,0);
    assert.equal(h.chat.message[1].data,response);
    release();await waitFor(()=>[...store.values.keys()].some(key=>key.startsWith(PREFIX))&&h.hayaku.lastDebug().captureObservationQueue.pending===0,'actual late physical completion');
    await h.callChatOutput({char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:1});
    await waitFor(()=>h.hayaku.lastDebug().lastCaptureReceipt?.rawDurable===true&&h.hayaku.lastDebug().lastStorageCapture?.revision>=2&&h.hayaku.lastDebug().lastStorageCapture?.packetGroupComplete===true,'retry exact current readback after timeout');
    const receipt=h.hayaku.lastDebug().lastCaptureReceipt;assert.equal(receipt.rawWriteChars,0);
    assert.equal(JSON.parse(store.values.get(receipt.storageKey)).sourcePayload.assistant,response);
    const physical=JSON.parse(store.values.get('hayaku.v2.ledger.'+receipt.scopeKey));assert.ok(physical.records.some(record=>record.captureRawRef?.storageKey===receipt.storageKey));
    console.log(JSON.stringify({control:'timed-out raw provider exact retry',rawWriteChars:receipt.rawWriteChars,
      rawAckAt:receipt.durableAckAt,canonicalCommittedAt:h.hayaku.lastDebug().lastStorageCapture.captureTimings.memoryCommittedAt}));
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{release();await h.dispose();}
});
test('concurrent raw receipts reserve shared provider and scope capacity before physical completion',async()=>{
  const store=createStore(),set=store.setItem;let hold=false,entered=0,release;const held=new Promise(r=>release=r);
  store.setItem=async(key,value)=>{if(hold&&key.startsWith(PREFIX)){entered++;await held;}return set(key,value);};
  const {h,response,pending,scope}=await start(store);try{
    for(let i=0;i<4095;i++)await store.setItem(PREFIX+scope.key+'::reserved::'+i,'reserved');
    hold=true;await emit(h,response);await waitFor(()=>entered===1,'first physical receipt pending');
    const visible='Alice-1 completed the established event with a second retention variant.',packet=createValidPacket({summary:visible}),l=pending.lineage;
    packet.meta.lineage={request_nonce:l.requestNonce,parent_turn_node_id:l.parentTurnNodeId,logical_turn_id:l.logicalTurnId,
      identity_version:l.identityVersion,lineage_schema:l.lineageSchema,turn_owner_key:l.turnOwnerKey,generation_attempt_id:l.generationAttemptId};
    const latest=hiddenPacketMessage(visible,packet);h.chat.message[1].data=latest;await h.callChatOutput({char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:1});
    await waitFor(()=>entered>1||h.hayaku.lastDebug().lastCaptureReceipt?.reason==='capture_delta_retention_limit','second reservation outcome');
    assert.equal(entered,1,'a pending physical write must consume the final receipt slot');
    assert.equal(h.hayaku.lastDebug().lastCaptureReceipt.rawDurable,false);assert.equal(h.chat.message[1].data,latest);
    release();await waitFor(()=>h.hayaku.lastDebug().captureObservationQueue.pending===0,'retention race settles');
    assert.equal([...store.values.keys()].filter(key=>key.startsWith(PREFIX+scope.key+'::')).length,4096);
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{release();await h.dispose();}
});
test('inline legacy migration shares receipt admission with a concurrent pending raw capture',async()=>{
  const store=createStore(),set=store.setItem;let hold=false,entered=false,release;const held=new Promise(r=>release=r);
  store.setItem=async(key,value)=>{if(hold&&key.startsWith(PREFIX)&&!JSON.parse(value).provenance){entered=true;await held;}return set(key,value);};
  const {h,response,pending,scope}=await start(store);try{
    await emit(h,response);await waitFor(()=>h.hayaku.lastDebug().lastStorageCapture?.packetGroupComplete===true,'seed canonical raw reference');
    const ledger=await h.hayaku._test.loadStorageLedger(scope),legacy=[2,3].map(turn=>({recordId:'legacy-'+turn,raw:JSON.stringify(createValidPacket({turn,summary:'Inline legacy '+turn})),
      targetPairIndex:turn,packetType:'current_snapshot',recordState:'historical',memoryClass:'historical',inheritedSessionHistory:true,permanentSessionHistory:true,captureSource:'inline_fixture'}));
    await store.setItem('hayaku.v2.ledger.'+scope.key,JSON.stringify({...ledger,records:[...ledger.records,...legacy]}));
    for(let i=0;i<4093;i++)await store.setItem(PREFIX+scope.key+'::reserved::'+i,'reserved');
    const visible='Alice-1 completed the established event alongside pending legacy migration.',packet=createValidPacket({summary:visible}),l=pending.lineage;
    packet.meta.lineage={request_nonce:l.requestNonce,parent_turn_node_id:l.parentTurnNodeId,logical_turn_id:l.logicalTurnId,
      identity_version:l.identityVersion,lineage_schema:l.lineageSchema,turn_owner_key:l.turnOwnerKey,generation_attempt_id:l.generationAttemptId};
    hold=true;h.chat.message[1].data=hiddenPacketMessage(visible,packet);await h.callChatOutput({char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:1});
    await waitFor(()=>entered,'latest raw receipt pending during migration');
    const commit=await h.hayaku._test.writeStorageLedgerDirect(scope,{...ledger,records:[...ledger.records,...legacy]},'mixed_retention_fixture');
    release();await waitFor(()=>h.hayaku.lastDebug().captureObservationQueue.pending===0,'mixed raw and migration settle');
    assert.ok([...store.values.keys()].filter(key=>key.startsWith(PREFIX+scope.key+'::')).length<=4096,'raw and migration writers must share physical retention admission');
    assert.equal(commit.durable,false);assert.equal(commit.reason,'CAPTURE_RAW_RETENTION_LIMIT');
    const reloaded=await h.hayaku._test.loadStorageLedger(scope);for(const record of legacy)assert.ok(reloaded.records.some(row=>row.raw===record.raw));
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{release();await h.dispose();}
});
