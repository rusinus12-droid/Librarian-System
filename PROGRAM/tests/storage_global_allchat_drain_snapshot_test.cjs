'use strict';
const assert=require('node:assert/strict');const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
(async()=>{for(const v of variants){const f=await fixture(v);let changed=false;const stop=f.bridge.subscribeSyncJob(job=>{if(job?.phase==='prepared'&&!changed){changed=true;f.values.set(v[0]+'.A','OUTSIDE_WRITER_CHANGED');}});try{
 await assert.rejects(()=>f.bridge.setGlobalMode('server_only'),e=>['MEMORY_SUITE_GLOBAL_SOURCE_CHANGED','MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED'].includes(e.code));assert(changed);const rows=f.app.repositories[v[0]].database.prepare('SELECT key FROM kv WHERE deleted=0').all();assert(!rows.some(row=>row.key===v[0]+'.A'),'fresh post-prepare source check precedes first payload copy');console.log('PASS '+v[0]+' post-prepare source snapshot');
 }finally{stop();await f.close();}}})().catch(e=>{console.error(e);process.exitCode=1;});
