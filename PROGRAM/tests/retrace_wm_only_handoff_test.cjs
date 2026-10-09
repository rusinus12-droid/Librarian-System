'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('../wm/tools/wm-handoff-fixture.cjs'),{connect}=require('./helpers/retrace-wm-fixture.cjs');
test('actual RETRACE WM-only action persists pending before fence and independently verifies materialized receipt',async t=>{
 const f=await fixture(t),v=await connect(t,f),before=f.sourceObservation();
 const result=await v.api.continueToNextSession(v.into({includeWm:true}));
 assert.equal(result.ok,true);assert.equal(result.requiredOwnerCount,1);assert.equal(result.wmRequired,true);assert.equal(result.wmVerified,true);assert.deepEqual(f.sourceObservation(),before);
 assert.equal(result.handoffJournalState,'completed');assert.equal(v.messages.filter(x=>x.action==='adoptHandoff').length,1);
 const firstSave=v.events.findIndex(x=>x.kind==='host-save'),prepare=v.events.findIndex(x=>x.kind==='prepareHandoff'),targetActivate=v.events.findIndex(x=>x.kind==='host-save'&&x.active===result.targetChatId);
 assert(firstSave<prepare&&prepare<targetActivate);assert.equal(v.events[firstSave].active,'source');assert.equal(v.events[firstSave].pending,true);
 assert.equal(v.messages.find(x=>x.action==='adoptHandoff').payload.pendingToken,null);
 assert.equal(v.sandbox.character.chats[1].message[0].data,'source untouched');
 assert.equal(v.sandbox.character.chats[0].memorySessionBridge.handoffJournal.wmHandoff.transferId,result.transferId);
});
test('required WM domain readback failure remains incomplete with same journal target and transfer',async t=>{
 const f=await fixture(t),v=await connect(t,f,{readbackIncomplete:true});const result=await v.api.continueToNextSession(v.into({includeWm:true}));
 assert.equal(result.ok,false);assert.equal(result.wmVerified,false);assert.equal(result.handoffJournalState,'pending_owner_handoffs');
 const next=await v.api.resumeNextSessionHandoff(v.into({targetChatId:result.targetChatId,transferId:result.transferId}));assert.equal(next.ok,false);
 assert.equal(v.sandbox.character.chats.length,2);assert(v.messages.filter(x=>x.transferId).every(x=>x.transferId===result.transferId));
});
