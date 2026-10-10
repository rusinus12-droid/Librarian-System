'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
const {createLibraVmHarness,instrument,hostData}=require('./fixtures/libra_consumer_test_support.cjs');
const C=vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteExecutionContract.source.js'),'utf8')+';MemorySuiteExecutionContract',{URL,TextEncoder,TextDecoder,setTimeout,clearTimeout});
const descriptor=(model,extra={})=>C.embeddingDescriptor({provider:'voyageai',model,dimensions:256,endpoint:'https://api.voyageai.com/v1/embeddings',...extra});
(async()=>{
 let count=0;
 assert.ok(C.verifiedSameSpace(descriptor('voyage-4'),descriptor('voyage-4-lite')));count++;
 for(const other of [descriptor('voyage-3'),descriptor('voyage-4-lite',{queryPrefix:'different'}),descriptor('voyage-4-lite',{endpoint:'https://proxy.invalid/v1/embeddings'}),{...descriptor('voyage-4-lite'),profileId:'forged'}]){assert.equal(C.verifiedSameSpace(descriptor('voyage-4'),other),null);count++;}
 const original={vector:[1,0],text:'immutable',model:'old'},after={...original,model:'new'};
 const map=new Map([['a',original],['b',original]]);let writes=0;
 await assert.rejects(()=>C.commitMetadataMigration([{key:'a',before:original,after},{key:'b',before:original,after}],{assertCurrent:async()=>{},read:async k=>map.get(k),write:async(k,v)=>{writes++;if(writes===2)throw Error('injected write rejection');map.set(k,v);}}));assert.deepEqual(map.get('a'),original);assert.deepEqual(map.get('b'),original);count++;
 const f=await createFlashback(path.resolve(__dirname,'..'),{transformSource:s=>s.replace('globalThis.__FlashbackEmbeddingAudit = {','globalThis.__FlashbackEmbeddingAudit = { saveScopeRecords, loadScopeRecordsRaw, flashbackEmbeddingDescriptor, embeddingProfileId,')});
 try{
   const a=f.audit,t=f.api._test;
   const old=t.normalizeSettings({embeddingEnabled:true,embeddingProvider:'voyageai',embeddingModel:'voyage-4',embeddingUrl:'https://api.voyageai.com/v1/embeddings',embeddingDimensions:256,embeddingNormalize:false});
   const next={...old,embeddingModel:'voyage-4-lite'};
   await f.api.saveSettings(old);const scope=await f.api.resolveCurrentScope(false);
   const vec=Array.from({length:256},(_,i)=>i===0?1:0);
   await a.saveScopeRecords(scope,[{id:'record1',scopeKey:scope.scopeKey,sourceType:'response',text:'영구 보존 원문',sourceHash:'source',sourceId:'source',vector:vec,dim:256,provider:'voyageai',model:'voyage-4',embeddingProfileId:a.embeddingProfileId(old,256),embeddingDescriptor:a.flashbackEmbeddingDescriptor(old,256),createdAt:'2026-09-08T00:00:00Z'}],old,scope);
   const before=await a.loadScopeRecordsRaw(scope);
   await f.api.saveSettings(next);
   const preview=await f.api.previewVerifiedEmbeddingMigration();assert.equal(preview.rows.length,1);
   const result=await f.api.applyVerifiedEmbeddingMigration(preview);assert.equal(result.migrated,1);assert.equal(result.providerCallCount,0);
   const readback=await a.loadScopeRecordsRaw(scope);assert.deepEqual(Array.from(readback.records[0].vector),Array.from(before.records[0].vector));assert.equal(readback.records[0].text,before.records[0].text);assert.equal(readback.records[0].originalEmbeddingProvenance.model,'voyage-4');count++;
   assert.equal((await f.api.previewVerifiedEmbeddingMigration()).rows.length,0);count++;
   await assert.rejects(()=>f.api.applyVerifiedEmbeddingMigration(preview),/MIGRATION_PREVIEW_STALE/);count++;
 }finally{await f.cleanup();}
 const data=hostData();
 const h=await createLibraVmHarness({enable_gui:'false'},data.host,{transformSource:s=>instrument(s).replace('const storage = Object.freeze({','const storage = globalThis.__remainingStorage = Object.freeze({').replace('const previewVerifiedEmbeddingMigration = async','const previewVerifiedEmbeddingMigration = globalThis.__remainingPreview = async').replace('const resolveContext = async','const resolveContext = globalThis.__remainingContext = async').replace('const loadEmbeddingSettings = async','const loadEmbeddingSettings = globalThis.__remainingConfig = async')});
 try{
   const scope=(await h.context.__remainingContext()).scope;
   await h.api.saveEmbeddingSettings({enabled:true,provider:'voyageai',model:'voyage-4',url:'https://api.voyageai.com/v1/embeddings',dimensions:256,normalizeVectors:false});
   const oldProfile=(await h.api.getEmbeddingAdapterDiagnostics()).profile;
   const vectorKey=`libra:v1:scope:${scope.scopeKey}:vector:metadata-test:r1:${oldProfile.profileId}`;
   const vector=Array.from({length:256},(_,i)=>i===0?1:0);
   const originalRecord={schema:'libra.embedding_projection.v2',scopeKey:scope.scopeKey,memoryId:'metadata-test',revision:1,provider:'voyageai',model:'voyage-4',dimensions:256,profileId:oldProfile.profileId,embeddingDescriptor:oldProfile.descriptor,vector,entries:{global:{vector,textHash:'immutable'}}};
   await h.context.__remainingStorage.setJson(vectorKey,originalRecord);
   const storedBefore=await h.context.__remainingStorage.getStoredJson(vectorKey);
   await h.api.saveEmbeddingSettings({model:'voyage-4-lite'});
   const preview=await h.api.previewVerifiedEmbeddingMigration();assert.equal(preview.rows.length,1);
   const result=await h.api.applyVerifiedEmbeddingMigration(preview);assert.equal(result.migrated,1);
   const storedAfter=await h.context.__remainingStorage.getStoredJson(vectorKey);
   for(const k of Object.keys(storedBefore).filter(k=>/vector|payload|entries/i.test(k)))assert.equal(JSON.stringify(storedAfter[k]),JSON.stringify(storedBefore[k]),k+' physically unchanged');
   assert.equal(storedAfter.originalEmbeddingProvenance.model,'voyage-4');count++;
   const journalKey=`libra:v1:scope:${scope.scopeKey}:embedding-metadata-migration:v1`;
   await h.context.__remainingStorage.setJson(journalKey,{schema:'libra.embedding_metadata_migration_journal.v1',scopeKey:scope.scopeKey,rows:preview.rows});
   await assert.rejects(()=>h.api.previewVerifiedEmbeddingMigration(),/MIGRATION_RECOVERY_REQUIRED/);count++;
   const recovered=await h.api.recoverVerifiedEmbeddingMigration();assert.equal(recovered.recovered,1);
   assert.equal(JSON.stringify(await h.context.__remainingStorage.getStoredJson(vectorKey)),JSON.stringify(storedBefore));assert.equal(await h.context.__remainingStorage.getStoredJson(journalKey),null);count++;
 }finally{await h.cleanup();}
 console.log(JSON.stringify({test:'remaining_embedding_migration_runtime',passed:count,externalModelCalls:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
