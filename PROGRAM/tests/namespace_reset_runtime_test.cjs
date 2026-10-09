'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createMemorySuiteServer}=require('../server/server.cjs');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'namespace-reset-'));let app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false});
 try{
  const address=await app.listen(),url=`http://127.0.0.1:${address.port}`;
  let pluginId='flashback_hayaku_bridge';
  const call=async(route,body,token,epochs)=>{const r=await fetch(url+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Memory-Suite-Plugin':pluginId,...(token?{Authorization:'Bearer '+token}:{}),...(epochs?{'X-Memory-Suite-Reset-Epochs':JSON.stringify(epochs)}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
  const manager=(await call('/bootstrap')).data.token;
  app.repositories.hayaku.mutate({kind:'set',space:'plugin',key:'hayaku.test',value:{old:true},operationId:'reset_fixture_000001',expectedRevision:0});
  app.repositories.libra.mutate({kind:'set',space:'plugin',key:'libra.test',value:{keep:true},operationId:'reset_fixture_000002',expectedRevision:0});
  const catalogFile=path.join(dir,'config','scope-catalog.json');
  fs.writeFileSync(catalogFile,JSON.stringify({schema:'memory-suite.scope-catalog.v1',namespaces:{hayaku:{fixture:true},libra:{keep:true}}}));
  const planned=await call('/v1/manager/reset/plan',{namespaces:['hayaku']},manager);assert.equal(planned.status,200);
  const plan=planned.data.result;
  assert.notEqual((await call('/v1/manager/reset/execute',{planId:plan.id,confirmation:'wrong'},manager)).status,200);
  const reset=await call('/v1/manager/reset/execute',{planId:plan.id,confirmation:plan.confirmation},manager);assert.equal(reset.status,200,JSON.stringify(reset));assert.ok(reset.data.result.backupId);
  assert.equal(app.repositories.hayaku.get('plugin','hayaku.test').exists,false);
  assert.equal(app.repositories.libra.get('plugin','libra.test').exists,true);
  for(const file of [catalogFile,path.join(dir,'config','scope-catalog.previous.json')]){
    const catalog=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(catalog.namespaces.hayaku,undefined);assert.equal(catalog.namespaces.libra.keep,true);
  }
  pluginId='hayaku_locator_continuity';const owner=(await call('/bootstrap')).data.token;
  const body={namespace:'hayaku',space:'plugin',key:'hayaku.test',value:{new:true},operationId:'reset_fixture_000003',expectedRevision:0};
  assert.equal((await call('/v1/kv/set',body,owner)).status,409,'old clients cannot reupload');
  assert.equal((await call('/v1/kv/set',body,owner,{hayaku:1})).status,200,'explicit current generation accepted');
  await app.close();app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false});
  const a=await app.listen();const r=await fetch(`http://127.0.0.1:${a.port}/bootstrap`,{headers:{'X-Memory-Suite-Plugin':'hayaku_locator_continuity'}});assert.equal((await r.json()).resetEpochs.hayaku,1);
  console.log('namespace_reset_runtime_test: PASS (backup, confirmation, isolation, old-client fence, restart)');
 }finally{await app.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});

