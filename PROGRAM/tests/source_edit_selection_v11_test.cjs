'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
for(const choice of ['empty','foreign_scope','unknown_range','stale_identity','selected'])test('LIBRA public canonical selection '+choice,async()=>{const f=await fixture();try{
 assert.equal((await f.run()).completed,1);const old=f.getManifest().memories['1'],bytes=f.r.values.get(old.key),calls=f.control.calls.length;
 const inventory=await f.r.api.listCanonicalBatchRanges();assert.equal(f.control.calls.length,calls);assert.equal(inventory.ranges.length,1);assert.equal(inventory.ranges[0].startTurn,1);assert.equal(inventory.ranges[0].endTurn,5);
 let selection={scopeKey:inventory.scopeKey,mode:'source_edit',ranges:inventory.ranges};
 if(choice==='empty')selection.ranges=[];if(choice==='foreign_scope')selection.scopeKey='foreign';if(choice==='unknown_range')selection.ranges=[{...inventory.ranges[0],startTurn:99}];if(choice==='stale_identity')selection.ranges=[{...inventory.ranges[0],identityDigest:'stale'}];
 if(choice==='selected')f.chat.message[0].data+=' Current selected source.';
 let result;try{result=await f.r.api.startSelectedCanonicalBatches(selection)}catch(error){result={ok:false,reason:error.message}}
 assert.equal(result.ok,choice==='selected',JSON.stringify(result));assert.equal(f.r.values.get(old.key),bytes);
 if(choice==='selected'){assert.equal(f.control.calls.length,calls+1);assert.equal(result.job.completed,1);assert.ok(f.getManifest().memories['1'].revision>old.revision)}else assert.equal(f.control.calls.length,calls);
}finally{await f.r.cleanup()}});
