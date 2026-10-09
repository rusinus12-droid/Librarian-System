'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./libra_typed_recall_queue_test.cjs');

test('HME derived cache declares rebuildable search-time write class distinct from canonical/vector data',async()=>{
 const r=await runtime(null,{dist:process.env.LIBRA_RECALL_TEST_DIST});
 try{
  assert.equal(typeof r.api.MemoryEngine.getHmeDerivedStorageContract,'function');
  const c=r.api.MemoryEngine.getHmeDerivedStorageContract();
  assert.deepEqual(JSON.parse(JSON.stringify(c.storageContract)),{
   writeClass:'cache-derived',canonical:false,rebuildable:true,searchTimeWrite:'allowed-cold-build'
  });
  const typed=c.classifyKey(c.keyFor('typed-graph',r.snapshot.scopeKey));
  assert.equal(typed.writeClass,'cache-derived');assert.equal(typed.rebuildable,true);assert.equal(typed.canonical,false);
  assert.equal(c.classifyKey('libra:v1:typed-semantic:scope:row:abc'),null);
 }finally{r.clock.timers.clear();}
});
