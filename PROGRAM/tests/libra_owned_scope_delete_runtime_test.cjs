'use strict';
const assert=require('node:assert/strict');const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {createMemorySuiteServer}=require('../server/server.cjs');
const exposeBridge=source=>source.replace('  const RisuCompat = (() => {',
 '  globalThis.__deleteScopeBridge = MemorySuiteStorageBridge;\n  const RisuCompat = (() => {');
(async()=>{for(const mode of ['server_only','mirror']){const s=await serverFixture({mode,transformSource:exposeBridge});try{
 const otherScope={scopeId:'unrelated-live-scope',scopeKey:'unrelated-live-scope',characterId:'other',chatId:'live'};
 await s.f.r.context.__deleteScopeBridge.setScopeMode(otherScope,'server_only');
 const liveModeBefore=(await s.f.r.context.__deleteScopeBridge.getScopeMode(otherScope)).mode;
 assert.equal(liveModeBefore,'server_only');
 await s.f.run();await s.f.r.api.retryPendingUnifiedVectors();
 const db=s.app.repositories.libra.database;
 const before=s.storedRows();assert.ok(before.length>0);
 const owned=before.find(row=>row.key.startsWith('libra:v1:scope:seventh-server-scope:'));
 assert.ok(owned,'the test has an owner row for rollback injection');
 const original=db.prepare('SELECT space,key,value_json,deleted,revision,digest FROM kv WHERE key=?').get(owned.key);
 const failedOperationId='injected_scope_fence_failure_'+mode;
 db.exec("CREATE TRIGGER fail_owner_fence BEFORE INSERT ON libra_deleted_owner_scopes BEGIN SELECT RAISE(ABORT, 'injected_scope_fence_failure'); END");
 try{
  assert.throws(()=>s.app.repositories.libra.applyConditionalBatch([{kind:'remove',space:original.space,key:original.key,
   expectedRevision:original.revision,expectedDigest:original.digest,expectedExists:true,expectedTombstone:false}],{
   maintenance:true,operationId:failedOperationId,
   ownedScopeDeletion:{scopeId:'fault-scope-'+mode,scopeKey:'seventh-server-scope',backupId:'fault-backup'}
  }),/injected_scope_fence_failure/);
 }finally{db.exec('DROP TRIGGER fail_owner_fence');}
 const rolledBack=db.prepare('SELECT space,key,value_json,deleted,revision,digest FROM kv WHERE key=?').get(owned.key);
 for(const field of ['space','key','value_json','deleted','revision','digest'])assert.equal(rolledBack[field],original[field]);
 assert.equal(db.prepare('SELECT operation_id FROM operations WHERE operation_id=?').get(failedOperationId),undefined);
 assert.equal(db.prepare('SELECT scope_id FROM libra_deleted_owner_scopes WHERE scope_id=?').get('fault-scope-'+mode),undefined);
 const otherKey='libra:v1:scope:unrelated-chat:manifest';
 await s.mutate(otherKey,{preserve:true});
 const preserved=db.prepare('SELECT * FROM kv WHERE key=?').get(otherKey);
 const pendingPlan=await s.f.r.context.__deleteScopeBridge.planOwnedScopeDeletion('seventh-server-scope');
 const siblingKey='libra:v1:scope:seventh-server-scope:child:manifest';
 await s.mutate(siblingKey,{schema:'libra.manifest.v1',scopeKey:'seventh-server-scope:child',preserve:true});
 const siblingBefore=db.prepare('SELECT * FROM kv WHERE key=?').get(siblingKey);
 assert.equal(siblingBefore?.deleted,0,'the sibling scope is live before deletion');
 await assert.rejects(()=>s.f.r.context.__deleteScopeBridge.executeOwnedScopeDeletion(pendingPlan),
  /owner_scope_delete_overlapping_scope/);
 await assert.rejects(()=>s.f.r.api.deleteLibraScope(),/owner_scope_delete_overlapping_scope/);
 assert.deepEqual(db.prepare('SELECT * FROM kv WHERE key=?').get(siblingKey),siblingBefore,
  `${mode}: a rejected prefix-overlap deletion preserves the live sibling`);
 assert.deepEqual(db.prepare('SELECT * FROM kv WHERE key=?').get(otherKey),preserved);
 assert.equal(db.prepare('SELECT * FROM kv WHERE key=?').get(owned.key)?.deleted,0);
 // Remove only this injected sibling fixture before exercising the ordinary
 // successful deletion path; a real sibling scope is never removed by LIBRA.
 db.prepare('DELETE FROM kv WHERE key=?').run(siblingKey);
 const siblingMicroKey='libra:v1:scope:seventh-server-scope:child:micro-memory:main:e0:t1:r1:a1';
 await s.mutate(siblingMicroKey,{schema:'libra.micro_memory.v1',scopeKey:'seventh-server-scope:child'});
 const siblingMicroBefore=db.prepare('SELECT * FROM kv WHERE key=?').get(siblingMicroKey);
 await assert.rejects(()=>s.f.r.api.deleteLibraScope(),/owner_scope_delete_overlapping_scope/);
 assert.deepEqual(db.prepare('SELECT * FROM kv WHERE key=?').get(siblingMicroKey),siblingMicroBefore,
  `${mode}: a source-bound sibling row remains safe before its manifest exists`);
 db.prepare('DELETE FROM kv WHERE key=?').run(siblingMicroKey);
 const unownedKey='libra:v1:scope:seventh-server-scope:child:opaque-record:r1';
 await s.mutate(unownedKey,{schema:'future.owner_record.v1',value:'unknown owner'});
 const unownedBefore=db.prepare('SELECT * FROM kv WHERE key=?').get(unownedKey);
 await assert.rejects(()=>s.f.r.api.deleteLibraScope(),/owner_scope_delete_owner_unverified/);
 assert.deepEqual(db.prepare('SELECT * FROM kv WHERE key=?').get(unownedKey),unownedBefore,
  `${mode}: an unmarked row cannot be assigned to the parent by prefix alone`);
 db.prepare('DELETE FROM kv WHERE key=?').run(unownedKey);
 const orphanArchiveKey='libra:v1:scope:seventh-server-scope:micro-handoff-archive:orphan';
 await s.mutate(orphanArchiveKey,{schema:'libra.micro_handoff_archive.v1',sourceScopeKey:'source',archiveDigest:'orphan'});
 const orphanBefore=db.prepare('SELECT * FROM kv WHERE key=?').get(orphanArchiveKey);
 await assert.rejects(()=>s.f.r.api.deleteLibraScope(),/owner_scope_delete_owner_unverified/);
 assert.deepEqual(db.prepare('SELECT * FROM kv WHERE key=?').get(orphanArchiveKey),orphanBefore,
  `${mode}: an archive without a target-manifest reference is not a proven owner row`);
 db.prepare('DELETE FROM kv WHERE key=?').run(orphanArchiveKey);
 await s.mutate(siblingKey,{schema:'libra.manifest.v1',scopeKey:'seventh-server-scope:child'});
 await s.mutate(siblingKey,null,'remove');
 assert.equal(db.prepare('SELECT deleted FROM kv WHERE key=?').get(siblingKey)?.deleted,1,
  `${mode}: the sibling key is a tombstone before parent deletion`);
 const result=await s.f.r.api.deleteLibraScope();
 assert.equal(result.verified,true);assert.equal(result.durable,true);assert.equal(result.reloadRequired,true);assert.ok(result.backupId);
 assert.deepEqual(db.prepare('SELECT * FROM kv WHERE key=?').get(otherKey),preserved);
 const prefix='libra:v1:scope:'+result.scopeKey+':';
 const remaining=db.prepare('SELECT key,deleted FROM kv').all().filter(row=>row.key.startsWith(prefix)&&!row.deleted);
 assert.equal(remaining.length,0);assert.ok(s.app.listBackups().some(b=>b.id===result.backupId));
 const deletedRow=before.find(row=>row.key.startsWith(prefix));
 assert.ok(deletedRow,'the deleted scope had a physical owner row');
 const freshBootstrap=await fetch(s.url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'libra'}}).then(r=>r.json());
 const headers={
  'Content-Type':'application/json','X-Memory-Suite-Plugin':'libra',
  'X-Memory-Suite-Storage-Mode':mode,
  'X-Memory-Suite-Reset-Epochs':JSON.stringify(freshBootstrap.resetEpochs||{}),
  Authorization:'Bearer '+freshBootstrap.token
 };
 const post=async(route,body,scopeId='')=>{
  const response=await fetch(s.url+route,{method:'POST',headers:{...headers,...(scopeId?{'X-Memory-Suite-Scope-Id':encodeURIComponent(scopeId)}:{})},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 };
 const ownerScopeId=result.scopeId;
 assert.ok(ownerScopeId,'deletion receipt binds the owner scope ID');
 const fence=db.prepare('SELECT scope_key,backup_id FROM libra_deleted_owner_scopes WHERE scope_id=?').get(ownerScopeId);
 assert.equal(fence?.scope_key,result.scopeKey);assert.equal(fence?.backup_id,result.backupId);
 assert.equal(db.prepare('SELECT scope_id FROM libra_deleted_owner_keys WHERE space=? AND key=?').get('plugin',deletedRow.key)?.scope_id,ownerScopeId);
 const replay=await post('/v1/kv/set',{namespace:'libra',space:'plugin',key:deletedRow.key,
  value:deletedRow.raw,operationId:'deleted_scope_reupload_probe_'+mode});
 assert.equal(replay.status,409,
  `${mode}: a freshly reconnected client cannot recreate a deleted owner row: ${JSON.stringify(replay.body)}`);
 assert.equal(replay.body.error,'libra_deleted_scope_write_blocked');
 assert.equal(db.prepare('SELECT key,deleted FROM kv WHERE key=?').get(deletedRow.key)?.deleted,1);
 const tombstone=db.prepare('SELECT revision,digest FROM kv WHERE key=?').get(deletedRow.key);
 const batch=await post('/v1/kv/batch',{namespace:'libra',operationId:'deleted_scope_batch_probe_'+mode,
  mutations:[{kind:'set',space:'plugin',key:deletedRow.key,value:deletedRow.raw,expectedRevision:tombstone.revision,
   expectedDigest:tombstone.digest,expectedExists:false,expectedTombstone:true}]},ownerScopeId);
 assert.equal(batch.status,409,`${mode}: batch replay: ${JSON.stringify(batch.body)}`);
 assert.equal(batch.body.error,'libra_deleted_scope_write_blocked');
 const unseenKey=prefix+'micro-memory:later:e0:t7';
 const unseen=await post('/v1/kv/set',{namespace:'libra',space:'plugin',key:unseenKey,value:'new',
  operationId:'deleted_scope_new_key_probe_'+mode},ownerScopeId);
 assert.equal(unseen.status,409,`${mode}: new key in deleted scope: ${JSON.stringify(unseen.body)}`);
 assert.equal(db.prepare('SELECT key FROM kv WHERE key=?').get(unseenKey),undefined);
 const sibling=await post('/v1/kv/set',{namespace:'libra',space:'plugin',key:siblingKey,value:'other scope',
  operationId:'live_sibling_scope_probe_'+mode},'other-scope-id');
 assert.equal(sibling.status,200,`${mode}: a different scope sharing a key prefix remains writable: ${JSON.stringify(sibling.body)}`);
 await s.restart();
 const resumedBridge=s.f.r.context.__deleteScopeBridge;
 const liveModeAfter=(await resumedBridge.getScopeMode(otherScope)).mode;
 assert.equal(liveModeAfter,liveModeBefore,`${mode}: deleting one scope preserves another scope's storage mode after reload`);
 const deletedScope={scopeId:ownerScopeId,scopeKey:result.scopeKey};
 assert.equal((await resumedBridge.getScopeMode(deletedScope)).mode,'server_only');
 await assert.rejects(()=>resumedBridge.setScopeMode(deletedScope,'server_only'),/libra_deleted_scope_mode_locked/);
 await s.f.r.cleanup();
 await s.app.close();
 const reopened=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:s.dir,autoBackup:false});
 try{
  const address=await reopened.listen(),base=`http://127.0.0.1:${address.port}`;
  const boot=await fetch(base+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'libra'}}).then(r=>r.json());
  const retry=await fetch(base+'/v1/kv/set',{method:'POST',headers:{
   'Content-Type':'application/json','X-Memory-Suite-Plugin':'libra',
   'X-Memory-Suite-Scope-Id':encodeURIComponent(ownerScopeId),
   'X-Memory-Suite-Reset-Epochs':JSON.stringify(boot.resetEpochs||{}),Authorization:'Bearer '+boot.token
  },body:JSON.stringify({namespace:'libra',space:'plugin',key:unseenKey,value:'after restart',
   operationId:'deleted_scope_restart_probe_'+mode})});
  assert.equal(retry.status,409,`${mode}: owner scope fence survives server restart: ${await retry.text()}`);
  assert.equal(reopened.repositories.libra.isOwnerScopeDeleted(ownerScopeId),true);
 }finally{await reopened.close();}
 console.log('PASS '+mode+' scope deletion with backup, readback, unrelated scope preservation and reload fence');
}finally{await s.cleanup();}}})().catch(e=>{console.error(e);process.exitCode=1;});
