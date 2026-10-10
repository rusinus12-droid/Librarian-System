'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {test}=require('node:test');
const {createHayakuRuntime,createStore,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const facts=[['Aurora vault','amethyst calibration spindle','BENCH_A0'],['Borealis shelf','cobalt tuning prism','BENCH_B0'],['Cirrus case','jade alignment ring','BENCH_C0']];
function corpus(n){const rows=[];for(let turn=1;turn<=n;turn++){
  const fact=turn===1?facts[0]:turn===5?facts[1]:turn===9?facts[2]:null;
  const summary=fact?`${fact[0]} contains ${fact[1]} ${fact[2]}.`:`Routine archive entry ${turn} has been recorded.`;
  const packet=createValidPacket({turn,summary,subject:'Archivist',scene:'archive'});packet.world.world_rules=[{id:'fact-'+turn,summary}];
  rows.push({role:'user',chatId:'u'+turn,data:`Archive completed entry ${turn}.`},{role:'assistant',chatId:'a'+turn,data:hiddenPacketMessage(`Entry ${turn} completed: ${summary}`,packet)});
}return rows;}
function context(output){return output.filter(row=>row.memo==='hayaku-runtime-context-v3').map(row=>row.content||'').join('\n');}
async function runtime(messages=corpus(100),instrument=false){
  const store=createStore();await store.setItem('hayaku.v2.settings.source-tracking.v1',JSON.stringify({mode:'off',epoch:0}));
  let root,source=process.env.HAYAKU_TEST_SOURCE;
  if(instrument){root=fs.mkdtempSync(path.join(os.tmpdir(),'hayaku-owned-validation-'));source=path.join(root,'HAYAKU.js');
    const code=fs.readFileSync(process.env.HAYAKU_TEST_SOURCE||path.join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8'),needle='else if (validateHayakuPacket(parsedRaw).ok !== true) return null;';
    assert.ok(code.includes(needle));fs.writeFileSync(source,code.replace(needle,'else if ((globalThis.__fixturePacketValidations=Number(globalThis.__fixturePacketValidations||0)+1,validateHayakuPacket(parsedRaw)).ok !== true) return null;'));
  }
  const h=await createHayakuRuntime({messages,pluginStorage:store,pluginSourceFile:source,autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,
    arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('MODEL_PROHIBITED');}});
  return {h,store,dispose:async()=>{await h.dispose();if(root){assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('hayaku-owned-validation-'));fs.rmSync(root,{recursive:true,force:true});}}};
}
test('registered final consumer preserves rare-query eligible gold through existing output budgets',async()=>{
  const f=await runtime(corpus(Number(process.env.HAYAKU_FRONTIER_TURNS||100)));try{
    for(const fact of facts){const output=await f.h.callBeforeRequest([{role:'user',content:`What does ${fact[0]} contain?`}]);
      const d=f.h.hayaku.lastDebug(),candidates=d.lastViewerRecall?.rows||d.lastBeforeRequest?.viewerRecall?.rows||[];
      assert.ok(candidates.some(row=>String(row.state||row.publicText||'').includes(fact[2])),'gold must first exist in actual eligible candidates');
      assert.ok(context(output).includes(fact[2]),'actual final emitted evidence must retain the direct rare-query gold '+fact[2]);
    }
    assert.equal(f.h.llmCalls.length,0);assert.equal(f.h.fetchCalls.length,0);
  }finally{await f.dispose();}
});
test('registered recall performs exactly admission, canonical-load and final-authority ledger reads',async()=>{
  const f=await runtime();try{
    await f.h.callBeforeRequest([{role:'user',content:'What does Aurora vault contain?'}]);
    const scope=await f.h.hayaku._test.currentChatScope(),get=f.store.getItem,phases=[];
    f.store.getItem=async key=>{if(key==='hayaku.v2.ledger.'+scope.key){
      const oldLimit=Error.stackTraceLimit;Error.stackTraceLimit=40;const stack=new Error().stack;Error.stackTraceLimit=oldLimit;
      const matches=['captureHayakuReadset','loadStorageLedger','verifyHayakuReadset'].filter(name=>stack.includes('at async '+name+' '));
      assert.equal(matches.length,1,'each physical ledger read has one current contract owner');phases.push(matches[0]);
    }return get(key);};
    await f.h.callBeforeRequest([{role:'user',content:'What does Borealis shelf contain?'}]);
    assert.deepEqual(phases,['captureHayakuReadset','loadStorageLedger','verifyHayakuReadset'],'both fresh authority checks and the canonical load remain; no redundant consent-stage read');
    assert.equal(f.h.llmCalls.length,0);assert.equal(f.h.fetchCalls.length,0);
  }finally{await f.dispose();}
});
test('warm structural packet validation reuses only exact product-owned raw proofs and rejects same-length altered raw',async()=>{
  const f=await runtime(corpus(10),true);try{
    await f.h.callBeforeRequest([{role:'user',content:'What does Aurora vault contain?'}]);
    const before=Number(f.h.context.__fixturePacketValidations||0);
    await f.h.callBeforeRequest([{role:'user',content:'What does Borealis shelf contain?'}]);
    const warm=Number(f.h.context.__fixturePacketValidations||0)-before;
    assert.equal(warm,0,'unchanged authoritative raw packet proofs must avoid repeated whole packet shape validation');
    const scope=await f.h.hayaku._test.currentChatScope(),key='hayaku.v2.ledger.'+scope.key,body=JSON.parse(f.store.values.get(key));
    const original=body.records[0].raw;body.records[0].raw=original.replace('hayaku_packet_v1','broken_packet_v1');assert.equal(body.records[0].raw.length,original.length);
    await f.store.setItem(key,JSON.stringify(body));
    const ledger=await f.h.hayaku._test.loadStorageLedger(scope);
    assert.equal(ledger.records.some(record=>record.raw===body.records[0].raw),false,'same hash/length cannot reuse a prior validation proof for changed bytes');
    assert.ok(Number(f.h.context.__fixturePacketValidations||0)>before+warm);
    assert.equal(f.h.llmCalls.length,0);assert.equal(f.h.fetchCalls.length,0);
  }finally{await f.dispose();}
});
const temporalValues={hayaku_recall_short_max_age:'10',hayaku_recall_medium_max_age:'50',hayaku_recall_short_turn_quota:'1',hayaku_recall_medium_turn_quota:'1',hayaku_recall_long_turn_quota:'0'};
test('explicit saved temporal quotas reach the registered final consumer and survive restart; unset values stay unset',async()=>{
  const f=await runtime();let restarted;
  try{
    const unset=await f.h.hayaku.settingsControl.current();
    for(const key of Object.keys(temporalValues))assert.equal(unset[key],'','no temporal cutoff or quota default may be invented');
    const saved=await f.h.hayaku.settingsControl.apply(temporalValues);assert.equal(saved.ok,true);assert.equal(saved.readbackVerified,true);
    const output=await f.h.callBeforeRequest([{role:'user',content:'What does Borealis shelf contain?'}]);
    assert.equal(context(output).includes('BENCH_B0'),false,'explicit long-turn zero quota must reach final emitted evidence');
    const quota=f.h.hayaku.lastDebug().lastRecallDelivery.temporalQuota;
    assert.equal(quota.status,'active');assert.equal(quota.delivered.long,0);assert.ok(quota.delivered.short<=1&&quota.delivered.medium<=1);
    assert.equal(quota.contract.counting,'unique_source_turns_after_evidence_dedupe');assert.ok(quota.fingerprint);
    await f.h.dispose();
    restarted=await createHayakuRuntime({messages:corpus(100),pluginStorage:f.store,arguments:Object.fromEntries(f.h.argumentsMap),autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,llmResponder:async()=>{throw Error('MODEL_PROHIBITED');}});
    for(const [key,value] of Object.entries(temporalValues))assert.equal((await restarted.hayaku.settingsControl.current())[key],value);
    const again=await restarted.callBeforeRequest([{role:'user',content:'What does Borealis shelf contain?'}]);
    assert.equal(context(again).includes('BENCH_B0'),false);
    assert.equal(restarted.hayaku.lastDebug().lastRecallDelivery.temporalQuota.fingerprint,quota.fingerprint);
    assert.equal(restarted.llmCalls.length,0);assert.equal(restarted.fetchCalls.length,0);
  }finally{if(restarted)await restarted.dispose();await f.dispose();}
});
test('temporal policy rejects partial or reversed settings and reports bounded unmet quota without stale rank telemetry',async()=>{
  const f=await runtime(corpus(10));try{
    assert.equal((await f.h.hayaku.settingsControl.apply({hayaku_recall_short_max_age:'10'})).ok,false);
    assert.equal((await f.h.hayaku.settingsControl.apply({...temporalValues,hayaku_recall_medium_max_age:'5'})).ok,false);
    assert.equal((await f.h.hayaku.settingsControl.apply({...temporalValues,hayaku_recall_short_turn_quota:'3',hayaku_recall_medium_turn_quota:'3',hayaku_recall_long_turn_quota:'3'})).ok,true);
    await f.h.callBeforeRequest([{role:'user',content:'What does Cirrus case contain?'}]);
    const d=f.h.hayaku.lastDebug(),quota=d.lastRecallDelivery.temporalQuota,rank=d.localRecallRank;
    assert.ok(quota.delivered.short>0,'known eligible ordinary source turns must still be delivered under the explicit quota');
    assert.equal(quota.delivered.medium,0);assert.equal(quota.delivered.long,0);
    assert.equal(quota.shortage.medium,3);assert.equal(quota.shortage.long,3);assert.equal(quota.expansion,'existing_bounded_candidate_frontier');
    assert.ok(rank.invocation>0);assert.equal(rank.requestId,d.lastRecallSelection.requestId);assert.equal(rank.scopeKey,d.lastRecallSelection.scopeKey);
    const id=rank.invocation;await f.h.callBeforeRequest([{role:'user',content:'What does Aurora vault contain?'}]);
    assert.ok(f.h.hayaku.lastDebug().localRecallRank.invocation>id);
    assert.equal(f.h.llmCalls.length,0);assert.equal(f.h.fetchCalls.length,0);
  }finally{await f.dispose();}
});
