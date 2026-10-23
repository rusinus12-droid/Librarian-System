'use strict';
// Ordinary debug exports must preserve the failed global preview even when the
// selected chat is empty and plugin_only intentionally skips server diagnostics.
const assert=require('node:assert/strict');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
(async()=>{for(const variant of variants){
 let blocked=true,warn=true;
 const manifestState={scopeKey:'char:source|chat:inactive',commitId:'',count:1000,shardCount:16,rawPageLayout:'',observedShardCount:0,observedShardKeys:[]};
 const f=await fixture(variant,{adapter:async({hostScopes,records})=>({
  scopes:hostScopes.map(s=>({...s,scopeId:s.chatId,scopeKey:s.chatId})),
  records:records.map(r=>({...r,classification:'scope',scopeId:r.logicalKey.slice(variant[0].length+1)})),
  blockers:blocked?[{code:variant[0]+'_global_dependency_missing',location:'plugin',key:'manifest-key',detail:'missing-shard',manifestState,value:'PRIVATE_RECORD_BODY',credential:'PRIVATE_CREDENTIAL'}]:[],
  warnings:warn?[{code:'flashback_global_vector_payload_absent',location:'plugin',key:'source-shard',detail:'absent-vector',value:'PRIVATE_RECORD_BODY',credential:'PRIVATE_CREDENTIAL'}]:[],warningCount:warn?300:0,
  completeKnownScopes:!blocked
 })});
 try{
  const initial=await f.bridge.getDiagnostics();assert.equal(initial.reason,'plugin_only_no_server_probe');assert.equal(initial.migrationPreview,undefined);
  const preview=await f.bridge.previewGlobalMode('server_only');assert.equal(preview.completeKnownScopes,false);
  assert.equal(preview.warningCount,300);assert.equal(preview.warnings.length,1);assert(!JSON.stringify(preview.warnings).includes('PRIVATE_'));
  const before=[...f.values.entries()],calls=f.calls.length;
  for(const result of [f.bridge.getCachedDiagnostics(),await f.bridge.getDiagnostics(),await f.bridge.getDiagnostics({force:true})]){
   const saved=result.migrationPreview;assert.equal(saved.completeKnownScopes,false);assert.equal(saved.targetMode,'server_only');assert.equal(saved.discoveredScopes,3);
   assert.deepEqual(JSON.parse(JSON.stringify(saved.blockers[0].manifestState)),manifestState);
   assert.equal(saved.blockers[0].detail,'missing-shard');assert(!JSON.stringify(saved).includes('PRIVATE_'),'record bodies and credentials are excluded');
   assert.equal(saved.warningCount,300);assert.equal(saved.warnings[0].detail,'absent-vector');
  }
  assert.deepEqual([...f.values.entries()],before,'debug reads do not change source/routing');assert.equal(f.calls.length,calls,'debug reads do not add server probes');
  const external=f.bridge.getCachedDiagnostics();external.migrationPreview.blockers[0].manifestState.observedShardKeys.push('mutated');
  external.migrationPreview.warnings[0].detail='mutated';
  assert.equal(f.bridge.getCachedDiagnostics().migrationPreview.blockers[0].manifestState.observedShardKeys.length,0,'exports cannot mutate cached witnesses');
  assert.equal(f.bridge.getCachedDiagnostics().migrationPreview.warnings[0].detail,'absent-vector','exports cannot mutate cached warnings');
  blocked=false;await f.bridge.previewGlobalMode('server_only');assert.equal(f.bridge.getCachedDiagnostics().migrationPreview.completeKnownScopes,true,'a new preview replaces the previous result');
  assert.equal(f.bridge.getCachedDiagnostics().migrationPreview.blockers.length,0);
  warn=false;await f.bridge.previewGlobalMode('server_only');assert.equal(f.bridge.getCachedDiagnostics().migrationPreview.warningCount,0);assert.equal(f.bridge.getCachedDiagnostics().migrationPreview.warnings.length,0);
  console.log('PASS '+variant[0]+' failed migration details survive cached/fresh debug export without source changes');
 }finally{await f.close();}
}})().catch(error=>{console.error(error);process.exitCode=1;});
