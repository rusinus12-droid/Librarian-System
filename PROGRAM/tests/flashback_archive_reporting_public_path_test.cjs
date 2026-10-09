'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {createArchiveReportingFixture}=require('./fixtures/archive_reporting_fixture.cjs');
test('public three-row portable archive reporting remains local-only and truthful',async t=>{
 const f=await createArchiveReportingFixture();
 const {api:flashback,scope,fixtureSettings,pluginStorage,safeLocalStorage,ref,archiveManifest,protectedArchive,archiveVectors,assertMapSubsetUnchanged,parseStoredValue}=f;
 try {
  await t.test('compatible archive is excluded, not pending work',async()=>{
    const samePlan=await flashback.inspectMemoryMaintenance({scope,ensureStorage:false});
    const sameFull=await flashback.reembedAllRecords({scope});
    assert.equal(samePlan.archiveRecordsNeedingEmbedding,0);
    assert.equal(sameFull.archivePending,3);
    assert.equal(sameFull.archivePendingMeaning,'excluded_archive_records');
    assert.equal(sameFull.archiveRecordsNeedingEmbedding,0);
    assert.equal(sameFull.pending,0);assert.equal(sameFull.pendingUnit,'source_groups');
    assert.equal(sameFull.archiveReason,'archive_up_to_date');
    assert.equal(sameFull.archiveCoverage.execution,'unsupported');
    assert.equal(sameFull.archiveCoverage.inspection,'complete');
    assert.equal(sameFull.reembedded,0);assert.equal(f.requests,0);
  });
  await t.test('archive-only compatible advanced maintenance never probes a provider',async()=>{
    const count=f.requests;
    await assert.rejects(()=>flashback.runMemoryMaintenance('reembed'),error=>error.code==='FLASHBACK_ARCHIVE_REPAIR_UNSUPPORTED');
    assert.equal(f.requests,count);
  });
  await t.test('scope refusal remains primary',async()=>{
    const stale=await flashback.reembedAllRecords('foreign-scope');
    assert.equal(stale.reason,'scope_changed');assert.equal(stale.archiveRecordsNeedingEmbedding,null);assert.equal(f.requests,0);
  });
  const next=flashback._test.normalizeSettings({...fixtureSettings,embeddingDimensions:6});
  await t.test('unsaved profile refusal is primary and archive inspection is unknown',async()=>{
    const staleLocal=await flashback.progressivelyReembedRecords(scope,next);
    const staleFull=await flashback.reembedAllRecords({scope,settings:next});
    assert.equal(staleLocal.reason,'profile_changed');assert.equal(staleFull.reason,'profile_changed');
    assert.equal(staleFull.archiveRecordsNeedingEmbedding,null);assert.equal(f.requests,0);
  });
  await flashback.saveSettings(next);
  const plan=await flashback.inspectMemoryMaintenance({scope,ensureStorage:false});
  await t.test('incompatible archive reports measured mismatches and unsupported execution',async()=>{
    const full=await flashback.reembedAllRecords({scope});
    assert.equal(plan.archiveRecordsNeedingEmbedding,3);assert.equal(full.archiveReembedded,0);
    assert.equal(full.archiveRecordsNeedingEmbedding,3);assert.equal(full.archiveReason,'archive_repair_unsupported');
    assert.equal(full.pending,0);assert.equal(full.physicalRequests,0);assert.equal(f.requests,0);
    const preview=await flashback.healthRecovery.previewPhysicalRepair();
    assert.equal(preview.allowed,false);assert.equal(preview.reason,'archive_repair_unsupported');
  });
  await t.test('archive-only automatic maintenance refuses before a provider connection probe',async()=>{
    const count=f.requests;
    await assert.rejects(()=>flashback.runMemoryMaintenance('auto',{preflight:plan}),error=>error.code==='FLASHBACK_ARCHIVE_REPAIR_UNSUPPORTED');
    assert.equal(f.requests,count);
  });
  await t.test('archive read failure remains unknown without losing local result',async()=>{
    const get=pluginStorage.getItem.bind(pluginStorage);
    pluginStorage.getItem=async key=>{if(String(key).startsWith(`vector_rag_memory:scope:${archiveManifest.storageHash}:`))throw Error('synthetic archive read failure');return get(key);};
    try {
      const full=await flashback.reembedAllRecords({scope});
      assert.equal(full.archiveCoverage?.inspection,'unknown');assert.equal(full.archiveRecordsNeedingEmbedding,null);
      assert.equal(full.archivePending,null);assert.equal(full.archiveReason,'archive_inspection_incomplete');
      assert.equal(full.reembedded,0);assert.equal(full.pending,0);
    } finally {pluginStorage.getItem=get;}
  });
  await t.test('invalid archive inventory does not publish zero mismatch or healthy',async()=>{
    const key=[...protectedArchive.keys()].find(key=>key.endsWith(':manifest:v2'));
    const raw=pluginStorage.values.get(key),body=parseStoredValue(raw);
    pluginStorage.values.set(key,JSON.stringify({...body,archiveId:'invalid-layer-identity'}));
    try {
      const inspected=await flashback.inspectMemoryMaintenance({scope,ensureStorage:false});
      assert.equal(inspected.archiveRecordsNeedingEmbedding,null);assert.equal(inspected.healthy,false);
      assert.equal(inspected.archiveInspectionComplete,false);
      const full=await flashback.reembedAllRecords({scope});
      assert.equal(full.archiveRecordsNeedingEmbedding,null);assert.equal(full.archiveCoverage?.inspection,'unknown');
    } finally {pluginStorage.values.set(key,raw);}
  });
  await t.test('profile changes during archive reporting invalidate numeric evidence',async()=>{
    const get=pluginStorage.getItem.bind(pluginStorage);let changed=false;
    pluginStorage.getItem=async key=>{
      if(!changed&&String(key).startsWith(`vector_rag_memory:scope:${archiveManifest.storageHash}:`)){
        changed=true;await flashback.saveSettings({...next,embeddingDimensions:7});
      }
      return get(key);
    };
    const before=f.requests;
    try {const full=await flashback.reembedAllRecords({scope});assert.equal(changed,true);assert.equal(full.archiveCoverage.inspection,'unknown');assert.equal(full.archiveRecordsNeedingEmbedding,null);assert.equal(f.requests,before);}
    finally {pluginStorage.getItem=get;await flashback.saveSettings(next);}
  });
  await t.test('foreign archive storage route remains unknown, with no reporting request',async()=>{
    const key=[...pluginStorage.values.keys()].find(key=>key.includes('scope_routes_v1__:flashback'));
    assert(key,'durable routing fixture is present');
    const raw=pluginStorage.values.get(key),local=safeLocalStorage.values.get(key),routes=JSON.parse(raw);
    routes.entries[ref.archiveScopeKey]={scopeId:ref.archiveScopeKey,mode:'server_only',origin:'user_explicit',updatedAt:Date.now()+100000};
    pluginStorage.values.set(key,JSON.stringify(routes));safeLocalStorage.values.set(key,JSON.stringify(routes));
    const before=f.requests;
    try {const full=await flashback.reembedAllRecords({scope});assert.equal(full.archiveCoverage.inspection,'unknown');assert.equal(full.archiveRecordsNeedingEmbedding,null);assert.equal(f.requests,before);}
    finally {pluginStorage.values.set(key,raw);if(local===undefined)safeLocalStorage.values.delete(key);else safeLocalStorage.values.set(key,local);}
  });
  const chunked=flashback._test.normalizeSettings({...next,chunkChars:400,chunkOverlap:0});
  await flashback.saveSettings(chunked);
  const rows=await f.seedMixed(chunked);
  assert.ok(rows.length>1,'one durable source group spans multiple records');
  await t.test('local source-group pending never sums archive record counts',async()=>{
    const count=f.requests;
    const mixed=await flashback.reembedAllRecords({scope,maxRecords:1});
    assert.equal(mixed.pending,1);assert.equal(mixed.localPendingSources,1);assert.equal(mixed.pendingUnit,'source_groups');
    assert.equal(mixed.archivePending,3);assert.equal(mixed.archiveRecordsNeedingEmbedding,3);assert.equal(f.requests,count);
  });
  await t.test('physical local positive preserves archive bytes and healthy null',async()=>{
    const before=f.requests,mixedPreview=await flashback.healthRecovery.previewPhysicalRepair();
    assert.equal(mixedPreview.allowed,true,JSON.stringify(mixedPreview));assert.equal(mixedPreview.counts.eligibleSources,1);
    assert.equal(mixedPreview.counts.eligibleRecords,rows.length);assert.equal(mixedPreview.counts.archivePending,3);
    assert.match(mixedPreview.warning,/미완료 작업 수가 아닙니다/);
    const physical=await flashback.healthRecovery.repair(mixedPreview);
    assert.equal(physical.status,'verified',JSON.stringify(physical));assert.equal(physical.counts.completed,rows.length);
    assert.equal(physical.archivePendingMeaning,'excluded_archive_records');
    assert.equal(physical.finalVerification.healthy,null);assert.equal(f.requests-before,physical.provider.requests.length);
    const after=await flashback._test.loadScopeManifest(scope.scopeKey);
    assert.deepEqual(JSON.stringify(after.archiveRef),JSON.stringify(ref));
    assertMapSubsetUnchanged(protectedArchive,pluginStorage.values,'archive plugin bytes');
    assertMapSubsetUnchanged(archiveVectors,safeLocalStorage.values,'archive vector bytes');
    const afterPlan=await flashback.inspectMemoryMaintenance({scope,ensureStorage:false});
    assert.equal(afterPlan.archiveRecordsNeedingEmbedding,3);assert.equal(afterPlan.healthy,false);
  });
 } finally {await f.dispose();}
});

test('archive read failure cannot erase a completed local execution',async()=>{
 const f=await createArchiveReportingFixture();
 try{
  const cfg=f.api._test.normalizeSettings({...f.fixtureSettings,embeddingDimensions:6,chunkChars:400,chunkOverlap:0});
  await f.api.saveSettings(cfg);const rows=await f.seedMixed(cfg),get=f.pluginStorage.getItem.bind(f.pluginStorage);
  f.pluginStorage.getItem=async key=>{if(String(key).startsWith(`vector_rag_memory:scope:${f.archiveManifest.storageHash}:`))throw Error('synthetic unavailable archive');return get(key);};
  let result;
  try{result=await f.api.reembedAllRecords({scope:f.scope});}finally{f.pluginStorage.getItem=get;}
  assert.equal(result.reembedded,rows.length);assert.equal(result.localReembedded,rows.length);
  assert.equal(result.archiveCoverage.inspection,'unknown');assert.equal(result.archiveRecordsNeedingEmbedding,null);
  assert.equal(result.archivePending,null);assert.equal(result.partialSuccess,true);assert.equal(result.physicalRequests,f.requests);
  f.assertMapSubsetUnchanged(f.protectedArchive,f.pluginStorage.values,'completed local archive plugin bytes');
  f.assertMapSubsetUnchanged(f.archiveVectors,f.safeLocalStorage.values,'completed local archive vectors');
 }finally{await f.dispose();}
});
