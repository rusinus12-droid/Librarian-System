'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createMemorySuiteServer}=require('../server/server.cjs');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'manager-control-'));let app,url,token;
 const start=async()=>{app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false});const a=await app.listen();url=`http://127.0.0.1:${a.port}`;token=(await(await fetch(url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'flashback_hayaku_bridge'}})).json()).token;};
 const call=async(action,body)=>{const r=await fetch(url+'/v1/manager/control/'+action,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'X-Memory-Suite-Plugin':'flashback_hayaku_bridge','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,...await r.json()};};
 try{
  await start();const key='hayaku.control.fixture';
  app.repositories.hayaku.mutate({kind:'set',space:'plugin',key,value:{version:1},expectedRevision:0,operationId:'seed_control_test_001'});
  const oldRisu=globalThis.risuai;
  globalThis.risuai={getArgument:async name=>name==='memory_suite_server_url'?url:'plugin_only',nativeFetch:fetch};
  const sdk=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteStorageClient.source.js'),'utf8');
  const bridge=new Function(sdk+'\nreturn createMemorySuiteStorageBridge;')()({namespace:'retrace',pluginId:'flashback_hayaku_bridge'});
  try{assert.equal((await bridge.managerControl('status')).dataPath,dir);assert.deepEqual(await bridge.managerControl('backups'),[]);}finally{await bridge.dispose();globalThis.risuai=oldRisu;}
  const status=await call('status');assert.equal(status.status,200);assert.equal(status.result.dataPath,dir);assert.ok(status.result.dataInstanceId);
  const backup=await call('backup-create',{operationId:'control_backup_001'});assert.equal(backup.status,200,JSON.stringify(backup));const backupId=backup.result.backupId;
  assert.equal((await call('backup-create',{operationId:'control_backup_001'})).result.backupId,backupId,'retry does not create another backup');
  assert.equal((await call('backups')).result.length,1);
  assert.equal((await call('backup-check',{operationId:'control_check_001',backupId})).result.verification.ok,true);
  let preview=await call('restore-plan',{backupId,namespaces:['hayaku']});assert.equal(preview.result.verified,true);
  app.repositories.hayaku.mutate({kind:'set',space:'plugin',key,value:{version:2},expectedRevision:1,operationId:'change_control_test_002'});
  assert.equal((await call('restore-execute',{operationId:'control_restore_stale',planId:preview.result.planId,confirmation:'RESTORE '+preview.result.planId})).status,409);
  preview=await call('restore-plan',{backupId,namespaces:['hayaku']});
  const execute={operationId:'control_restore_001',planId:preview.result.planId,confirmation:'RESTORE '+preview.result.planId};
  const restored=await call('restore-execute',execute);assert.equal(restored.status,200,JSON.stringify(restored));assert.equal(restored.result.reconnectRequired,true);
  assert.deepEqual(app.repositories.hayaku.get('plugin',key).value,{version:1});
  const owner=(await(await fetch(url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'hayaku_locator_continuity'}})).json());assert.equal(owner.resetEpochs.hayaku,1);
  const forbidden=await fetch(url+'/v1/manager/control/status',{headers:{Authorization:'Bearer '+owner.token,'X-Memory-Suite-Plugin':'hayaku_locator_continuity'}});assert.equal(forbidden.status,403);
  const oldWrite=await fetch(url+'/v1/kv/set',{method:'POST',headers:{Authorization:'Bearer '+owner.token,'X-Memory-Suite-Plugin':'hayaku_locator_continuity','Content-Type':'application/json'},body:JSON.stringify({namespace:'hayaku',space:'plugin',key,value:{version:9},expectedRevision:1,operationId:'stale_control_write'})});assert.equal(oldWrite.status,409);
  const journalFile=path.join(dir,'migrations','manager-control.json'),journal=JSON.parse(fs.readFileSync(journalFile,'utf8'));journal.operations.push({id:'interrupted_fixture',action:'restore-execute',status:'running',startedAt:Date.now(),intent:'{}'});fs.writeFileSync(journalFile,JSON.stringify(journal));
  await app.close();await start();
  assert.ok((await call('history')).result.some(row=>row.id==='interrupted_fixture'&&row.status==='interrupted'));
  assert.equal((await call('restore-execute',execute)).result.restored,true,'durable replay result after restart');
  assert.ok((await call('history')).result.some(row=>row.id==='control_restore_001'&&row.status==='complete'));
  console.log('manager_control_runtime_test: PASS (manager authority, status, backup, check, stale plan, restore, old-client fence, durable history/idempotency)');
 }finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
