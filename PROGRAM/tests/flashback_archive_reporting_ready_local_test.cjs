'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {test}=require('node:test');
const {createArchiveReportingFixture}=require('./fixtures/archive_reporting_fixture.cjs');
const artifacts=process.env.FLASHBACK_REPORTING_ARTIFACTS;
async function readyFixture(kind='source'){
 const f=await createArchiveReportingFixture(),api=f.api;
 const cfg=api._test.normalizeSettings({...f.fixtureSettings,embeddingDimensions:6,chunkChars:400,chunkOverlap:0});
 await api.saveSettings(cfg);const chat=await f.host.getChat();
 chat.message.push({role:'user',data:'Where is the ruby?',chatId:'local-user-1'},{role:'assistant',data:'The ruby is in a locked drawer near the observatory.',chatId:'local-ai-1'});
 await api.ingestLiveChatColdStart({scope:'current',incremental:true,skipEpisodeRebuild:true,skipGuiRefresh:true});
 if(kind!=='source'){await f.restart(path.join(artifacts,kind,'plugins/Flashback_Memory.js'));assert.equal(f.api._test,undefined);}
 return {f,cfg,chat};
}
for(const kind of artifacts?['Full','Min']:['source'])for(const mode of ['auto','reembed'])test(`${kind} ${mode} refuses archive-only work despite an already-ready local record`,async()=>{
 const {f}=await readyFixture(kind);
 try{
  const plan=await f.api.inspectMemoryMaintenance();
  assert.equal(plan.responseRecords,1);assert.equal(plan.localRecordsNeedingEmbedding,0);assert.equal(plan.archiveRecordsNeedingEmbedding,3);
  assert.equal(plan.missingTurns,0);assert.equal(plan.changedTurns,0);assert.equal(plan.staleStoredTurns,0);assert.equal(plan.dirtyRecords,0);
  const before=f.requests;
  await assert.rejects(()=>f.api.runMemoryMaintenance(mode,{preflight:plan}),e=>e.code==='FLASHBACK_ARCHIVE_REPAIR_UNSUPPORTED');
  assert.equal(f.requests,before,'ready local rows never authorize a query-only archive operation');
  f.assertMapSubsetUnchanged(f.protectedArchive,f.pluginStorage.values,'ready-local archive plugin bytes');
  f.assertMapSubsetUnchanged(f.archiveVectors,f.safeLocalStorage.values,'ready-local archive vectors');
 }finally{await f.dispose();}
});
if(!artifacts)for(const condition of ['changed_source','missing_source','stale_source','local_vector_work','sanitizer_cleanup','index_rebuild','episode_rebuild','incomplete_archive','stale_approval'])test(`archive-only shortcut never masks ${condition}`,async()=>{
 const {f,cfg,chat}=await readyFixture();
 try{
  let plan=await f.api.inspectMemoryMaintenance(),expected;
  if(condition==='changed_source'){chat.message[1].data+=' She also carries the blue compass.';expected=['changedTurns',v=>v>0];}
  if(condition==='missing_source'){chat.message.push({role:'user',data:'Who has the sapphire?',chatId:'local-user-2'},{role:'assistant',data:'Rowan has the sapphire.',chatId:'local-ai-2'});expected=['missingTurns',v=>v>0];}
  if(condition==='stale_source'){chat.message.length=0;expected=['staleStoredTurns',v=>v>0];}
  if(condition==='local_vector_work'){await f.seedMixed(cfg);expected=['localRecordsNeedingEmbedding',v=>v>0];}
  if(condition==='sanitizer_cleanup'){
    const loaded=await f.api._test.loadScopeRecords(f.scope.scopeKey);
    for(const row of loaded.records)row.metadata={...row.metadata,memorySanitizerVersion:0};
    await f.api._test.saveAllRecords(loaded.records,cfg,f.scope);expected=['legacySanitizerRecords',v=>v>0];
  }
  if(condition==='index_rebuild'){
    const manifest=await f.api._test.loadScopeManifest(f.scope.scopeKey);
    await f.api._test.saveScopeManifest({...manifest,shardIndexVersion:0},f.scope);expected=['shardIndexMismatch',v=>v===true];
  }
  if(condition==='episode_rebuild'){await f.api.saveSettings({...cfg,episodeIndexEnabled:true});expected=['episodeStale',v=>v===true];}
  if(condition==='incomplete_archive'){
    const key=[...f.protectedArchive.keys()].find(k=>k.endsWith(':manifest:v2'));
    const raw=f.parseStoredValue(f.pluginStorage.values.get(key));f.pluginStorage.values.set(key,JSON.stringify({...raw,archiveId:'unverified'}));
    expected=['archiveInspectionComplete',v=>v===false];
  }
  if(condition==='stale_approval')chat.message[1].data+=' This changed after the displayed plan.';
  else {plan=await f.api.inspectMemoryMaintenance();assert(expected[1](plan[expected[0]]),`${condition} fixture must trigger ${expected[0]}, actual=${plan[expected[0]]}`);}
  const before=f.requests;let error,result;
  try{result=await f.api.runMemoryMaintenance('auto',{preflight:plan,maxRequests:0});}catch(e){error=e;}
  if(error)assert.notEqual(error.code,'FLASHBACK_ARCHIVE_REPAIR_UNSUPPORTED',`${condition} must retain its real local-work/authority path`);
  else {assert(result?.operation,'zero-model local work may complete without using the zero request budget');assert.notEqual(result.operation.strategy,'no_action');}
  if(condition==='stale_approval')assert.equal(error.code,'FLASHBACK_MAINTENANCE_APPROVAL_STALE');
  assert.equal(f.requests,before,'negative controls never invoke a provider');
 }finally{await f.dispose();}
});
