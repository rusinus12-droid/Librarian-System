'use strict';
// R01: an already-adopted 0.3.57 legacy child (copyAdoptedComplete=true, implicit
// plugin_only storage) must receive the corrected storage policy when the parent
// later becomes server_only. Content readiness must not skip storage-policy
// migration, and migration must be non-destructive and idempotent.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createMemorySuiteServer}=require('../server/server.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {clone,parent,branch}=require('./fixtures/native_branch_fixture.cjs');

(async()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'fb-native-legacy-child-'));
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
 const address=await app.listen();
 const f=await createFixture({exposeStorageBridge:true,arguments:{memory_suite_server_url:`http://127.0.0.1:${address.port}`},nativeFetch:fetch});
 try{
  const bridge=f.context.__fixtureStorageBridge;assert.ok(bridge,'fixture storage bridge exposed');
  const t=f.api._test,p=parent('fb-parent-legacy',8);Object.assign(f.currentChat,p);f.character.chats=[f.currentChat];
  const snapshot=chat=>({character:clone(f.character),chat:clone(chat),db:{personas:[],selectedPersona:''},chatInfo:{characterIndex:0,chatIndex:0}});
  const from=t.resolveScopeFromSnapshot(snapshot(f.currentChat));
  const cfg=t.normalizeSettings({embeddingProvider:'hash',hashDimensions:8,shardSize:50});
  const records=[];
  for(let i=1;i<=8;i++){
   const r=t.cleanRecordForMemory({id:'record-'+i,sourceType:'response',sourceId:`${p.id}:turn:${i}`,text:`User:\nUser ${i}\n\n---\n\nAssistant:\nAssistant ${i}`,title:'Turn '+i,scopeKey:from.scopeKey,pairIndex:i,turnIndex:i,tags:[],tokenCount:8,tokens:8,vector:[1,0,0,0,0,0,0,0],dim:8,provider:'hash',model:'hash-8',embeddingProvider:'hash',embeddingModel:'hash-8',embeddingDimensions:8,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),lifecycleStatus:'active',sourceHash:'turn-'+i},from,{authoritativeSource:true}).record;
   assert.ok(r);records.push(r);
  }
  await t.saveAllRecords(records,cfg,from);

  // Step 1: 0.3.57-equivalent path runs while the parent is still plugin_only.
  const parentSnapshot=clone(f.currentChat);
  const child=branch(parentSnapshot,5,'fb-child-legacy');Object.assign(f.currentChat,child);f.character.chats=[f.currentChat,parentSnapshot];
  const to=t.resolveScopeFromSnapshot(snapshot(f.currentChat));
  const childStorageScope={scopeId:to.scopeKey,scopeKey:to.scopeKey,characterId:to.characterId,chatId:to.chatId,aliases:[to.scopeKey,to.storageHash,to.chatId].filter(Boolean)};
  const parentStorageScope={scopeId:from.scopeKey,scopeKey:from.scopeKey,characterId:from.characterId,chatId:from.chatId,aliases:[from.scopeKey,from.storageHash,from.chatId].filter(Boolean)};
  const copied=await t.cloneScopeStorage(from,to,cfg,{mode:'chat_copy_live',reason:'legacy_child_0357'});
  assert.equal(copied.ok,true,JSON.stringify(copied));
  const adoptedManifest=await t.loadScopeManifest(to);
  assert.equal(adoptedManifest.copyAdoptedComplete,true,'legacy child already adopted');

  // Step 2: parent becomes server_only after the child was adopted.
  await bridge.setScopeMode(parentStorageScope,'server_only');

  // Step 3/4: the child remains implicit plugin_only.
  const before=await bridge.getScopeMode(childStorageScope);
  assert.equal(before.mode,'plugin_only','legacy child mode stays implicit plugin_only');

  const recordsBefore=JSON.stringify((await t.loadScopeRecords(to)).records);
  const parentDigestBefore=(await t.loadScopeManifest(from)).commitId;

  // Step 5: re-open with the new code. Content is already ready, but the storage
  // policy must still be reconciled before the fast return.
  const ready=await t.ensureScopeStorageReady(to,cfg);
  assert.equal(ready.fastPath,true,'content-ready path still fast-paths record cloning');

  const after=await bridge.getScopeMode(childStorageScope);
  assert.equal(after.mode,'server_only','legacy adopted child must inherit corrected storage policy');

  const manifestAfter=await t.loadScopeManifest(to);
  const storageBinding=manifestAfter.nativeBranchCopy?.storageBinding||null;
  assert.ok(storageBinding,'migration receipt must be persisted');
  assert.equal(storageBinding.targetModeOrigin,'migrated');
  assert.equal(storageBinding.migration?.migrated,true);
  assert.equal(storageBinding.migration?.retainedLocal,true);

  assert.equal(JSON.stringify((await t.loadScopeRecords(to)).records),recordsBefore,'records unchanged after policy migration');
  assert.equal((await t.loadScopeManifest(from)).commitId,parentDigestBefore,'parent digest unchanged');
  const localChildKeys=(await f.pluginStorage.keys()).filter(k=>String(k).startsWith('vector_rag_memory:scope:')&&String(k).includes(String(to.storageHash||'')));
  assert.ok(localChildKeys.length>0,'retained local bytes preserved non-destructively');

  // Idempotency: a second reconciliation must not create another migration layer.
  const readyAgain=await t.ensureScopeStorageReady(to,cfg);
  const manifestAgain=await t.loadScopeManifest(to);
  assert.equal(manifestAgain.nativeBranchCopy?.storageBinding?.targetModeOrigin,'migrated');
  assert.equal(JSON.stringify((await t.loadScopeRecords(to)).records),recordsBefore,'records unchanged on repeat');
  const localChildKeysAgain=(await f.pluginStorage.keys()).filter(k=>String(k).startsWith('vector_rag_memory:scope:')&&String(k).includes(String(to.storageHash||'')));
  assert.equal(localChildKeysAgain.length,localChildKeys.length,'no duplicate local migration layer');

  assert.equal(readyAgain.fastPath,true);
  console.log(JSON.stringify({test:'native_branch_flashback_legacy_child_migration',passed:12,origin:storageBinding.targetModeOrigin}));
 } finally {await f.dispose();await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
