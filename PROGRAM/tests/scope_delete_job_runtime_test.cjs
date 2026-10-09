'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createMemorySuiteServer}=require('../server/server.cjs');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scope-delete-job-'));let app;
 let url,token;
 const start=async()=>{app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false});const a=await app.listen();url=`http://127.0.0.1:${a.port}`;token=(await (await fetch(url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'flashback_hayaku_bridge'}})).json()).token;};
 const request=async(route,body)=>{const r=await fetch(url+route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Memory-Suite-Plugin':'flashback_hayaku_bridge','X-Memory-Suite-Manager':'retrace'},body:JSON.stringify(body)});const value=await r.json();return {status:r.status,...value};};
 try{
  await start();
  const repo=()=>app.repositories.flashback;
  for(const id of ['a','b','c','d'])repo().mutate({kind:'set',space:'plugin',key:'vector_rag_memory:'+id,value:{id},expectedRevision:0,operationId:'seed_scope_delete_'+id});
  repo().mutate({kind:'set',space:'plugin',key:'vector_rag_memory:shared',value:['a','b','c','d'],expectedRevision:0,operationId:'seed_shared_scope_registry'});
  const scopes=['a','b','c','d'].map(id=>({namespace:'flashback',scopeId:id,scopeKey:id,kind:'chat_scope',baseClassification:'active',coverageComplete:true,members:[{space:'plugin',key:'vector_rag_memory:'+id},{space:'plugin',key:'vector_rag_memory:shared',sharedRecord:true}]}));
  assert.equal((await request('/v1/manager/scopes/index',{namespace:'flashback',scopes})).status,200);
  const plan=async id=>{const key='vector_rag_memory:'+id,row=repo().get('plugin',key),shared=repo().get('plugin','vector_rag_memory:shared');const result=await request('/v1/manager/scope-delete/plan',{jobId:'fixture_delete_job_0001',namespace:'flashback',scopeId:id,modeProof:{verified:true,modeAfter:'plugin_only',namespace:'flashback',scopeId:id},mutations:[{kind:'remove',space:'plugin',key,expectedRevision:row.revision,expectedDigest:row.digest,expectedExists:true,expectedTombstone:false},{kind:'set',space:'plugin',key:'vector_rag_memory:shared',expectedRevision:shared.revision,expectedDigest:shared.digest,expectedExists:true,expectedTombstone:false,value:shared.value.filter(x=>x!==id)}]});assert.equal(result.status,200,JSON.stringify(result));return result.result;};
  const execute=p=>request('/v1/manager/scope-delete/execute',{planId:p.planId,mutationFingerprint:p.mutationFingerprint});
  const first=await plan('a');
  assert.equal((await request('/v1/manager/scope-delete/execute',{planId:first.planId,mutationFingerprint:first.mutationFingerprint,statusOnly:true})).result.state,'prepared');
  assert.equal(repo().get('plugin','vector_rag_memory:a').exists,true,'status-only probe does not delete');
  assert.equal((await execute(first)).status,200);
  const second=await plan('b');assert.equal(second.backupId,first.backupId,'same namespace snapshot reused after own commit');
  assert.equal((await execute(second)).status,200);
  const before=repo().get('plugin','vector_rag_memory:c');repo().mutate({kind:'set',space:'plugin',key:'vector_rag_memory:c',value:{changed:true},expectedRevision:before.revision,operationId:'external_change_scope_c'});
  const third=await plan('c');assert.notEqual(third.backupId,first.backupId,'external writes require fresh backup');
  const pendingFile=path.join(dir,'migrations','scope-delete-jobs',third.planId+'.json');
  const pending=JSON.parse(fs.readFileSync(pendingFile,'utf8'));
  // Simulate process termination exactly after SQLite COMMIT, before catalog/receipt.
  repo().applyConditionalBatch(pending.mutations,{maintenance:true,operationId:third.planId});
  await app.close();await start();
  const recovered=await execute(third);assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(recovered.result.recovered,true);
  const revision=repo().get('plugin','vector_rag_memory:c').revision;
  assert.equal((await execute(third)).status,200);assert.equal(repo().get('plugin','vector_rag_memory:c').revision,revision);
  assert.equal(repo().get('plugin','vector_rag_memory:d').exists,true);
  assert.deepEqual(repo().get('plugin','vector_rag_memory:shared').value,['d'],'shared registry keeps unselected data');
  const fourth=await plan('d');
  const resetPlan=(await request('/v1/manager/reset/plan',{namespaces:['flashback']})).result;
  assert.equal((await request('/v1/manager/reset/execute',{planId:resetPlan.id,confirmation:resetPlan.confirmation,withoutBackup:true})).status,200);
  assert.equal((await execute(fourth)).status,409,'reset fences old delete plans');
  console.log('scope_delete_job_runtime_test: PASS (backup reuse, external change, atomic commit recovery, idempotency, retained scope, reset fence)');
 }finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
