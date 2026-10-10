'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM=process.env.FLASHBACK_JOURNAL_PROGRAM||path.resolve(__dirname,'..');
(async()=>{const h=await createFlashback(PROGRAM);try{
 const cfg=h.api._test.normalizeSettings({embeddingProvider:'openai_compat',embeddingModel:'journal-fixed',embeddingDimensions:3,embeddingUrl:'https://provider.invalid/v1',embeddingEnabled:true,embeddingAutoProcess:false,embeddingMaxRetries:0,autoEpisodeIndex:false,episodeIndexEnabled:false});await h.api.saveSettings(cfg);const scope=await h.api.resolveCurrentScope(false);
 const records=await h.api._test.buildRecordsFromSources([{sourceType:'response',sourceId:'journal-source',sourceHash:'journal-source-hash',origin:'live_chat',role:'turn_pair',turnIndex:1,pairIndex:1,text:'User:\nWhere is it?\n\n---\n\nAssistant:\nThe amber compass rests in the cedar cabinet.'}],cfg,scope,{deferEmbedding:true});await h.api._test.saveAllRecords(records,cfg,scope);await h.api._test.retireExternalRecordsForScope(scope.scopeKey);
 const key='__memory_suite_internal_scope_routes_v1__:flashback',route=JSON.parse(h.pluginStorage.values.get(key));route.entries['other-server-chat']={scopeId:'other-server-chat',scopeKey:'other-server-chat',mode:'server_only',origin:'user_explicit',updatedAt:Date.now()+1000};for(const s of [h.pluginStorage,h.safeLocalStorage])s.values.set(key,JSON.stringify(route));
 let writes=0,calls=0;for(const s of [h.pluginStorage,h.safeLocalStorage])s.setItem=s.removeItem=async()=>{writes++;throw Error('forbidden mutation')};h.host.nativeFetch=async()=>{calls++;throw Error('no provider or server')};
 const preview=await h.api.healthRecovery.previewPhysicalRepair();console.log(JSON.stringify({test:'physical_current_local_shared_route',program:PROGRAM,allowed:preview.allowed,writes,calls}));assert.equal(preview.allowed,true,'current-local shortcut preserves local journal authority despite an unrelated server scope');assert.equal(writes,0);assert.equal(calls,0);
 }finally{await h.cleanup()}
})().catch(error=>{console.error(error);process.exitCode=1});
