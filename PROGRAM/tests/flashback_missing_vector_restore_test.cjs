'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const hash=value=>{let h=0x811c9dc5;for(let i=0;i<value.length;i++)h=Math.imul(h^value.charCodeAt(i),0x01000193);return (h>>>0).toString(36);};
(async()=>{
 const f=await createFixture();
 try {
  const scope={scopeKey:'char:restore-fixture|chat:fixture'},prefix=`vector_rag_memory:scope:${hash(scope.scopeKey)}:`;
  const vectorKey=`vector_rag_memory:local-vector-shard:v1:${hash(scope.scopeKey)}:retired:0000`;
  const records=[true,false].map((vectorPayloadMissing,i)=>({schema:'vector_rag_memory.record.v2',id:'synthetic-'+i,hash:'synthetic-'+i,scopeKey:scope.scopeKey,sourceType:'response',text:'durable synthetic text',vector:[],dim:4,vectorPayloadMissing,
   vectorRef:{schema:'flashback_memory.local_vector_ref.v1',storage:'local',storageKey:vectorKey,recordId:'synthetic-'+i,offset:4*i,length:4,digest:'fixture',mode:'local_float32_shard_v1'}}));
  const manifest={schema:'vector_rag_memory.scope_manifest.v2',version:2,...scope,storageHash:hash(scope.scopeKey),count:2,shardCount:1,shardSummaries:[{shardIndex:0,recordCount:2}],commitId:'live',vectorSidecarCount:0,stats:f.api._test.statsForRecords(records)};
  const entries=[[prefix+'manifest:v2',JSON.stringify(manifest)],[prefix+'records:commit:live:shard:0000',JSON.stringify({version:2,...scope,shard:0,commitId:'live',records})]];
  const base=new Map(entries),before=JSON.stringify(entries);
  const validate=(map=base,extra=[],readLocal=async()=>null)=>f.api.validatePluginStorageRestore({phase:'complete',scope,serverCandidates:[...[...map.keys()].map(logicalKey=>({space:'plugin',logicalKey})),...extra],readback:async(space,key)=>space==='plugin'?map.get(key)??null:readLocal(key)});
  const restored=await validate();assert.equal(restored.ok,true,JSON.stringify(restored.errors));
  assert.equal(restored.metrics.missingVectorPayloads,2);assert.equal(restored.warnings[0].code,'flashback_restore_vector_payload_absent');
  assert.equal(restored.warnings[0].records,2);assert.equal(restored.warnings[0].key,vectorKey);
  assert.equal(JSON.stringify([...base]),before,'validation preserves source bytes and pending flags');
  const omitted=await validate(base,[{space:'local',logicalKey:vectorKey}]);
  assert.equal(omitted.ok,false,'an inventoried source sidecar missing from destination still blocks');
  for(const raw of ['not-json',JSON.stringify({schema:'flashback_memory.local_vector_shard.v1',data:'AAAAAA=='})]){
   const corrupt=await validate(base,[],async()=>raw);assert.equal(corrupt.ok,false,'present corrupt bytes stay fatal');
  }
  const unreadable=await validate(base,[],async()=>{throw Error('fixture read failed');});assert.equal(unreadable.ok,false,'a read error is not proof of absence');
  const foreign=new Map(base);foreign.set(entries[1][0],JSON.stringify({version:2,...scope,shard:0,commitId:'live',records:records.map(r=>({...r,vectorRef:{...r.vectorRef,storageKey:'unrelated-owner:key'}}))}));
  assert.equal((await validate(foreign)).ok,false,'the absence exception is limited to Flashback vector payload keys');
  const declared=new Map(base),currentKey=`vector_rag_memory:local-vector-shard:v1:${hash(scope.scopeKey)}:live:0000`;
  declared.set(entries[0][0],JSON.stringify({...manifest,vectorSidecarCount:1}));
  assert.equal((await validate(declared)).ok,false,'a declared sidecar is mandatory even when no record points to it');
  declared.set(entries[1][0],JSON.stringify({version:2,...scope,shard:0,commitId:'live',records:records.map(r=>({...r,vectorRef:{...r.vectorRef,storageKey:currentKey}}))}));
  assert.equal((await validate(declared)).ok,false,'a declared current-commit sidecar remains mandatory');
  const payload=f.api._test.buildFlashbackVectorShardPayload(scope.scopeKey,'live',0,records.map(r=>({...r,vector:[1,0,0,0]})));
  const intact=new Map(declared);intact.set(entries[1][0],JSON.stringify({version:2,...scope,shard:0,commitId:'live',records:records.map(r=>({...r,vectorRef:{...r.vectorRef,storageKey:currentKey,digest:payload.digest}}))}));
  const valid=await validate(intact,[{space:'local',logicalKey:currentKey}],async()=>JSON.stringify(payload));
  assert.equal(valid.ok,true,JSON.stringify(valid.errors));assert.equal(valid.warnings.length,0);assert.equal(valid.metrics.missingVectorPayloads,0);
  const corruptText=new Map(base);corruptText.set(entries[1][0],JSON.stringify({version:2,...scope,shard:0,commitId:'live',records,checksum:'wrong'}));
  assert.equal((await validate(corruptText)).ok,false,'missing-vector permission does not bypass source checksums');
  const strict=await f.api._test.inspectFlashbackVectorPayloadMetadata(records,{scopeKey:scope.scopeKey,readItem:async()=>null});
  assert.equal(strict.verified,false,'writer and maintenance audits retain strict vector integrity');
  // Synthetic equivalent of the supplied archive: 64 pending records referring
  // to two absent payloads, with the immutable member catalog still intact.
  const archiveId='fb_restore_fixture',archiveScope='flashback_archive_v1:'+archiveId,archivePrefix=`vector_rag_memory:scope:${hash(archiveScope)}:`;
  const archived=Array.from({length:64},(_,i)=>({...records[0],id:'archive-'+i,permanentHistoryId:'archive-'+i,dim:1024,vectorRef:{...records[0].vectorRef,
   storageKey:`vector_rag_memory:local-vector-shard:v1:${hash(scope.scopeKey)}:retired:${i<34?'0000':'0001'}`,recordId:'archive-'+i,offset:(i<34?i:i-34)*1024,length:1024}}));
  const ids=archived.map(r=>f.api._test.flashbackArchiveRecordIdentity(r)).sort(),digest=hash(ids.join('\u0001'));
  const archiveRef={schema:'flashback_memory.archive_ref.v1',archiveId,archiveScopeKey:archiveScope,generation:1,depth:1,deltaCount:64,recordCount:64,digest,parentRef:null};
  const archiveManifest={...manifest,scopeKey:archiveScope,storageHash:hash(archiveScope),count:64,shardSummaries:[{shardIndex:0,recordCount:64}],commitId:'archive',
   stats:f.api._test.statsForRecords(archived),archiveOwner:true,archiveId,archiveGeneration:1,archiveRecordCount:64,archiveDigest:digest,
   archiveMemberCatalogVersion:1,archiveDeltaCount:64,archiveDeltaMemberIds:ids,archiveDeltaDigest:digest,parentArchiveRef:null};
  const archiveMap=new Map([[entries[0][0],JSON.stringify({...manifest,count:0,shardCount:0,shardSummaries:[],stats:f.api._test.statsForRecords([]),archiveRef})],
   [archivePrefix+'manifest:v2',JSON.stringify(archiveManifest)],[archivePrefix+'records:commit:archive:shard:0000',JSON.stringify({version:2,scopeKey:archiveScope,commitId:'archive',shard:0,records:archived})]]);
  const archiveBefore=JSON.stringify([...archiveMap]),archiveResult=await validate(archiveMap);
  assert.equal(archiveResult.ok,true,JSON.stringify(archiveResult.errors));assert.equal(archiveResult.metrics.archiveRecords,64);
  assert.equal(archiveResult.metrics.missingVectorPayloads,64);assert.equal(archiveResult.warnings.length,2);
  assert.deepEqual(Array.from(archiveResult.warnings,w=>w.records).sort((a,b)=>a-b),[30,34]);
  assert.equal(JSON.stringify([...archiveMap]),archiveBefore,'archive membership and pending source bytes are preserved');
  const brokenArchive=new Map(archiveMap);brokenArchive.set(archivePrefix+'manifest:v2',JSON.stringify({...archiveManifest,archiveDeltaDigest:'wrong'}));
  assert.equal((await validate(brokenArchive)).ok,false,'missing-vector permission does not bypass archive membership integrity');
  console.log('Flashback missing vector restore: PASS (absent warning, byte preservation, omitted/corrupt/unreadable/declared payload rejection, strict writer audit)');
 }finally{await f.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
