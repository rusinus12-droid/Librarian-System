'use strict';
const assert=require('node:assert/strict');const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{const f=await createFixture({chat:{message:[{role:'user',chatId:'u1',data:'Where is Alice?'},{role:'assistant',chatId:'a1',data:'Alice is in the hall.'}]}});let release;try{
 await f.api.saveSettings({...await f.api.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',embeddingEnabled:true,autoEpisodeIndex:false});await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});await new Promise(r=>setTimeout(r,50));
 let entered,blocked=false;const start=new Promise(r=>entered=r),gate=new Promise(r=>release=r),original=f.pluginStorage.setItem.bind(f.pluginStorage);f.pluginStorage.setItem=async(k,v)=>{if(!blocked&&k.endsWith(':maintenance_journal:v1')){blocked=true;entered();await gate}return original(k,v)};
 const abort=new AbortController(),physical=f.api.runMemoryMaintenance('sync',{signal:abort.signal}).then(v=>({result:v}),error=>({error}));await start;
 assert.equal((await f.api.healthRecovery.preview()).allowed,false);const explicit=await f.api.previewSourceEdits(['1']);assert.equal(explicit.allowed,false);assert.equal(explicit.reason,'owner_busy');abort.abort();release();await physical;f.pluginStorage.setItem=original;
 const ticket=await f.api.healthRecovery.preview();assert.equal(ticket.allowed,true,JSON.stringify(ticket));const cache=f.api.healthRecovery.repair(ticket);await assert.rejects(f.api.runMemoryMaintenance('sync'),e=>e.code==='FLASHBACK_REPAIR_ACTION_BUSY');await cache;
 console.log(JSON.stringify({test:'flashback_repair_mutual_exclusion_runtime',passed:true,physicalBlocksCacheAndExplicit:true,sharedActionBlocksPhysicalBeforeFirstAwait:true}));
 }finally{release?.();await f.dispose()}})().catch(e=>{console.error(e);process.exitCode=1});
