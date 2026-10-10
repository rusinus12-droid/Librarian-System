'use strict';
const assert=require('node:assert/strict'),path=require('node:path');const {test}=require('node:test');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM=path.resolve(__dirname,'..'),ARTIFACTS=process.env.FLASHBACK_PHYSICAL_ARTIFACTS;
for(const kind of ['Full','Min'])test(`physical repair uses ${kind} artifact public API without test exports`,{skip:!ARTIFACTS},async()=>{
 const seed=await createFlashback(PROGRAM);let artifact;try{
  const settings=seed.api._test.normalizeSettings({embeddingProvider:'openai_compat',embeddingModel:'artifact-physical',embeddingDimensions:3,embeddingUrl:'https://provider.invalid/v1',embeddingEnabled:true,embeddingAutoProcess:false,embeddingMaxRetries:0,embeddingBatchSize:1,autoEpisodeIndex:false,episodeIndexEnabled:false});
  await seed.api.saveSettings(settings);const scope=await seed.api.resolveCurrentScope(false),source={sourceType:'response',sourceId:'artifact-source',sourceHash:'artifact-source-hash',origin:'live_chat',role:'turn_pair',turnIndex:1,pairIndex:1,text:'User:\nWhere is it?\n\n---\n\nAssistant:\nThe amber compass is inside the old cedar cabinet.'};
  const records=await seed.api._test.buildRecordsFromSources([source],settings,scope,{deferEmbedding:true});await seed.api._test.saveAllRecords(records,settings,scope);await seed.api._test.retireExternalRecordsForScope(scope.scopeKey);
  await seed.cleanup();artifact=await createFlashback(path.resolve(ARTIFACTS,kind),{pluginStorage:seed.pluginStorage,safeLocalStorage:seed.safeLocalStorage,waitForLoaded:true});assert.equal(artifact.api._test,undefined);
  let writes=0,requests=0;const write=artifact.host.pluginStorage.setItem.bind(artifact.host.pluginStorage);artifact.host.pluginStorage.setItem=async(k,v)=>{writes++;return write(k,v)};
  artifact.host.nativeFetch=async(_u,init)=>{requests++;return {ok:true,status:200,async json(){return {data:JSON.parse(init.body).input.map((_,index)=>({index,embedding:[1,0,0]}))}}}};
  const ticket=await artifact.api.healthRecovery.previewPhysicalRepair();assert.equal(ticket.allowed,true,JSON.stringify(ticket));assert.equal(writes,0);assert.equal(requests,0);
  const result=await artifact.api.healthRecovery.repair(ticket);assert.equal(result.status,'verified',JSON.stringify(result));assert.equal(result.counts.completed,1);assert.equal(requests,2);assert.equal(result.publication.state,'verified');assert.equal(result.journal.state,'verified');
  assert.equal((await artifact.api.healthRecovery.repair(ticket)).status,'blocked');assert.equal((await artifact.api.healthRecovery.previewPhysicalRepair()).allowed,false);assert.equal(requests,2);
 }finally{await artifact?.cleanup();await seed.cleanup()}
});
