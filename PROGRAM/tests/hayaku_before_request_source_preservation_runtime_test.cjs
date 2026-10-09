'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const source=process.env.HAYAKU_RECALL_TEST_SOURCE;

test('beforeRequest ledger preservation uses the actual authoritative transcript',async()=>{
  const messages=[];for(let turn=1;turn<=3;turn++){
    const p=createValidPacket({turn,summary:'Established testimony '+turn});
    messages.push({role:'user',chatId:'preserve-u'+turn,data:'Question '+turn},{role:'assistant',chatId:'preserve-a'+turn,data:hiddenPacketMessage('Reply '+turn,p)});
  }
  const h=await createHayakuRuntime({pluginSourceFile:source,autoRepair:false,afterRequestAutoRepair:false,messages,arguments:{hayaku_packet_recovery:'false'}});
  try{
    await h.callBeforeRequest([{role:'user',content:'What testimony was established?'}],'model');
    const t=h.hayaku._test,scope=await t.currentChatScope(),ledger=await t.loadStorageLedger(scope);
    const active=ledger.records.filter(r=>r.recordState==='active');assert.equal(active.length,3);
    for(const record of active){
      assert.ok(record.sourceEvidenceRef?.key,'every admitted packet has its original U+A evidence reference');
      const raw=await h.host.pluginStorage.getItem(record.sourceEvidenceRef.key),saved=JSON.parse(raw);
      assert.equal(saved.binding.scopeKey,scope.key);assert.equal(saved.binding.sourceDigest,record.sourceEvidenceRef.sourceDigest);
      assert.equal(saved.rows[0].userRaw,'Question '+record.targetPairIndex);
      assert.equal(saved.rows[0].assistantRaw,messages[record.targetPairIndex*2-1].data);
    }
    assert.ok(h.hayaku.lastDebug().messageRevisionCache.stats.retainedChars>0,'a descriptor without message bodies cannot prune the real authoritative snapshot cache');
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});

test('preserved authoritative evidence survives restart and a later completed turn',async()=>{
  const messages=[];
  const append=turn=>{
    const packet=createValidPacket({turn,summary:'Verified witness statement '+turn});
    messages.push({role:'user',chatId:'restart-u'+turn,data:'Witness question '+turn},
      {role:'assistant',chatId:'restart-a'+turn,data:hiddenPacketMessage('Witness reply '+turn,packet)});
  };
  [1,2,3].forEach(append);
  const first=await createHayakuRuntime({pluginSourceFile:source,autoRepair:false,afterRequestAutoRepair:false,messages,arguments:{hayaku_packet_recovery:'false'}});
  let second=null;
  try{
    await first.callBeforeRequest([{role:'user',content:'What was established?'}],'model');
    const scope=await first.hayaku._test.currentChatScope(),ledger=await first.hayaku._test.loadStorageLedger(scope);
    const refs=ledger.records.filter(r=>r.recordState==='active').map(r=>r.sourceEvidenceRef);
    assert.equal(refs.length,3);assert.ok(refs.every(ref=>ref?.key),'the first hook durably preserves all original sources');
    const originals=await Promise.all(refs.map(async ref=>({ref,raw:await first.host.pluginStorage.getItem(ref.key)})));
    await first.dispose();append(4);
    second=await createHayakuRuntime({pluginSourceFile:source,autoRepair:false,afterRequestAutoRepair:false,messages,
      pluginStorage:first.host.pluginStorage,safeLocalStorage:first.host.safeLocalStorage,arguments:{hayaku_packet_recovery:'false'}});
    await second.callBeforeRequest([{role:'user',content:'What was established?'}],'model');
    const restoredScope=await second.hayaku._test.currentChatScope(),restored=await second.hayaku._test.loadStorageLedger(restoredScope);
    assert.equal(restoredScope.key,scope.key);
    const active=restored.records.filter(r=>r.recordState==='active');assert.equal(active.length,4);
    for(const {ref,raw}of originals){
      assert.equal(await second.host.pluginStorage.getItem(ref.key),raw,'restart and append preserve the exact old raw evidence bytes');
      assert.ok(active.some(r=>r.sourceEvidenceRef?.key===ref.key));
    }
    const added=active.find(r=>r.targetPairIndex===4);assert.ok(added.sourceEvidenceRef?.key);
    const saved=JSON.parse(await second.host.pluginStorage.getItem(added.sourceEvidenceRef.key));
    assert.equal(saved.rows[0].userRaw,'Witness question 4');assert.equal(saved.rows[0].assistantRaw,messages[7].data);
    assert.equal(first.llmCalls.length+second.llmCalls.length,0);assert.equal(first.fetchCalls.length+second.fetchCalls.length,0);
  }finally{await second?.dispose();await first.dispose();}
});
