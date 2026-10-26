'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMemorySuiteServer}=require('../server/server.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
async function fixture(mode){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fb-targets-'));const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false});
 const url='http://127.0.0.1:'+(await app.listen()).port;
 let f;try{
 const source=fs.readFileSync(require.resolve('../plugins/Flashback_Memory.js'),'utf8').replace('_test: { maintenanceResultText,','_test: { Runtime,listScopeDeletionPreviewRows,maintenanceResultText,');
 f=await createFixture({source,exposeStorageBridge:true,arguments:{memory_suite_server_url:url},nativeFetch:(...args)=>fetch(...args)});
 const b=f.context.__fixtureStorageBridge,t=f.api._test;t.Runtime.nativeCopyObserver.running=false;
 await f.api.saveSettings({...await f.api.loadSettings(),embeddingAutoProcess:false,episodeIndexEnabled:false});
 const target=(await t.resolveCurrentScopeIdentityBundle(false)).scope;
 const record={id:'r',hash:'r',sourceType:'response',type:'response',text:'Keep the original',dim:4,vector:[1,0,0,0]};
 await t.saveAllRecords([record],null,target);
 await b.getConnectionSettings({force:true});await b.setScopeMode({scopeId:target.scopeKey,scopeKey:target.scopeKey},'server_only');
 await t.saveAllRecords([record],null,target);
 // Seed matching retained copies without invoking a second source migration.
 for(const [space,store]of [['plugin',f.pluginStorage],['local',f.host.safeLocalStorage]]){
  for(const key of [...store.values.keys()])if(key.startsWith('vector_rag_memory:scope:')||key.startsWith('vector_rag_memory:local-vector-shard:'))store.values.delete(key);
  for(const row of app.repositories.flashback.list(space,'').records)if(!row.tombstone&&(row.key.startsWith('vector_rag_memory:scope:')||row.key.startsWith('vector_rag_memory:local-vector-shard:')||row.key==='vector_rag_memory:scope_registry:v2'))store.values.set(row.key,app.repositories.flashback.get(space,row.key).value);
 }
 if(mode==='plugin_only')await b.setScopeMode({scopeId:target.scopeKey,scopeKey:target.scopeKey},mode);
 const key=[...f.pluginStorage.values.keys()].find(k=>k.endsWith(':manifest:v2')&&JSON.parse(f.pluginStorage.values.get(k)).scopeKey===target.scopeKey);
 assert.ok(key);assert.equal(app.repositories.flashback.get('plugin',key).exists,true);
 f.currentChat.id=f.currentChat.chatId='another';f.currentChat.name='Another';f.currentChat.message=[];await t.resolveCurrentScopeIdentityBundle(false);
 const c=await b.getConnectionSettings({force:true});await b.setScopeMode(c.scope,mode);
 return {f,b,t,app,target,key,close:async()=>{await f.dispose();await app.close();fs.rmSync(dir,{recursive:true,force:true});}};
 }catch(error){await f?.dispose();await app.close();fs.rmSync(dir,{recursive:true,force:true});throw error;}
}
if(require.main===module)(async()=>{
 for(const mode of ['plugin_only','server_only'])for(const deleteTarget of ['local','server','both']){
  const x=await fixture(mode);try{
   const routeKey='__memory_suite_internal_scope_routes_v1__:flashback',route=await x.f.pluginStorage.getItem(routeKey);
   const preview=await x.t.listScopeDeletionPreviewRows(deleteTarget),row=preview.find(row=>row.scopeKey===x.target.scopeKey);
   assert.ok(row,'selected physical location is discoverable in either source mode');
   if(deleteTarget!=='server')assert.equal(row.localPreviewCount,1);
   if(deleteTarget!=='local')assert.equal(row.serverPreviewCount,1);
   const markup=await x.t.buildUiHtml();assert.match(markup,/id="storageDeleteTarget"/);for(const label of ['로컬 데이터 삭제','서버 데이터 삭제','둘 다 삭제'])assert.ok(markup.includes(label));
   const result=await x.f.api.deleteSelectedScopeStorages([x.target.scopeKey],{deleteTarget});
   assert.equal(result.deleted,1,JSON.stringify(result));assert.equal(result.failed,0,JSON.stringify(result));
   assert.equal(await x.f.pluginStorage.getItem(x.key)!=null,deleteTarget==='server');
   assert.equal(x.app.repositories.flashback.get('plugin',x.key).exists,deleteTarget==='local');
   assert.equal(await x.f.pluginStorage.getItem(routeKey),route);
   assert.equal((await x.b.getScopeMode({scopeId:x.target.scopeKey,scopeKey:x.target.scopeKey})).mode,mode);
   console.log('flashback '+mode+' '+deleteTarget+': PASS');
  }finally{await x.close();}
 }
 for(const mode of ['plugin_only','server_only'])for(const firstTarget of ['local','server']){
  const x=await fixture(mode);try{
   assert.equal((await x.f.api.deleteSelectedScopeStorages([x.target.scopeKey],{deleteTarget:firstTarget})).deleted,1);
   const result=await x.f.api.deleteSelectedScopeStorages([x.target.scopeKey],{deleteTarget:'both'});
   assert.equal(result.deleted,1,JSON.stringify(result));assert.equal(result.failed,0);
   assert.equal(await x.f.pluginStorage.getItem(x.key),null);assert.equal(x.app.repositories.flashback.get('plugin',x.key).exists,false);
   assert.equal((await x.b.getScopeMode({scopeId:x.target.scopeKey,scopeKey:x.target.scopeKey})).mode,mode);
   console.log('flashback '+mode+' both with '+firstTarget+' already empty: PASS');
  }finally{await x.close();}
 }
 for(const mode of ['plugin_only','server_only'])for(const deleteTarget of ['local','server']){
  const x=await fixture(mode);try{
   if(deleteTarget==='local')x.f.host.nativeFetch=async()=>{throw Error('SERVER_OFFLINE');};
   else x.f.pluginStorage.setItem=x.f.pluginStorage.removeItem=async()=>{throw Error('LOCAL_STORAGE_WRITE_UNAVAILABLE');};
   const result=await x.f.api.deleteSelectedScopeStorages([x.target.scopeKey],{deleteTarget});assert.equal(result.deleted,1,JSON.stringify(result));
   assert.equal(await x.f.pluginStorage.getItem(x.key)!=null,deleteTarget==='server');assert.equal(x.app.repositories.flashback.get('plugin',x.key).exists,deleteTarget==='local');
   assert.equal((await x.b.getScopeMode({scopeId:x.target.scopeKey,scopeKey:x.target.scopeKey})).mode,mode);
   console.log('flashback '+mode+' '+deleteTarget+' with other location unavailable: PASS');
  }finally{await x.close();}
 }
 for(const mode of ['plugin_only','server_only'])for(const deleteTarget of ['local','server','both']){
  const x=await fixture(mode);try{
   x.f.currentChat.id=x.f.currentChat.chatId=x.target.chatId;await x.t.resolveCurrentScopeIdentityBundle(false);
   const result=await x.f.api.deleteScopeStorage(x.target.scopeKey,{deleteTarget,protectCurrent:false});assert.equal(result.deleted,true);
   assert.equal(await x.f.pluginStorage.getItem(x.key)!=null,deleteTarget==='server');assert.equal(x.app.repositories.flashback.get('plugin',x.key).exists,deleteTarget==='local');
   assert.equal((await x.b.getScopeMode({scopeId:x.target.scopeKey,scopeKey:x.target.scopeKey})).mode,mode);
   console.log('flashback '+mode+' confirmed current scope '+deleteTarget+': PASS');
  }finally{await x.close();}
 }
 for(const mode of ['plugin_only','server_only']){
  const x=await fixture(mode);try{
   const remove=x.f.pluginStorage.removeItem.bind(x.f.pluginStorage);
   x.f.pluginStorage.removeItem=async key=>key===x.key?false:remove(key);
   const result=await x.f.api.deleteSelectedScopeStorages([x.target.scopeKey],{deleteTarget:'both'});
   assert.equal(result.failed,1);assert.equal(result.partial,1,JSON.stringify(result));
   assert.equal(x.app.repositories.flashback.get('plugin',x.key).exists,false);
   assert.ok(await x.f.pluginStorage.getItem(x.key));
   assert.equal((await x.b.getScopeMode({scopeId:x.target.scopeKey,scopeKey:x.target.scopeKey})).mode,mode);
   console.log('flashback '+mode+' partial failure: PASS');
  }finally{await x.close();}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});

module.exports={fixture};
