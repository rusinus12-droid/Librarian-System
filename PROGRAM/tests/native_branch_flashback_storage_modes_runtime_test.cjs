'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createMemorySuiteServer}=require('../server/server.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {clone,parent,branch}=require('./fixtures/native_branch_fixture.cjs');
const MODE=['plugin_only','server_only'].includes(process.env.NATIVE_BRANCH_MODE)?process.env.NATIVE_BRANCH_MODE:'server_only';

(async()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'fb-native-storage-'));
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
 const address=await app.listen();
 const f=await createFixture({exposeStorageBridge:true,arguments:{memory_suite_server_url:`http://127.0.0.1:${address.port}`},nativeFetch:fetch});
 try{
  const bridge=f.context.__fixtureStorageBridge;assert.ok(bridge,'fixture storage bridge exposed');
  const t=f.api._test,p=parent('fb-parent-server',8);Object.assign(f.currentChat,p);f.character.chats=[f.currentChat];
  const snapshot=chat=>({character:clone(f.character),chat:clone(chat),db:{personas:[],selectedPersona:''},chatInfo:{characterIndex:0,chatIndex:0}});
  const from=t.resolveScopeFromSnapshot(snapshot(f.currentChat));const cfg=t.normalizeSettings({embeddingProvider:'hash',hashDimensions:8,shardSize:50});
  const parentStorageScope={scopeId:from.scopeKey,scopeKey:from.scopeKey,characterId:from.characterId,chatId:from.chatId,aliases:[from.scopeKey,from.storageHash,from.chatId].filter(Boolean)};
  await bridge.setScopeMode(parentStorageScope,MODE);
  const records=[];for(let i=1;i<=8;i++){
   const r=t.cleanRecordForMemory({id:'record-'+i,sourceType:'response',sourceId:`${p.id}:turn:${i}`,text:`User:\nUser ${i}\n\n---\n\nAssistant:\nAssistant ${i}`,title:'Turn '+i,scopeKey:from.scopeKey,pairIndex:i,turnIndex:i,tags:[],tokenCount:8,tokens:8,vector:[1,0,0,0,0,0,0,0],dim:8,provider:'hash',model:'hash-8',embeddingProvider:'hash',embeddingModel:'hash-8',embeddingDimensions:8,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),lifecycleStatus:'active',sourceHash:'turn-'+i},from,{authoritativeSource:true}).record;
   assert.ok(r);records.push(r);
  }
  await t.saveAllRecords(records,cfg,from);
  const parentManifest=await t.loadScopeManifest(from);assert.ok(parentManifest?.commitId);
  const child=branch(clone(f.currentChat),5,'fb-child-server');Object.assign(f.currentChat,child);f.character.chats=[f.currentChat,p];
  const to=t.resolveScopeFromSnapshot(snapshot(f.currentChat));
  const childStorageScope={scopeId:to.scopeKey,scopeKey:to.scopeKey,characterId:to.characterId,chatId:to.chatId,aliases:[to.scopeKey,to.storageHash,to.chatId].filter(Boolean)};
  const before=await bridge.getScopeMode(childStorageScope);assert.equal(before.mode,'plugin_only');assert.equal(before.explicit,false);
  const localScopeKeyCountBefore=(await f.pluginStorage.keys()).filter(k=>String(k).startsWith('vector_rag_memory:scope:')).length;
  const copied=await t.cloneScopeStorage(from,to,cfg,{mode:'chat_copy_live',reason:'native_branch_storage_mode_test'});
  assert.equal(copied.ok,true,JSON.stringify(copied));
  const after=await bridge.getScopeMode(childStorageScope);assert.equal(after.mode,MODE,'child must inherit parent storage mode');
  const loaded=await t.loadScopeRecords(to);assert.equal(loaded.records.length,5);
  const localKeys=await f.pluginStorage.keys();
  const localScopeKeyCountAfter=localKeys.filter(k=>String(k).startsWith('vector_rag_memory:scope:')).length;
  if(MODE==='server_only')assert.equal(localScopeKeyCountAfter,localScopeKeyCountBefore,'server-only child scope data must not be local');
  else assert.ok(localScopeKeyCountAfter>localScopeKeyCountBefore,'plugin/mirror child scope data must remain local');
  console.log(JSON.stringify({test:'native_branch_flashback_storage_modes_runtime',passed:8,mode:after.mode}));
 } finally {await f.dispose();await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
