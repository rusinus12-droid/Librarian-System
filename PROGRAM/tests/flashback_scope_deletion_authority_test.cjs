'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {test}=require('node:test');
const {createMemorySuiteServer}=require('../server/server.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const registryKey='vector_rag_memory:scope_registry:v2';
const raw=fs.readFileSync(process.env.FLASHBACK_SCOPE_SOURCE||path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8');
const source=raw.replace('_test: { maintenanceResultText,','_test: { Runtime,classifyScopeForManagement,cleanupSelectedScopeStorages,scopeKeys,maintenanceResultText,');
const parse=value=>typeof value==='string'?JSON.parse(value):value;
async function fixture(t,activeMode='server_only'){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fb-delete-authority-'));
  const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false});
  const url='http://127.0.0.1:'+(await app.listen()).port;
  const wire=[];let f;
  t.after(async()=>{await f?.dispose();await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  f=await createFixture({source,exposeStorageBridge:true,arguments:{memory_suite_server_url:url},nativeFetch:async(u,i)=>{wire.push({method:i?.method||'GET',route:new URL(String(u)).pathname});return fetch(u,i);}});
  const b=f.context.__fixtureStorageBridge,a=f.api,tb=a._test;
  tb.Runtime.nativeCopyObserver.running=false;
  const c=await b.getConnectionSettings({force:true});await b.setScopeMode(c.scope,'server_only');
  const target=(await tb.resolveCurrentScopeIdentityBundle(false)).scope;
  await tb.saveAllRecords([{id:'original',hash:'original',type:'response',sourceType:'response',text:'Stored original that must survive server cleanup.',dim:4,vector:[1,0,0,0]}],null,target);
  const manifestKey=tb.scopeKeys.manifest(target.scopeKey);
  f.currentChat.id='other';f.currentChat.chatId='other';f.currentChat.name='Other';await tb.resolveCurrentScopeIdentityBundle(false);
  const next=await b.getConnectionSettings({force:true});await b.setScopeMode(next.scope,activeMode);
  const active=(await tb.resolveCurrentScopeIdentityBundle(false)).scope;
  const token=(await(await fetch(url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'flashback_hayaku_bridge'}})).json()).token;
  const manager=async(method,route,body)=>{
    const r=await fetch(url+route,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Memory-Suite-Plugin':'flashback_hayaku_bridge','X-Memory-Suite-Manager':'retrace'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:r.status,payload:await r.json()};
  };
  return {f,b,a,tb,app,dir,wire,manager,target,active,manifestKey};
}
for(const mode of ['server_only','plugin_only'])test('all owner deletion entries preserve server target with active '+mode,async t=>{
  const {a,tb,b,target,manifestKey,wire,app,f}=await fixture(t,mode);
  const before=app.repositories.flashback.get('plugin',manifestKey),registry=await f.pluginStorage.getItem(registryKey),at=wire.length;
  const classified=await tb.classifyScopeForManagement(target.scopeKey);
  assert.equal(classified.kind,'server_managed');assert.equal(classified.storageMode,'server_only');
  const result=await a.deleteSelectedScopeStorages([target.scopeKey]);
  assert.equal(result.deleted,0);assert.equal(result.protected,1);assert.match(result.protectedReasons.join(' '),/RE:TRACE.*서버 데이터 관리/);
  await assert.rejects(()=>a.deleteScopeStorage(target.scopeKey),/FLASHBACK_SERVER_SCOPE_MANAGEMENT_REQUIRED/);
  await assert.rejects(()=>a.removeVerifiedRegistryOnlyScope(target.scopeKey),/FLASHBACK_SERVER_SCOPE_MANAGEMENT_REQUIRED/);
  assert.equal((await tb.cleanupSelectedScopeStorages([target.scopeKey])).cleaned,0);
  assert.equal(app.repositories.flashback.get('plugin',manifestKey).digest,before.digest);
  assert.equal(app.repositories.flashback.get('plugin',manifestKey).revision,before.revision);
  assert.equal(await f.pluginStorage.getItem(registryKey),registry,'local list remains intact');
  assert.equal((await b.getScopeMode({scopeId:target.scopeKey})).mode,'server_only');
  assert(!wire.slice(at).some(row=>row.method==='POST'&&/^\/v1\/(kv|flashback\/writer)/.test(row.route)),'no server mutation');
});
test('manager pin/reference guards cannot be bypassed through the owner API',async t=>{
  const {manager,target,active,manifestKey,app,a}=await fixture(t);
  const scopes=[target,active].map((scope,i)=>({namespace:'flashback',scopeId:scope.scopeKey,scopeKey:scope.scopeKey,kind:'chat_scope',baseClassification:i?'active':'orphan_candidate',coverageComplete:true,links:i?[{targetRef:target.scopeKey,kind:'predecessor'}]:[],members:i?[]:[{space:'plugin',key:manifestKey}]}));
  assert.equal((await manager('POST','/v1/manager/scopes/index',{namespace:'flashback',scopes})).status,200);
  await manager('POST','/v1/manager/scope-pin',{namespace:'flashback',scopeId:target.scopeKey,pinned:true});
  const before=app.repositories.flashback.get('plugin',manifestKey);
  const body={namespace:'flashback',scopeId:target.scopeKey,modeProof:{namespace:'flashback',verified:true,modeAfter:'plugin_only'},inventoryProof:{hostInventoryStable:true,complete:true},mutations:[{kind:'remove',space:'plugin',key:manifestKey,expectedRevision:before.revision,expectedDigest:before.digest,expectedExists:true,expectedTombstone:false}]};
  const pinned=await manager('POST','/v1/manager/scope-delete/plan',body);assert.equal(pinned.status,409);assert.match(pinned.payload.error,/pinned/);
  await manager('POST','/v1/manager/scope-pin',{namespace:'flashback',scopeId:target.scopeKey,pinned:false});
  const referenced=await manager('POST','/v1/manager/scope-delete/plan',body);assert.equal(referenced.status,409);assert.match(referenced.payload.error,/referenced_ancestor/);
  await manager('POST','/v1/manager/scope-pin',{namespace:'flashback',scopeId:target.scopeKey,pinned:true});
  assert.equal((await a.deleteSelectedScopeStorages([target.scopeKey])).deleted,0);
  await assert.rejects(()=>a.deleteScopeStorage(target.scopeKey),/FLASHBACK_SERVER_SCOPE_MANAGEMENT_REQUIRED/);
  assert.equal(app.repositories.flashback.get('plugin',manifestKey).digest,before.digest);
  const row=(await manager('GET','/v1/manager/scopes')).payload.result.scopes.find(row=>row.scopeId===target.scopeKey);
  assert.equal(row.pinned,true);assert.equal(row.referenceCount,1);
});
for(const mode of ['mirror','unrecognized_mode'])test('legacy or unverified target mode cannot grant local deletion: '+mode,async t=>{
  const {f,a,tb,target,app,manifestKey}=await fixture(t,'plugin_only');
  let changed=0;
  for(const store of [f.pluginStorage,await f.host.getLocalPluginStorage()])for(const [key,raw] of store.values){
    let value;try{value=parse(raw);}catch{continue;}
    if(value?.schema!=='memory-suite.scope-routing.v1'||!value.entries?.[target.scopeKey])continue;
    value.entries[target.scopeKey].mode=mode;store.values.set(key,JSON.stringify(value));changed++;
  }
  assert(changed>0,'actual persisted authority rows changed');
  const before=app.repositories.flashback.get('plugin',manifestKey);
  const result=await a.deleteSelectedScopeStorages([target.scopeKey]);assert.equal(result.deleted,0);
  assert.equal((await tb.cleanupSelectedScopeStorages([target.scopeKey])).cleaned,0);
  await assert.rejects(()=>a.deleteScopeStorage(target.scopeKey));
  assert.equal(app.repositories.flashback.get('plugin',manifestKey).digest,before.digest);
});
test('an inactive local target is protected while the active owner proxy follows a server scope',async t=>{
  const {a,b,target,app,manifestKey,f}=await fixture(t);
  await b.prepareServerScopeDeletion({scopeId:target.scopeKey,scopeKey:target.scopeKey});
  const local=await f.pluginStorage.getItem(manifestKey),remote=app.repositories.flashback.get('plugin',manifestKey);
  assert.equal((await b.getScopeMode({scopeId:target.scopeKey})).mode,'plugin_only');
  const result=await a.deleteSelectedScopeStorages([target.scopeKey]);assert.equal(result.deleted,0);
  assert.equal(await f.pluginStorage.getItem(manifestKey),local);
  assert.equal(app.repositories.flashback.get('plugin',manifestKey).digest,remote.digest);
});
test('real owner restore plus manager commit retains local original and pre-delete backup',async t=>{
  const {manager,target,manifestKey,app,b,tb,f,dir}=await fixture(t);
  const modeProof=await b.prepareServerScopeDeletion({scopeId:target.scopeKey,scopeKey:target.scopeKey});
  assert.equal(modeProof.verified,true);assert.equal(modeProof.modeAfter,'plugin_only');
  assert.equal(parse(await f.pluginStorage.getItem(manifestKey)).count,1);
  const registry=app.repositories.flashback.get('plugin',registryKey),value=parse(registry.value),meta=value.scopes.find(row=>row.scopeKey===target.scopeKey);assert(meta?.storageHash);
  const prefix='vector_rag_memory:scope:'+meta.storageHash+':',vectorPrefix='vector_rag_memory:local-vector-shard:v1:'+meta.storageHash+':';
  const unique=[...app.repositories.flashback.list('plugin',prefix).records,...app.repositories.flashback.list('local',vectorPrefix).records];
  const members=[...unique.map(row=>({space:row.space,key:row.key})),{space:'plugin',key:registryKey,sharedRecord:true}];
  const scope={namespace:'flashback',scopeId:target.scopeKey,scopeKey:target.scopeKey,kind:'chat_scope',baseClassification:'orphan_candidate',coverageComplete:true,members};
  assert.equal((await manager('POST','/v1/manager/scopes/index',{namespace:'flashback',scopes:[scope]})).status,200);
  const mutations=unique.map(row=>({kind:'purge',space:row.space,key:row.key,expectedRevision:row.revision,expectedDigest:row.digest,expectedExists:!row.tombstone,expectedTombstone:row.tombstone}));
  const next={...value,scopes:value.scopes.filter(row=>row.scopeKey!==target.scopeKey)};
  mutations.push({kind:'set',space:'plugin',key:registryKey,expectedRevision:registry.revision,expectedDigest:registry.digest,expectedExists:true,expectedTombstone:false,value:typeof registry.value==='string'?JSON.stringify(next):next});
  const planned=await manager('POST','/v1/manager/scope-delete/plan',{namespace:'flashback',scopeId:target.scopeKey,modeProof,inventoryProof:{hostInventoryStable:true,complete:true},mutations});assert.equal(planned.status,200,JSON.stringify(planned.payload));
  const plan=planned.payload.result;assert(plan.backupId&&plan.conditionsVerified);assert(fs.existsSync(path.join(dir,'backups','deleted-scopes',plan.backupId,'flashback.sqlite')));
  await b.prepareServerScopeDeletion({scopeId:target.scopeKey,scopeKey:target.scopeKey});
  const executed=await manager('POST','/v1/manager/scope-delete/execute',{planId:plan.planId,mutationFingerprint:plan.mutationFingerprint});assert.equal(executed.status,200,JSON.stringify(executed.payload));
  assert.equal(app.repositories.flashback.get('plugin',manifestKey).exists,false);assert.equal(app.repositories.flashback.list('plugin',prefix).keys.length,0);
  assert.equal(parse(await f.pluginStorage.getItem(manifestKey)).count,1);
  f.currentChat.id=target.chatId;f.currentChat.chatId=target.chatId;await tb.resolveCurrentScopeIdentityBundle(false);
  const local=await tb.loadScopeRecords(target.scopeKey);assert.equal(local.records.length,1);assert.equal(local.records[0].text,'Stored original that must survive server cleanup.');
  assert.equal((await b.getScopeMode({scopeId:target.scopeKey})).mode,'plugin_only');
});
