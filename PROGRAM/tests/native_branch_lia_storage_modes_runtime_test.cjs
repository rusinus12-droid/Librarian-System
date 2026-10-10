'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createMemorySuiteServer}=require('../server/server.cjs');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
const {clone,branch}=require('./fixtures/native_branch_fixture.cjs');
const MODE=['plugin_only','server_only'].includes(process.env.NATIVE_BRANCH_MODE)?process.env.NATIVE_BRANCH_MODE:'server_only';
(async()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'lia-native-storage-'));const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});const address=await app.listen();const url=`http://127.0.0.1:${address.port}`;
 const transformSource=source=>source
  .replace('\n\n  async function waitForPluginStorage', '\n  globalThis.__fixtureStorageBridge = MemorySuiteStorageBridge;\n\n  async function waitForPluginStorage')
  .replace('debugProjectNativeBranchPersonaState: (ctx, binding) =>', 'debugEnsureInheritedLivePersona: async (ctx = null) => sanitizeLogValue(await ensureInheritedLivePersonaForCurrentChat(ctx, { force:true })),\n      debugProjectNativeBranchPersonaState: (ctx, binding) =>');
 const f=await createFixture('official',{transformSource,configureApi(api){api.getArgument=async name=>String(name).includes('memory_suite_server_url')?url:(String(name).includes('memory_suite_server_mode')?'plugin_only':String(name).includes('enable_gui')?'false':'');api.getArg=api.getArgument;api.nativeFetch=fetch;}});
 try{
  const bridge=f.context.__fixtureStorageBridge;assert.ok(bridge,'fixture storage bridge exposed');
  const parent=clone(f.liveChat);const parentScope={scopeId:f.scopeKey,scopeKey:f.scopeKey,characterId:'lia-char',chatId:'lia-chat',aliases:[f.scopeKey,'lia-chat'],label:'lia-chat'};
  await bridge.setScopeMode(parentScope,MODE);
  assert.equal((await bridge.getScopeMode(parentScope)).mode,MODE);
  if(MODE==='server_only')for(const key of [...f.values.keys()]){if(key==='liaPersonaLinkerLivePersonaIndexV2'||String(key).startsWith('liaPersonaLinkerLivePersonaScopeV2::'))f.values.delete(key);}
  const child=branch(parent,5,'lia-child-server');child.bindedPersona=parent.bindedPersona;
  for(const key of Object.keys(f.liveChat))delete f.liveChat[key];Object.assign(f.liveChat,child);f.character.chats=[f.liveChat,parent];
  const childScopeKey='char:lia-char|chat:lia-child-server';const childScope={scopeId:childScopeKey,scopeKey:childScopeKey,characterId:'lia-char',chatId:'lia-child-server',aliases:[childScopeKey,'lia-child-server'],label:'lia-child-server'};
  const before=await bridge.getScopeMode(childScope);assert.equal(before.mode,'plugin_only');assert.equal(before.explicit,false);
  const adopted=await f.runtime.debugEnsureInheritedLivePersona({db:f.db,charIndex:0,chatIndex:0,char:f.character,chat:f.liveChat});
  assert.equal(adopted.verified,true,JSON.stringify(adopted));
  assert.notEqual(adopted.reason,'no_inherited_live_owner',JSON.stringify(adopted));
  const after=await bridge.getScopeMode(childScope);assert.equal(after.mode,MODE,'LIA child must inherit parent storage mode');
  const proof=await f.runtime.getHostLineageStatus();assert.equal(proof.parentChatId,'lia-chat');
  console.log(JSON.stringify({test:'native_branch_lia_storage_modes_runtime',passed:8,mode:after.mode,reason:adopted.reason}));
 } finally {await f.dispose();await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
