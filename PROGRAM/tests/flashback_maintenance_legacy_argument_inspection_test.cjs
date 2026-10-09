'use strict';
const assert=require('node:assert/strict');const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{const f=await createFixture({chat:{message:[{role:'user',chatId:'u1',data:'What happened?'},{role:'assistant',chatId:'a1',data:'Alice kept the blue prism.'}]}});try{
 await f.api.saveSettings({...await f.api.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',embeddingEnabled:true,autoEpisodeIndex:false});await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});await new Promise(r=>setTimeout(r,50));
 let reads=0;const wrapper=f.api._test.wrapLegacyPluginApi({getArg(){reads++;throw Error('PRIVATE_LEGACY_SENTINEL')}});const old=[f.host.getArgument,f.host.getArg];f.host.getArgument=wrapper.getArgument;f.host.getArg=wrapper.getArg;
 try{assert.equal(await wrapper.getArg('ordinary'),undefined);await assert.rejects(f.api.inspectMemoryMaintenance(),e=>{assert.equal(e.code,'FLASHBACK_MAINTENANCE_INSPECTION_UNAVAILABLE');assert.equal(e.inspectionReason,'HEALTH_ARGUMENT_READ_UNAVAILABLE');assert(!JSON.stringify(e).includes('PRIVATE_LEGACY'));return true});assert(reads>1)}finally{[f.host.getArgument,f.host.getArg]=old}
 console.log(JSON.stringify({test:'flashback_maintenance_legacy_argument_inspection',passed:true,compatibilityAbsencePreserved:true}));
 }finally{await f.dispose()}})().catch(e=>{console.error(e);process.exitCode=1});
