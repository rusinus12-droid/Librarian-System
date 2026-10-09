'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{let groups=0;for(const variant of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js']){
 const source=fs.readFileSync(path.join(__dirname,'../sdk',variant),'utf8');
 for(const name of ['executeBackgroundJob','scopedExecuteBackgroundJob']){
  const match=[...source.matchAll(/state\.syncJob\.retryTimer = scheduleLifecycleTimeout\(\(\) => \{([\s\S]*?)\n\s*\}, delay\);/g)].find(m=>m[1].includes(name+'('));assert(match,'real retry callback exists');
  const callback=new Function('state',name,'reportStorageFailure',match[1]);const unhandled=[],reported=[];
  const current={jobId:'paused-job',status:'paused',phase:'waiting_for_server',retryCount:2,nextRetryAt:1234};
  const state={syncJob:{retryTimer:{},current}};const before=JSON.stringify(current);const failure=Object.assign(Error('HEALTH_BUSY'),{code:'HEALTH_BUSY'});const listener=e=>unhandled.push(e);
  process.on('unhandledRejection',listener);
  try{callback(state,async()=>{throw failure},(tag,error)=>reported.push({tag,error}));await new Promise(setImmediate);await new Promise(setImmediate);
   assert.equal(unhandled.length,0,'retry gate refusal must be observed');assert.equal(reported.length,1,'one bounded diagnostic is retained');assert.equal(reported[0].error,failure);assert.equal(state.syncJob.retryTimer,null);assert.equal(state.syncJob.current,current);assert.equal(JSON.stringify(current),before,'admission refusal must not overwrite durable paused state or invent a terminal success');groups++;
  }finally{process.removeListener('unhandledRejection',listener)}
 }
}console.log('PASS '+groups+' exact retry callbacks: refusal observed once, durable paused job and retry budget preserved')})().catch(e=>{console.error(e);process.exitCode=1});
