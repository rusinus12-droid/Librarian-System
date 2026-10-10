'use strict';
const assert=require('node:assert/strict');const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
(async()=>{for(const v of variants){const f=await fixture(v);let attempted=false,attempt;const unsubscribe=f.bridge.subscribeSyncJob(job=>{if(job?.checkpoints?.A&&!attempted&&job.status==='running'){attempted=true;attempt=f.proxy.setItem(v[0]+'.A','DURING').then(()=>{throw Error('writer admitted during global job');},e=>assert.equal(e.code,'MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS'));}});
 try{const result=await f.bridge.setGlobalMode('server_only');await attempt;assert(attempted);assert.equal(result.failed.length,0);assert.equal(f.values.get(v[0]+'.A'),'A_SOURCE');await f.proxy.setItem(v[0]+'.A','AFTER');assert.equal(await f.proxy.getItem(v[0]+'.A'),'AFTER');console.log('PASS '+v[0]+' public transition writer boundary');}finally{unsubscribe();await f.close();}
}})().catch(e=>{console.error(e);process.exitCode=1;});
