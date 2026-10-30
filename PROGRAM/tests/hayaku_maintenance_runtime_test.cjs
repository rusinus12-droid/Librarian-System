'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const {plain,messages,envelope,coldResponder}=require('./fixtures/hayaku_maintenance_fixture.cjs');
async function fixture(options,fn){const r=await createHayakuRuntime({autoRepair:false,...options});try{return await fn(r);}finally{await r.dispose();}}
test('read-only inspection is pure and binding-only repair preserves source with zero model calls',()=>fixture({messages:messages()},async r=>{
 const scope=await r.hayaku._test.currentChatScope();
 r.pluginStorage.values.set('hayaku.v2.ledger.'+scope.key+':source-edit-consent:v1',JSON.stringify({schema:'memory-suite.source-edit-consent.v1',owner:'HAYAKU',scopeKey:scope.key,tasks:{}}));
 const before=plain([...r.pluginStorage.values]),source=plain(r.chat.message);
 const inspected=await r.hayaku.recovery.maintenance.inspect();assert.equal(inspected.known,true,JSON.stringify(inspected));assert.equal(inspected.needsBinding,true);
 assert.deepEqual(plain([...r.pluginStorage.values]),before);assert.equal(r.llmCalls.length,0);
 const result=await r.hayaku.recovery.maintenance.run();assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.physicalCalls,0);assert.equal(result.after.needsBinding,false);
 assert.deepEqual(plain(r.chat.message),source);const saved=plain([...r.pluginStorage.values]);
 assert.equal((await r.hayaku.recovery.maintenance.run()).ok,true);assert.deepEqual(plain([...r.pluginStorage.values]),saved,'a healthy rerun does not rewrite storage');
}));
test('one action routes only missing turns to native repair and verifies persisted coverage',()=>fixture({messages:messages([1,3])},async r=>{
 const source=plain(r.chat.message);let call=0;r.setLlmResponder(()=>({type:'success',result:JSON.stringify(envelope([1,3][call++]))}));
 const plans=[];const result=await r.hayaku.recovery.maintenance.run({confirmAnalysis:plan=>{plans.push(plain(plan));return true;}});
 assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(plans[0].targetTurns,[1,3]);assert.equal(plans[0].baseCalls,2);assert.equal(result.physicalCalls,2);
 assert.deepEqual(plain(result.after.coveredTurns),[1,2,3]);assert.equal(result.after.needsBinding,false);assert.deepEqual(plain(r.chat.message),source);
 assert.equal((await r.hayaku.recovery.maintenance.run({allowModel:true})).ok,true);assert.equal(r.llmCalls.length,2);
}));
test('empty history offers cold start, declined analysis calls no model, confirmed run reuses native engine',()=>fixture({messages:messages([1,2],2),llmResponder:coldResponder},async r=>{
 const source=plain(r.chat.message),declined=await r.hayaku.recovery.maintenance.run();assert.equal(declined.status,'needs_confirmation');assert.equal(declined.after.mode,'cold_start');assert.equal(r.llmCalls.length,0);
 const result=await r.hayaku.recovery.maintenance.run({allowModel:true});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.physicalCalls,2);
 assert.deepEqual(plain(result.after.coveredTurns),[1,2]);assert.deepEqual(plain(r.chat.message),source);
}));
test('changed source at confirmation blocks dispatch and concurrent starts are rejected',()=>fixture({messages:messages([1],1)},async r=>{
 let confirm;const pending=r.hayaku.recovery.maintenance.run({confirmAnalysis:()=>new Promise(resolve=>confirm=resolve)});
 await waitFor(()=>confirm,'maintenance confirmation');assert.equal((await r.hayaku.recovery.maintenance.run({allowModel:true})).status,'busy');
 assert.equal((await r.hayaku.recovery.repairNow()).reason,'maintenance_in_progress');assert.equal((await r.hayaku.recovery.coldStart()).reason,'maintenance_in_progress');
 r.chat.message[1].data='Alice postponed the task.';confirm(true);const result=await pending;
 assert.equal(result.ok,false);assert.equal(result.reason,'maintenance_plan_changed');assert.equal(r.llmCalls.length,0);
}));
test('unreadable/corrupt roots fail closed without erasing retained state or calling a model',()=>fixture({messages:messages([1],1)},async r=>{
 const scope=await r.hayaku._test.currentChatScope(),key='hayaku.v2.ledger.'+scope.key;
 await r.pluginStorage.setItem(key,'{broken');let before=plain([...r.pluginStorage.values]);
 let result=await r.hayaku.recovery.maintenance.run({allowModel:true});assert.equal(result.ok,false);assert.equal(result.reason,'maintenance_ledger_invalid');assert.deepEqual(plain([...r.pluginStorage.values]),before);
 await r.pluginStorage.removeItem(key);const get=r.pluginStorage.getItem;r.pluginStorage.getItem=async k=>{if(String(k).startsWith('hayaku.v2.recovery'))throw Error('fixture_read_failed');return get.call(r.pluginStorage,k);};
 result=await r.hayaku.recovery.maintenance.run({allowModel:true});assert.equal(result.ok,false,JSON.stringify(result));assert.equal(r.llmCalls.length,0);
}));
test('analysis failure remains incomplete and a cancelled in-flight result is not adopted',()=>fixture({messages:messages([1,3]),arguments:{hayaku_debug:'true'}},async r=>{
 let call=0;r.setLlmResponder(()=>({type:'success',result:++call===1?'not JSON':JSON.stringify(envelope(3))}));
 const source=plain(r.chat.message),result=await r.hayaku.recovery.maintenance.run({allowModel:true});
 assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.status,'partial');assert.deepEqual(plain(result.after.targetTurns),[1]);assert.equal(result.physicalCalls,2);assert.deepEqual(plain(r.chat.message),source);
 let release;r.setLlmResponder(()=>new Promise(resolve=>{release=()=>resolve({type:'success',result:JSON.stringify(envelope(1))});}));
 const pending=r.hayaku.recovery.maintenance.run({allowModel:true});await waitFor(()=>release,'model dispatch');assert.equal(r.hayaku.recovery.cancelJob(),true);release();
 const cancelled=await pending;assert.equal(cancelled.ok,false);assert.equal(cancelled.cancelled,true);assert.equal(cancelled.physicalCalls,1);assert.deepEqual(plain((await r.hayaku.recovery.maintenance.inspect()).targetTurns),[1]);
}));
test('broken slot heads are repaired even when the saved chat topology hash is unchanged',()=>fixture({messages:messages()},async r=>{
 assert.equal((await r.hayaku.recovery.maintenance.run()).ok,true);const scope=await r.hayaku._test.currentChatScope(),key='hayaku.v2.ledger.'+scope.key;
 const saved=JSON.parse(await r.pluginStorage.getItem(key)),hash=saved.chatTopologyHash,records=plain(saved.records);saved.slotHeads=[];await r.pluginStorage.setItem(key,JSON.stringify(saved));
 assert.equal((await r.hayaku.recovery.maintenance.inspect()).needsBinding,true);
 const result=await r.hayaku.recovery.maintenance.run();assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.physicalCalls,0);
 const after=JSON.parse(await r.pluginStorage.getItem(key));assert.equal(after.chatTopologyHash,hash);assert.equal(after.slotHeads.length,3);assert.deepEqual(plain(after.records.map(r=>r.raw)),records.map(r=>r.raw));
}));
test('user-suppressed turns and previously stored source edits are preserved without reanalysis',()=>fixture({messages:messages([],2)},async r=>{
 assert.equal((await r.hayaku.recovery.maintenance.run()).ok,true);const ledger=await r.hayaku.ledger.inspect({includeRecords:true}),record=ledger.records.find(row=>row.targetPairIndex===1);
 assert.equal((await r.hayaku.ledger.forget({recordId:record.recordId})).ok,true);
 r.chat.message[3].data=r.chat.message[3].data.replace('Alice completed workshop task 2.','Alice postponed workshop task 2.');const source=plain(r.chat.message);
 const result=await r.hayaku.recovery.maintenance.run({allowModel:true});assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(plain(result.after.userSuppressedTurns),[1]);
 assert.equal(result.physicalCalls,0);assert.deepEqual(plain(r.chat.message),source);
}));
test('active recovery lease blocks one-touch work before any model dispatch',()=>fixture({messages:messages([2],2)},async r=>{
 const t=r.hayaku._test;assert.equal((await t.scanCurrentChatForNativeRecoveryDebts({manualFullScan:true})).ok,true);
 const debt=(await t.inspectRecoveryDebtsForNativeRepair({targetPairIndex:2,limit:1})).debts[0];assert(debt);
 const lease=await t.acquireRecoveryDebtLeaseForNativeRepair({debtId:debt.debtId||debt.recordId,scopeKey:debt.scopeKey,runId:'maintenance-lease-contract'});assert.equal(lease.acquired,true,JSON.stringify(lease));
 const result=await r.hayaku.recovery.maintenance.run({allowModel:true});assert.equal(result.ok,false);assert.equal(result.reason,'recovery_lease_active');assert.equal(r.llmCalls.length,0);
}));
test('persona change after diagnosis invalidates the confirmed plan',()=>fixture({messages:messages([1],1)},async r=>{
 const result=await r.hayaku.recovery.maintenance.run({confirmAnalysis:()=>{r.chat.bindedPersona='another-persona';return true;}});
 assert.equal(result.ok,false);assert.equal(result.reason,'maintenance_plan_changed');assert.equal(r.llmCalls.length,0);
}));
test('unconfirmed physical binding write prevents subsequent analysis and preserves the old root',()=>fixture({messages:messages([2],2)},async r=>{
 const set=r.pluginStorage.setItem;let rejected=0;r.pluginStorage.setItem=async(key,value)=>{if(String(key).startsWith('hayaku.v2.ledger.')){rejected++;throw Error('fixture_write_rejected');}return set.call(r.pluginStorage,key,value);};
 const result=await r.hayaku.recovery.maintenance.run({allowModel:true});assert(rejected>0);assert.equal(result.ok,false,JSON.stringify(result));assert.equal(r.llmCalls.length,0);
}));
test('shared archive inspection rereads physical bodies and never certifies a stale hydrated cache',()=>fixture({messages:messages([],1)},async r=>{
 assert.equal((await r.hayaku.recovery.maintenance.run()).ok,true);const t=r.hayaku._test,scope=await t.currentChatScope(),key='hayaku.v2.ledger.'+scope.key;
 const ledger=await t.loadStorageLedger(scope),archive=await t.ensureHayakuSharedArchive(ledger,scope.key);assert(archive.archiveRef);
 const root=JSON.parse(await r.pluginStorage.getItem(key));root.archiveRef=plain(archive.archiveRef);await r.pluginStorage.setItem(key,JSON.stringify(root));
 assert.equal((await r.hayaku.recovery.maintenance.inspect()).known,true);
 await r.pluginStorage.setItem(archive.archiveRef.storageKey,'{broken');const before=plain([...r.pluginStorage.values]);
 const result=await r.hayaku.recovery.maintenance.run({allowModel:true});assert.equal(result.ok,false);assert.equal(result.before,null);assert.match(result.reason,/archive/);assert.equal(r.llmCalls.length,0);assert.deepEqual(plain([...r.pluginStorage.values]),before);
}));
