'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('../wm/tools/wm-handoff-fixture.cjs'),{createVm,connect,W,source,sdk}=require('./helpers/retrace-wm-fixture.cjs');
test('WM selection freezes separately and absence/unselected keeps core owner policy',()=>{
 const v=createVm(),rows=[{owner:'libra',installed:true,connected:true,supported:true,mode:'plugin_only'},{owner:'lia',installed:false},{owner:'wm',installed:false,connected:false,supported:false,selected:false}];
 const legacy=v.api.memorySuiteOwnerStorageGateFromRows(v.into(rows));assert.equal(legacy.ready,true);assert.equal(legacy.participantCount,1);
 rows[2].selected=true;const selected=v.api.memorySuiteOwnerStorageGateFromRows(v.into(rows));assert.equal(selected.ready,false);
 rows[2]={owner:'wm',installed:true,connected:true,supported:true,selected:true,mode:'server_only'};
 const mixed=v.api.memorySuiteOwnerStorageGateFromRows(v.into(rows),v.into({wm:{verified:true}}));assert.equal(mixed.ready,true);assert.equal(mixed.commonMode,'per_owner');
 const policy=v.api.handoffStoragePolicyFromGate(mixed,1);assert.deepEqual(JSON.parse(JSON.stringify(policy.participants)),[{owner:'libra',mode:'plugin_only'},{owner:'wm',mode:'server_only'}]);
 const wmOnly=v.api.memorySuiteOwnerStorageGateFromRows(v.into([rows[2]]),v.into({wm:{verified:true}}));assert.equal(wmOnly.ready,true);assert.equal(wmOnly.participantCount,1);
 assert.equal(v.api.requiredHandoffsVerified(v.into({wmRequired:true,wmVerified:false})),false);
 assert(source.includes(sdk.trimEnd()),'RETRACE has exact SDK embed');
});
test('completed journal retains frozen WM identity/global mode/digest and rejects participant replacement',async t=>{
 const f=await fixture(t),v=await connect(t,f);const result=await v.api.continueToNextSession(v.into({includeWm:true}));
 const journal=v.sandbox.character.chats[0].memorySessionBridge.handoffJournal;
 const drift=JSON.parse(JSON.stringify(journal.wmHandoff));drift.mode='plugin_only';
 await assert.rejects(v.api.persistNextSessionHandoffJournal(result.targetChatId,result.transferId,v.into({wmHandoff:drift})),/wm_handoff_binding_immutable/);
 await assert.rejects(v.api.persistNextSessionHandoffJournal(result.targetChatId,result.transferId,v.into({storagePolicy:{participants:[]}})),/handoff_owner_policy_immutable/);
 assert.equal(W.same(JSON.parse(JSON.stringify(journal.wmHandoff.sourceRoute)),f.route),true);
});
test('one ordinary-persona core3 mixed-mode flow retains WM global route and existing target owner preparation',async t=>{
 const f=await fixture(t),v=await connect(t,f),modes={flashback:'plugin_only',hayaku:'server_only',libra:'plugin_only'},prepared=[];
 for(const [owner,name] of Object.entries({flashback:'requestFlashbackIpc',hayaku:'requestHayakuIpc',libra:'requestLibraIpc'}))v.sandbox[name]=async(action,payload)=>{
  if(action==='memory_suite_storage_status')return v.into({mode:modes[owner],status:{state:'ready'}});
  assert.equal(action,'memory_suite_prepare_handoff_target');prepared.push(owner);
  return v.into({schema:'memory-suite.target-storage-preparation.v1',owner,targetChatId:payload.targetChatId,transferId:payload.transferId,mode:modes[owner],verified:true});
 };
 const result=await v.api.continueToNextSession(v.into({includeWm:true}));assert.equal(result.ok,true);assert.equal(result.storagePolicy.participantCount,4);assert.equal(result.storageDestination,'per_owner');
 assert.deepEqual(prepared,['flashback','hayaku','libra']);assert.equal(W.same(f.sourceObservation().head,f.sourceHead),true);assert.equal(W.same(JSON.parse(JSON.stringify(result.wmVerification.receipt.sourceRoute)),f.route),true);
});
