'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
const {clone,branch}=require('./fixtures/native_branch_fixture.cjs');
const MODE='plugin_only'; // LIA owns local persona state only.
(async()=>{
 let backendCalls=0;
 const transformSource=source=>source
  .replace('\n\n  async function waitForPluginStorage', '\n  globalThis.__fixtureStorageBridge = MemorySuiteStorageBridge;\n\n  async function waitForPluginStorage')
  .replace('debugProjectNativeBranchPersonaState: (ctx, binding) =>', 'debugEnsureInheritedLivePersona: async (ctx = null) => sanitizeLogValue(await ensureInheritedLivePersonaForCurrentChat(ctx, { force:true })),\n      debugProjectNativeBranchPersonaState: (ctx, binding) =>');
 const f=await createFixture('official',{transformSource,configureApi(api){api.getArgument=async name=>String(name).includes('memory_suite_server_url')?'http://127.0.0.1:1':(String(name).includes('memory_suite_server_mode')?'plugin_only':String(name).includes('enable_gui')?'false':'');api.getArg=api.getArgument;api.nativeFetch=async()=>{backendCalls++;throw Error('local-only LIA must not call server');};}});
 try{
  const bridge=f.context.__fixtureStorageBridge;assert.ok(bridge,'fixture storage bridge exposed');
  const parent=clone(f.liveChat);const parentScope={scopeId:f.scopeKey,scopeKey:f.scopeKey,characterId:'lia-char',chatId:'lia-chat',aliases:[f.scopeKey,'lia-chat'],label:'lia-chat'};
  await bridge.setScopeMode(parentScope,MODE);
  assert.equal((await bridge.getScopeMode(parentScope)).mode,MODE);
  const localBefore=[...f.values];
  const parentBindingRow=localBefore.find(([key,value])=>String(key).startsWith('liaPersonaLinkerLivePersonaScopeV2::')&&JSON.parse(value).scopeKey===f.scopeKey);
  assert.ok(parentBindingRow,'source parent binding exists');
  const sourceBinding=JSON.parse(parentBindingRow[1]);
  const parentPersonaBefore=JSON.stringify(f.db.personas.find(row=>row.id===parent.bindedPersona));
  const parentChatBefore=JSON.stringify(parent);
  for(const rejected of ['server_only','mirror'])await assert.rejects(()=>bridge.setScopeMode(parentScope,rejected),/LOCAL_ONLY_OWNER_POLICY/);
  assert.deepEqual([...f.values],localBefore,'refused modes preserve local source and registry');
  const child=branch(parent,5,'lia-child-server');child.bindedPersona=parent.bindedPersona;
  for(const key of Object.keys(f.liveChat))delete f.liveChat[key];Object.assign(f.liveChat,child);f.character.chats=[f.liveChat,parent];
  const childScopeKey='char:lia-char|chat:lia-child-server';const childScope={scopeId:childScopeKey,scopeKey:childScopeKey,characterId:'lia-char',chatId:'lia-child-server',aliases:[childScopeKey,'lia-child-server'],label:'lia-child-server'};
  const before=await bridge.getScopeMode(childScope);assert.equal(before.mode,'plugin_only');assert.equal(before.explicit,true);assert.equal(before.modeOrigin,'owner_policy');
  const adopted=await f.runtime.debugEnsureInheritedLivePersona({db:f.db,charIndex:0,chatIndex:0,char:f.character,chat:f.liveChat});
  assert.equal(adopted.verified,true,JSON.stringify(adopted));
  assert.notEqual(adopted.reason,'no_inherited_live_owner',JSON.stringify(adopted));
  assert.equal(adopted.durableReadbackVerified,true,'fork has verified durable local readback');
  const childRows=[...f.values].filter(([key,value])=>String(key).startsWith('liaPersonaLinkerLivePersonaScopeV2::')&&JSON.parse(value).scopeKey===childScopeKey);
  assert.equal(childRows.length,1,'exactly one persisted child binding');
  const persisted=JSON.parse(childRows[0][1]);
  assert.equal(persisted.livePersonaId,f.liveChat.bindedPersona,'host chat uses the persisted child persona');
  assert.notEqual(persisted.livePersonaId,parent.bindedPersona,'child persona is distinct from parent');
  assert.equal(persisted.forkedFromScopeKey,f.scopeKey);
  assert.equal(persisted.forkedFromLivePersonaId,sourceBinding.livePersonaId);
  assert.equal(persisted.basePersonaPrompt,sourceBinding.basePersonaPrompt,'inherited base content is preserved');
  assert.ok(f.db.personas.find(row=>row.id===persisted.livePersonaId)?.personaPrompt.includes(sourceBinding.basePersonaPrompt),'persisted persona carries inherited content');
  assert.equal(f.values.get(parentBindingRow[0]),parentBindingRow[1],'parent binding bytes remain unchanged');
  assert.equal(JSON.stringify(f.db.personas.find(row=>row.id===parent.bindedPersona)),parentPersonaBefore,'parent persona remains unchanged');
  assert.equal(JSON.stringify(parent),parentChatBefore,'parent chat remains unchanged');
  const after=await bridge.getScopeMode(childScope);assert.equal(after.mode,MODE,'LIA child retains local-only owner policy');
  assert.equal(after.explicit,true);assert.equal(after.modeOrigin,'owner_policy');
  const proof=await f.runtime.getHostLineageStatus();assert.equal(proof.parentChatId,'lia-chat');
  assert.equal(backendCalls,0,'native branch inheritance uses no server');
  console.log(JSON.stringify({storagePolicy:'local_only',test:'native_branch_lia_storage_modes_runtime',passed:27,mode:after.mode,reason:adopted.reason}));
 } finally {await f.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1});
