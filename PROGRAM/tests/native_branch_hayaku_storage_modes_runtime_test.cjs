'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createMemorySuiteServer}=require('../server/server.cjs');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const {clone,branch}=require('./fixtures/native_branch_fixture.cjs');
const MODE=['plugin_only','server_only'].includes(process.env.NATIVE_BRANCH_MODE)?process.env.NATIVE_BRANCH_MODE:'server_only';
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hayaku-native-storage-'));
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:path.join(root,'DATA'),autoBackup:false});const address=await app.listen();const url=`http://127.0.0.1:${address.port}`;
 const sourceCode=fs.readFileSync(path.join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8').replace('        updateRecoveryJournalBackgroundDecision,','        storageBridgeForHostTest:MemorySuiteStorageBridge,\n        updateRecoveryJournalBackgroundDecision,');
 const pluginFile=path.join(root,'HAYAKU-host-test.js');fs.writeFileSync(pluginFile,sourceCode);
 const messages=[];for(let i=1;i<=7;i++)messages.push({role:'user',chatId:'u'+i,data:'User '+i},{role:'char',chatId:'a'+i,data:hiddenPacketMessage('Alice waited '+i+'.',createValidPacket({turn:i,subject:'Alice',scene:'office',summary:'Alice waited '+i+'.'}))});
 const f=await createHayakuRuntime({autoRepair:false,pluginSourceFile:pluginFile,messages,chatId:'hayaku-parent-server',arguments:{memory_suite_server_url:url},nativeFetch:async(u,i)=>fetch(u,i)});
 try{
  const t=f.hayaku._test,b=t.storageBridgeForHostTest;assert.ok(b);
  const parentScope=await t.currentChatScope();await b.setScopeMode({scopeId:parentScope.key,scopeKey:parentScope.key,characterId:parentScope.characterId,chatId:parentScope.chatId,aliases:[parentScope.key,parentScope.chatId],label:parentScope.chatId},MODE);
  await t.reconcileObservedChatTopology(parentScope,t.authoritativeChatSnapshot(parentScope.chatMessages,parentScope),'native_branch_parent_server_fixture');
  const parentMode=await b.getScopeMode({scopeId:parentScope.key,scopeKey:parentScope.key,characterId:parentScope.characterId,chatId:parentScope.chatId,aliases:[parentScope.key,parentScope.chatId]});assert.equal(parentMode.mode,MODE);
  const p=clone(f.chat),child=branch(p,5,'hayaku-child-server');Object.assign(f.chat,child);f.chat.messages=f.chat.message;f.character.chats=[f.chat,p];
  const target=await t.currentChatScope();assert.equal(target.hostLineage.inheritanceEligible,true,JSON.stringify(target.hostLineage));
  await t.reconcileObservedChatTopology(target,t.authoritativeChatSnapshot(target.chatMessages,target),'native_branch_child_server_fixture');
  const childDescriptor={scopeId:target.key,scopeKey:target.key,characterId:target.characterId,chatId:target.chatId,aliases:[target.key,target.chatId],label:target.chatId};
  const childMode=await b.getScopeMode(childDescriptor);assert.equal(childMode.mode,MODE,'HAYAKU child must inherit parent storage mode');
  const localKey=`hayaku.v2.ledger.${target.key}`;const localLedger=await f.pluginStorage.getItem(localKey);if(MODE==='server_only')assert.equal(localLedger,null,'server-only child ledger must not be local');else assert.notEqual(localLedger,null,'plugin/mirror child ledger must remain local');
  const ledger=await f.hayaku.ledger.inspect({includeRecords:true});assert.ok(ledger.records.length>0,'child transcript packets remain available');
  console.log(JSON.stringify({test:'native_branch_hayaku_storage_modes_runtime',passed:7,mode:childMode.mode,records:ledger.records.length}));
 }finally{await f.dispose();await app.close();fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
