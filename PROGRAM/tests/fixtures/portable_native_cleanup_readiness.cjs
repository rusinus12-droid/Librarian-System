'use strict';
const assert=require('node:assert/strict');
const {waitFor}=require('./libra_vm_harness.cjs');
const {releaseVersion}=require('./release_versions.cjs');
const markerKey='libra:v1:migration:remove-world-additional:v1';
function observeNativeCleanup(source){
 const call='LibraMemoryCore.purgeLegacyWorldAdditionalData()';
 assert.equal(source.split(call).length,2,'one actual native startup cleanup call');
 // Assignment captures the original promise; the real timer, callback, cleanup
 // implementation and fail-soft handler still run without replacement.
 return source.replace(call,`(globalThis.__portableStartupCleanupTask = ${call})`);
}
async function settleNativeCleanup(f){
 let deadline;
 try{
  await Promise.race([(async()=>{
   await waitFor(()=>f.r.context.__portableStartupCleanupTask,8000);
   const result=await f.r.context.__portableStartupCleanupTask;
   const {startedAt,finishedAt,...body}=JSON.parse(JSON.stringify(result));
   assert.deepEqual(body,{schema:'libra.world_additional_removal.v1',version:releaseVersion('libra'),removedCandidateRecords:0,cleanedManifests:0,errors:[],done:true,ok:true},'the genuine startup cleanup completed without removing fixture data');
   assert(Number.isFinite(Date.parse(startedAt)));assert(Number.isFinite(Date.parse(finishedAt)));
   const raw=await f.r.context.risuai.pluginStorage.getItem(markerKey);
   assert.equal(typeof raw,'string','cleanup completion was physically written');
   assert.deepEqual(JSON.parse(raw),JSON.parse(JSON.stringify(result)),'the actual cleanup promise matches its durable marker');
  })(),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('native startup cleanup did not settle within 8 seconds')),8000);})]);
 }finally{clearTimeout(deadline);}
}
module.exports={observeNativeCleanup,settleNativeCleanup};
