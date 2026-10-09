'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),F=require('../../tests/helpers/wm-fixture.cjs'),{fixture}=require('./wm-handoff-fixture.cjs');
test('wm_handoff_rollback_preserves_newer_target',async t=>{
  const f=await fixture(t),p=await f.prepare('c1-newer'),receipt=await f.adopt(p);assert.equal(receipt.usable,true,JSON.stringify(receipt));
  const input=F.storeWrite(receipt.targetHead,{operationId:'newer-target-write',generationId:'newer-target-generation',raw:JSON.stringify({version:1,scopeKey:f.target.scope,entries:[],resetGeneration:0}),writerEpoch:f.service.status().dataset.writerEpoch});const newer=f.service.publish(f.service.prepare(input)).receipt.head;
  const result=await f.adapter.rollbackHandoff({transferId:p.transferId,expectedTargetHead:receipt.targetHead});assert.equal(result.status,'conflict',JSON.stringify(result));assert.equal(result.receipt.reason,'recovery_required');const opened=f.service.acquire(f.target.scope);try{assert.deepEqual(opened.head,newer);assert.equal(f.service.readGeneration(opened.lease),input.raw);}finally{f.service.release(opened.lease);}
});
test('wm_handoff_abort_retains_source_and_only_unpublished_stage',async t=>{
  const f=await fixture(t),before=f.sourceObservation(),p=await f.prepare('c1-abort');assert.ok(p.payloadDigest);const result=await f.adapter.abortPreparedHandoff({transferId:p.transferId});assert.equal(result.ok,true);assert.deepEqual(f.sourceObservation(),before);assert.equal(F.sqliteRead(f.db,'SELECT count(*) n FROM heads WHERE scope=?',f.target.scope)[0].n,0);
});
test('wm_handoff_conditional_rollback_creates_genuine_lifecycle_head',async t=>{
  const f=await fixture(t),before=f.sourceObservation(),p=await f.prepare('c1-rollback'),receipt=await f.adopt(p);assert.equal(receipt.usable,true,JSON.stringify(receipt));
  const result=await f.adapter.rollbackHandoff({transferId:p.transferId,expectedTargetHead:receipt.targetHead});assert.equal(result.status,'committed',JSON.stringify(result));assert.equal(result.receipt.head.tombstone,true);assert.notEqual(result.receipt.head.epoch,receipt.targetHead.epoch);assert.deepEqual(f.sourceObservation(),before);
  const heads=F.sqliteRead(f.db,'SELECT head_json FROM heads WHERE scope=?',f.target.scope);assert.deepEqual(JSON.parse(heads[0].head_json),result.receipt.head);assert.equal(F.sqliteRead(f.db,'SELECT count(*) n FROM generations WHERE scope=?',f.target.scope)[0].n,3);assert.equal((await f.adapter.verifyHandoff({transferId:p.transferId,targetIdentity:f.target,payloadDigest:p.payloadDigest})).receipt.usable,false);
});
