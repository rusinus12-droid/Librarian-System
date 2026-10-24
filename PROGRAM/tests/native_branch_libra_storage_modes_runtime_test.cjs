'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createMemorySuiteServer}=require('../server/server.cjs');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const {clone,parent,branch,character}=require('./fixtures/native_branch_fixture.cjs');
const artifact=require('./fixtures/librarian_event_fixture.cjs');
const MODE=['plugin_only','server_only'].includes(process.env.NATIVE_BRANCH_MODE)?process.env.NATIVE_BRANCH_MODE:'server_only';
(async()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'libra-native-storage-'));const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});const address=await app.listen();const url=`http://127.0.0.1:${address.port}`;
 const source=parent('libra-parent-server',7);for(let i=0;i<7;i++){source.message[i*2].data=`PARENT U${i+1}`;source.message[i*2+1].data=`Alice completed parent turn ${i+1}.`;}const char=character([source]);let current=source;
 const host={getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>char.chats.indexOf(current),getCharacter:async()=>clone(char),getCharacterFromIndex:async()=>clone(char),getChat:async()=>clone(current),getCurrentChat:async()=>clone(current),getChatFromIndex:async(_c,i)=>clone(char.chats[i]),getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:[clone(char)],plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;},runLLMModel:async options=>{const raw=JSON.stringify(options),real=current.message.filter(m=>!m.disabled&&!m.isComment&&(m.role==='user'||m.role==='char'));const second=raw.includes('[t6-u]');const quote=real[(second?10:5)*2-1]?.data||'Assistant';return {type:'success',result:JSON.stringify(artifact(quote,second?'t10-a':'t5-a'))};},nativeFetch:fetch};
 const r=await createLibraVmHarness({memory_suite_server_url:url,enable_character_ito:false,enable_world_ito:false,enable_plot_ito:false},host,{transformSource:s=>s.replace(/\r?\n\r?\n  const RisuCompat = \(\(\) => \{/,'\n  globalThis.__fixtureStorageBridge = MemorySuiteStorageBridge;\n\n  const RisuCompat = (() => {')});
 try{
  const bridge=r.context.__fixtureStorageBridge;assert.ok(bridge);
  const proof=await r.api.getHostLineageStatus();assert.ok(proof.scopeKey);const parentScope={scopeId:proof.scopeKey,scopeKey:proof.scopeKey,characterId:char.id,chatId:source.id,aliases:[proof.scopeKey,source.id],label:source.id};
  await bridge.setScopeMode(parentScope,MODE);
  const settings=await r.api.getLibraMemorySettings();await r.api.saveLibraMemorySettings({...settings,enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false,stateTrackingEnabled:false});
  const parentJob=await r.api.runManualColdStart();assert.equal(parentJob.completed,1,JSON.stringify(parentJob));
  const parentMode=await bridge.getScopeMode(parentScope);assert.equal(parentMode.mode,MODE);
  const child=branch(source,7,'libra-child-server');current=child;char.chats.unshift(child);
  const adoption=await r.api.debugNativeChatCopy({force:true});assert.equal(adoption.result.ok,true,JSON.stringify(adoption));
  const childProof=await r.api.getHostLineageStatus();const childScope={scopeId:childProof.scopeKey,scopeKey:childProof.scopeKey,characterId:char.id,chatId:child.id,aliases:[childProof.scopeKey,child.id],label:child.id};
  const mode=await bridge.getScopeMode(childScope);assert.equal(mode.mode,MODE,'LIBRA child must inherit parent storage mode');
  let localChildManifest=[...r.values.keys()].find(k=>String(k).includes(childProof.scopeKey)&&String(k).endsWith(':manifest')); if(MODE==='server_only')assert.equal(localChildManifest,undefined,'server-only child manifest must not be local'); else assert.ok(localChildManifest,'plugin/mirror child manifest must remain local');
  for(let turn=8;turn<=10;turn++) child.message.push({role:'user',chatId:`cu${turn}`,data:`CHILD U${turn}`},{role:'char',chatId:`ca${turn}`,data:`Alice completed child turn ${turn}.`});
  const continued=await r.api.runManualColdStart();assert.equal(continued.completed,1,JSON.stringify(continued));
  const childStatus=await r.api.getHostLineageStatus();assert.equal(childStatus.scopeKey,childProof.scopeKey);
  const serverChildManifestRaw=await bridge.openScopeView(childScope,{capability:bridge.createNativeBranchScopeCapability({owner:'libra',lineage:childStatus,sourceScope:parentScope,targetScope:childScope}),access:'read'}).getItem(`libra:v1:scope:${childProof.scopeKey}:manifest`);
  assert.ok(serverChildManifestRaw,'continued server-only branch manifest must exist on server');
  const serverChildManifest=typeof serverChildManifestRaw==='string'?JSON.parse(serverChildManifestRaw):serverChildManifestRaw;
  assert.deepEqual(Object.keys(serverChildManifest.memories||{}).sort(),['1','6'],'child must keep inherited T1-5 and create child T6-10');
  localChildManifest=[...r.values.keys()].find(k=>String(k).includes(childProof.scopeKey)&&String(k).endsWith(':manifest')); if(MODE==='server_only')assert.equal(localChildManifest,undefined,'continued server-only child manifest must not be local'); else assert.ok(localChildManifest,'continued plugin/mirror child manifest must remain local');
  console.log(JSON.stringify({test:'native_branch_libra_storage_modes_runtime',passed:12,mode:mode.mode,memories:Object.keys(serverChildManifest.memories||{}).sort()}));
 }finally{await r.cleanup();await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
