'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createMemorySuiteServer}=require('../server/server.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reset-owner-'));const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false});let f;
 try{
  const address=await app.listen(),url=`http://127.0.0.1:${address.port}`;
  const options={exposeStorageBridge:true,arguments:{memory_suite_server_mode:'mirror',memory_suite_server_url:url},nativeFetch:(u,i)=>fetch(u,i)};
  f=await createFixture(options);const scope=await f.api.resolveCurrentScope();
  await f.api._test.saveAllRecords([{id:'old-memory',hash:'old-memory',sourceType:'response',text:'OLD_LOCAL_MEMORY',vector:[1,0],dim:2}],null,scope);
  const store=f.pluginStorage;
  const boot=await (await fetch(url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'flashback_hayaku_bridge'}})).json();
  const call=async(route,body)=>{const r=await fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json','X-Memory-Suite-Plugin':'flashback_hayaku_bridge',Authorization:'Bearer '+boot.token},body:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data.result;};
  const plan=await call('/v1/manager/reset/plan',{namespaces:['flashback']});await call('/v1/manager/reset/execute',{planId:plan.id,confirmation:plan.confirmation,withoutBackup:true});
  await f.context.__fixtureStorageBridge.acceptServerReset('empty');
  await assert.rejects(()=>f.context.__fixtureStorageBridge.serverKeys('plugin',''),/새로고침/);
  await f.dispose();f=await createFixture({...options,pluginStorage:store});
  const current=await f.api.resolveCurrentScope();const loaded=await f.api._test.loadScopeRecords(current.scopeKey);
  assert.equal(loaded.records.length,0,'old local memory must not repopulate reset server');
  assert.equal(await f.context.__fixtureStorageBridge.getMode(),'server_only');
  assert.ok([...store.values.values()].some(v=>JSON.stringify(v).includes('OLD_LOCAL_MEMORY')),'local old memory retained');
  console.log('reset_owner_reconnect_test: PASS (reload barrier, empty server, retained local data)');
 }finally{await f?.dispose();await app.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
