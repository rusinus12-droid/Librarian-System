'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const digest=value=>{
 const body=JSON.stringify(value);let hash=2166136261;
 for(let index=0;index<body.length;index++){hash^=body.charCodeAt(index);hash=Math.imul(hash,16777619);}
 hash^=31;hash=Math.imul(hash,16777619);
 return `${(hash>>>0).toString(16).padStart(8,'0')}:${body.length+1}`;
};

(async()=>{
 const s=await serverFixture({mode:'server_only'});
 try{
  await s.f.run();
  await s.f.r.api.retryPendingUnifiedVectors();
  const sourceScopeKey='seventh-server-scope',targetScopeKey='native-repair-child';
  const sourceManifestKey=`libra:v1:scope:${sourceScopeKey}:manifest`;
  const targetManifestKey=`libra:v1:scope:${targetScopeKey}:manifest`;
  const sourceArchiveKey=`libra:v1:scope:${sourceScopeKey}:micro-handoff-archive:inherited`;
  const targetArchiveKey=`libra:v1:scope:${targetScopeKey}:micro-handoff-archive:inherited`;
  const archiveCore={schema:'libra.micro_handoff_archive.v1',sourceScopeKey:'earlier-predecessor',
   activeWorldlineId:'main',recordCount:0,recordsDigest:digest([]),records:[]};
  const archive={...archiveCore,archiveDigest:digest(archiveCore)};
  const sourceRef={schema:'libra.micro_handoff_archive_ref.v1',archiveKey:sourceArchiveKey,
   archiveDigest:archive.archiveDigest,sourceScopeKey:archive.sourceScopeKey,recordCount:0,sessionEpoch:-1};
  const targetRef={...sourceRef,archiveKey:targetArchiveKey,nativeCopiedFromScopeKey:sourceScopeKey};
  const sourceManifest={...s.getManifest(),inheritedMicroArchives:[sourceRef]};
  assert.equal(sourceManifest.scopeKey,sourceScopeKey);
  await s.mutate(sourceArchiveKey,archive);
  await s.mutate(sourceManifestKey,sourceManifest);
  const targetManifest={schema:'libra.manifest.v1',scopeKey:targetScopeKey,
   nativeChatCopy:{schema:'libra.native_chat_copy.v2',completenessVersion:4,complete:true,
    durableVerified:true,sourceScopeKey,targetScopeKey},inheritedMicroArchives:[targetRef]};
  await s.mutate(targetManifestKey,targetManifest);
  await s.mutate(targetArchiveKey,archive);
  const otherKey='libra:v1:scope:untouched-scope:manifest';
  await s.mutate(otherKey,{schema:'libra.manifest.v1',scopeKey:'untouched-scope'});
  const otherBefore=s.app.repositories.libra.get('plugin',otherKey);
  const deleted=await s.f.r.api.deleteLibraScope();
  assert.equal(deleted.verified,true);
  const backupId=deleted.backupId;
  assert.equal((await s.app.createBackup('manual','repair-dirty-probe')).ok,true);
  const mutateDirect=(kind,key,value)=>s.app.repositories.libra.mutate({kind,space:'plugin',key,
   ...(kind==='set'?{value:JSON.stringify(value)}:{}),operationId:`fixture_repair_${kind}_${Date.now()}_${Math.random()}`});
  mutateDirect('remove',targetArchiveKey);
  const missing=s.app.repositories.libra.get('plugin',targetArchiveKey);
  assert.equal(missing.tombstone,true);
  const headers={'Content-Type':'application/json',Authorization:`Bearer ${s.app.token}`,'X-Memory-Suite-Admin':'1'};
  const request=async(route,body,admin=true)=>{
   const response=await fetch(s.url+route,{method:'POST',headers:admin?headers:{
    'Content-Type':'application/json',Authorization:`Bearer ${s.app.token}`,'X-Memory-Suite-Plugin':'libra'},
    body:JSON.stringify(body)});
   return {status:response.status,body:await response.json()};
  };
  const route='/v1/admin/libra/native-archive-repair';
  const unauthorized=await request(route+'/plan',{backupId,targetScopeKey,targetArchiveKey},false);
  assert.equal(unauthorized.status,403);
  const backup=s.app.listBackups().find(row=>row.id===backupId);
  const backupFile=path.join(backup.path,backup.stores.libra.file);
  const backupBytes=fs.readFileSync(backupFile);
  try{
   fs.appendFileSync(backupFile,Buffer.from([0]));
   const corrupt=await request(route+'/plan',{backupId,targetScopeKey,targetArchiveKey});
   assert.equal(corrupt.status,409,JSON.stringify(corrupt.body));
   assert.equal(corrupt.body.error,'libra_native_archive_repair_backup_unverified');
   assert.equal(s.app.repositories.libra.get('plugin',targetArchiveKey).tombstone,true);
  }finally{fs.writeFileSync(backupFile,backupBytes);}
  mutateDirect('set',targetManifestKey,{...targetManifest,inheritedMicroArchives:[targetRef,targetRef]});
  const duplicateRef=await request(route+'/plan',{backupId,targetScopeKey,targetArchiveKey});
  assert.equal(duplicateRef.status,409);
  assert.equal(duplicateRef.body.error,'libra_native_archive_repair_target_ref_invalid');
  mutateDirect('set',targetManifestKey,targetManifest);
  const planned=await request(route+'/plan',{backupId,targetScopeKey,targetArchiveKey});
  assert.equal(planned.status,200,JSON.stringify(planned.body));
  assert.equal(planned.body.result?.archiveKey,targetArchiveKey);
  assert.equal(planned.body.result?.sourceScopeKey,sourceScopeKey);
  const plan=planned.body.result;
  const changed={...targetManifest,repairProbe:'changed-after-plan'};
  mutateDirect('set',targetManifestKey,changed);
  const stale=await request(route+'/execute',{planId:plan.planId,fingerprint:plan.fingerprint});
  assert.equal(stale.status,409,JSON.stringify(stale.body));
  assert.equal(s.app.repositories.libra.get('plugin',targetArchiveKey).tombstone,true);
  mutateDirect('set',targetManifestKey,targetManifest);
  const retry=await request(route+'/plan',{backupId,targetScopeKey,targetArchiveKey});
  assert.equal(retry.status,200,JSON.stringify(retry.body));
  const repaired=await request(route+'/execute',{
   planId:retry.body.result.planId,fingerprint:retry.body.result.fingerprint});
  assert.equal(repaired.status,200,JSON.stringify(repaired.body));
  assert.equal(repaired.body.result?.durable,true);
  assert.equal(repaired.body.result?.physicalReadback,true);
  assert.equal(repaired.body.result?.reloadRequired,true);
  const health=await fetch(s.url+'/health').then(response=>response.json());
  assert.equal(health.dirtySinceBackup,true,'the selective repair is scheduled for the next backup');
  assert.equal(repaired.body.result?.nativeCopyCompleteness,'pending_revalidation');
  const repeated=await request(route+'/execute',{
   planId:retry.body.result.planId,fingerprint:retry.body.result.fingerprint});
  assert.deepEqual(repeated,repaired,'a repeated explicit repair returns its same receipt');
  const noLongerMissing=await request(route+'/plan',{backupId,targetScopeKey,targetArchiveKey});
  assert.equal(noLongerMissing.status,409);
  assert.equal(noLongerMissing.body.error,'libra_native_archive_repair_target_not_missing');
  const restored=s.app.repositories.libra.get('plugin',targetArchiveKey);
  assert.equal(restored.exists,true);
  assert.deepEqual(JSON.parse(restored.value),archive);
  assert.deepEqual(s.app.repositories.libra.get('plugin',otherKey),otherBefore);
  assert.equal(s.app.repositories.libra.isOwnerScopeDeleted(deleted.scopeId),true);
  assert.equal(s.app.repositories.libra.get('plugin',sourceArchiveKey).exists,false);
  assert.equal(s.app.repositories.libra.get('plugin',targetManifestKey).value,JSON.stringify(targetManifest));
  console.log('PASS selective native archive repair from verified pre-delete backup');
 }finally{await s.cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
