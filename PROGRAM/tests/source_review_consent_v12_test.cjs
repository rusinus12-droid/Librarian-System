'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
test('explicit current source selection needs no invented previous raw or consent journal',async()=>{const f=await fixture();try{
 const raw=JSON.stringify(f.chat.message),inventory=await f.r.api.listCanonicalBatchRanges();assert.equal(inventory.ranges[0].status,'missing');assert.equal(f.control.calls.length,0);
 const result=await f.r.api.startSelectedCanonicalBatches({scopeKey:inventory.scopeKey,mode:'source_edit',ranges:inventory.ranges});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.job.completed,1);assert.equal(f.control.calls.length,1);assert.equal(f.getManifest().memories['1'].status,'committed');assert.equal(JSON.stringify(f.chat.message),raw);assert.equal([...f.r.values.keys()].some(k=>k.includes(':source-edit-consent:v1')),false);
}finally{await f.r.cleanup()}});
test('failed explicit provider replacement reports failure and preserves prior canonical and Head',async()=>{const f=await fixture();try{
 assert.equal((await f.run()).completed,1);const old=f.getManifest().memories['1'],bytes=f.r.values.get(old.key),head=JSON.stringify(f.getHead()),calls=f.control.calls.length;f.chat.message[0].data+=' Current source revision.';f.control.modelFails=true;
 const inventory=await f.r.api.listCanonicalBatchRanges();const result=await f.r.api.startSelectedCanonicalBatches({scopeKey:inventory.scopeKey,mode:'source_edit',ranges:inventory.ranges});assert.equal(result.ok,false);assert.ok(result.reason);assert.ok(result.job.failed>0);assert.equal(f.control.calls.length,calls+1);assert.equal(f.r.values.get(old.key),bytes);assert.equal(f.getManifest().memories['1'].key,old.key);assert.equal(JSON.stringify(f.getHead()),head);
}finally{await f.r.cleanup()}});
