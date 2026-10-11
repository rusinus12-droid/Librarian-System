'use strict';
const assert=require('node:assert/strict');
const {generated,fixture,query,system}=require('./libra_q04_thread_fixture.cjs');
async function verifyClosureReadset(){
 const built=await generated();let snapshot,ref;
 try{snapshot={chat:built.clone(built.chat),values:[...built.r.values.entries()]};ref=built.getManifest().memories['6'];}finally{await built.r.cleanup();}
 let armed=false,hit=false,f;
 const seam="        assertConsumedDataIdentity(evidencePacket.consumed_data_token, 'packet', consumedPacketIdentityDigest(evidencePacket));";
 f=await fixture({snapshot,transformSource:source=>{assert.equal(source.split(seam).length,2);return source.replace(seam,"        await globalThis.risuai.closurePhysicalMutation();\n"+seam);},host:{closurePhysicalMutation:async()=>{if(!armed)return;armed=false;hit=true;const body=JSON.parse(f.r.values.get(ref.key));body.sourceDigest='changed-only-after-final-boundary';f.r.values.set(ref.key,JSON.stringify(body));}}});
 try{
  const positive=system(await f.control.hooks.beforeRequest(query,'model'));
  const d=f.r.api.getLastMemoryRecallViewer();
  assert.equal(d.selectedMemories,1,'successor is closure-only, not a selected recall row');
  assert.equal(d.closureInjectedFacts,1,'real accepted successor reaches Classic positive');
  assert.ok(positive.includes(ref.memoryId));
  armed=true;const calls=f.control.calls.length;
  const stale=system(await f.control.hooks.beforeRequest(query,'model'));
  assert.equal(hit,true,'physical successor mutation reached final admission');
  assert.ok(!stale.includes('[LIBRA CLASSIC RECALL'),'closure-only physical mutation suppresses stale delivery');
  assert.equal(f.control.calls.length,calls);
  return {closureOnlySelectedMemories:1,positiveClosureFacts:1,latePhysicalMutationSuppressed:true};
 }finally{await f.r.cleanup();}
}
module.exports={verifyClosureReadset};
if(require.main===module)verifyClosureReadset().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
