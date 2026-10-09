'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {test}=require('node:test');
const {createCostFixture}=require('./fixtures/flashback_append_cost_fixture.cjs');
test('ordinary finalized append publishes only changed raw shards while prior exact sources remain independently readable',async()=>{
 const x=await createCostFixture();
 try{
  const seed=await x.seed(128),tail=await x.append(129);
  const rawWrites=tail.events.filter(e=>e.op==='set'&&e.family==='rawShard');
  const actual=tail.loaded.records;
  for(const before of seed.records){const after=actual.find(r=>r.sourceHash===before.sourceHash);assert(after);assert.equal(after.text,before.text);assert.deepEqual(x.clone(after.vector),x.clone(before.vector));}
  assert.equal(actual.length,129);assert.equal(x.providerCalls(),0);
  const evidence={phase:'append_delta_contract',sourceSha256:x.hash(fs.readFileSync(path.resolve(__dirname,'../plugins/Flashback_Memory.js'))),
   sourceTurnsBefore:128,sourceTurnsAfter:129,shardSize:tail.loaded.manifest.shardSize,shardCount:tail.loaded.manifest.shardCount,rawShardWrites:rawWrites.length,
   io:tail.io,durationMs:tail.durationMs,expectedChangedRawShardWrites:1,actualProviderCalls:0,exactRetainedSourceCount:128};
  const out=process.env.FLASHBACK_COST_EVIDENCE;
  if(out){fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(evidence,null,2)+'\n','utf8');}
  console.log(JSON.stringify(evidence));
  assert.equal(rawWrites.length,1,'one newly appended shard must not rewrite all previously committed raw shards');
 }finally{await x.dispose();}
});

