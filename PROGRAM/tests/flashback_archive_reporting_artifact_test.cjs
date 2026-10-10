'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {test}=require('node:test');
const {createArchiveReportingFixture}=require('./fixtures/archive_reporting_fixture.cjs');
const artifacts=process.env.FLASHBACK_REPORTING_ARTIFACTS;
for(const kind of ['Full','Min'])for(const mode of ['compatible','incompatible','mixed'])test(`${kind} archive reporting ${mode} uses only built public paths`,{skip:!artifacts},async()=>{
 const f=await createArchiveReportingFixture();
 try{
  const cfg=f.api._test.normalizeSettings({...f.fixtureSettings,embeddingDimensions:mode==='compatible'?4:6,chunkChars:400,chunkOverlap:0});
  await f.api.saveSettings(cfg);const rows=mode==='mixed'?await f.seedMixed(cfg):[];
  const ownerKey=[...f.pluginStorage.values.keys()].find(key=>key.endsWith(':manifest:v2')&&f.parseStoredValue(f.pluginStorage.values.get(key))?.scopeKey===f.scope.scopeKey);
  assert(ownerKey);
  await f.restart(path.join(artifacts,kind,'plugins/Flashback_Memory.js'));
  const api=f.api;assert.equal(api._test,undefined); // No test-only surface is called on the consumer artifact.
  const before=f.requests,result=await api.reembedAllRecords({scope:f.scope,maxRecords:1});
  assert.equal(result.archivePending,3);assert.equal(result.archivePendingMeaning,'excluded_archive_records');
  assert.equal(result.archiveRecordsNeedingEmbedding,mode==='compatible'?0:3);
  assert.equal(result.archiveReason,mode==='compatible'?'archive_up_to_date':'archive_repair_unsupported');
  assert.equal(result.pending,rows.length?1:0);assert.equal(result.localPendingSources,result.pending);
  assert.equal(result.pendingUnit,'source_groups');assert.equal(result.physicalRequests,0);assert.equal(f.requests,before);
  const stale=await api.reembedAllRecords({scope:f.scope,settings:{...cfg,embeddingDimensions:cfg.embeddingDimensions+1}});
  assert.equal(stale.reason,'profile_changed');assert.equal(stale.archiveRecordsNeedingEmbedding,null);assert.equal(f.requests,before);
  if(mode==='mixed'){
    const proof=await api.healthRecovery.previewPhysicalRepair();assert.equal(proof.allowed,true,JSON.stringify(proof));
    assert.equal(proof.counts.eligibleSources,1);assert.equal(proof.counts.eligibleRecords,rows.length);assert.equal(proof.counts.archivePending,3);
    const repaired=await api.healthRecovery.repair(proof);assert.equal(repaired.status,'verified',JSON.stringify(repaired));
    assert.equal(repaired.counts.completed,rows.length);assert.equal(repaired.archivePendingMeaning,'excluded_archive_records');
    assert.equal(repaired.finalVerification.healthy,null);assert.equal(f.requests-before,repaired.provider.requests.length);
  }else{
    assert.equal((await api.healthRecovery.previewPhysicalRepair()).reason,'archive_repair_unsupported');
    await assert.rejects(()=>api.runMemoryMaintenance('reembed'),error=>error.code==='FLASHBACK_ARCHIVE_REPAIR_UNSUPPORTED');
    if(mode==='incompatible')await assert.rejects(()=>api.runMemoryMaintenance('auto'),error=>error.code==='FLASHBACK_ARCHIVE_REPAIR_UNSUPPORTED');
    assert.equal(f.requests,before);
  }
  const get=f.pluginStorage.getItem.bind(f.pluginStorage);
  f.pluginStorage.getItem=async key=>{if(String(key).startsWith(`vector_rag_memory:scope:${f.archiveManifest.storageHash}:`))throw Error('synthetic unavailable archive');return get(key);};
  try{
    const unknown=await api.reembedAllRecords({scope:f.scope});
    assert.equal(unknown.archiveRecordsNeedingEmbedding,null);assert.equal(unknown.archivePending,null);
    assert.equal(unknown.archiveCoverage.inspection,'unknown');
  }finally{f.pluginStorage.getItem=get;}
  assert.equal(JSON.stringify(f.parseStoredValue(f.pluginStorage.values.get(ownerKey)).archiveRef),JSON.stringify(f.ref));
  f.assertMapSubsetUnchanged(f.protectedArchive,f.pluginStorage.values,'artifact archive plugin bytes');
  f.assertMapSubsetUnchanged(f.archiveVectors,f.safeLocalStorage.values,'artifact archive vectors');
 }finally{await f.dispose();}
});
