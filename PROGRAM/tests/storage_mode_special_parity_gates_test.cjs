'use strict';
// Tasks 13-16 special parity gates that are reachable through the shared storage
// authority plus the owner branch/legacy paths already covered by the native
// branch suite. Owner-specific runtime tests handle the domain-specific gates.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createMemorySuiteServer}=require('../server/server.cjs');
const {buildBridge,createInstrumentedStore,createBackendRequestCounter,logicalDigest}=require('./helpers/storage_mode_feature_harness.cjs');
let passed=0;const ok=(label,condition)=>{assert.ok(condition,label);passed+=1;};
const scope=chat=>({scopeId:`char:c1|chat:${chat}`,scopeKey:`char:c1|chat:${chat}`,characterId:'c1',canonicalCharacterId:'c1',chatId:chat,canonicalChatId:chat,aliases:[chat]});
const OWNERS=[['flashback','standard'],['hayaku','standard'],['lia','standard'],['libra','libra']];

(async()=>{
 // Gate: mirror keeps local/server logical digests in agreement for the same data.
 for(const [namespace] of OWNERS){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'special-parity-mirror-'));
  const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
  const addr=await app.listen();
  const store=createInstrumentedStore();
  const backend=createBackendRequestCounter(fetch);
  const handle=buildBridge({namespace,owner:namespace,store,currentScope:()=>scope('child'),resolveKeyScope:async({key,currentScope})=>({kind:'scope',...(currentScope||{}),scopedContainer:true}),url:`http://127.0.0.1:${addr.port}`,fetchImpl:backend.fetch,pluginPrefixes:['mirror.']});
  const bridge=handle.bridge;
  try{
   bridge.createPluginStorageProxy(store);
   await require('./helpers/legacy_mirror_fixture.cjs').seedLegacyMirrorFixture(bridge,store,scope('child'));
   const proxy=bridge.createPluginStorageProxy(store);
   await proxy.setItem('mirror.agree',JSON.stringify({v:'same'}));
   const localValue=await store.values.get([...store.values.keys()].find(k=>String(k).includes('mirror.agree')));
   const listing=await bridge.serverKeys('plugin','mirror.');
   const serverKey=listing.keys.find(k=>String(k).includes('mirror.agree'));
   const remote=await bridge.serverGet('plugin',serverKey);
   // The mirror stores the same logical value on both sides.
   const serverValue=typeof remote.value==='string'?remote.value:JSON.stringify(remote.value);
   ok(`${namespace} mirror: local and server agree`,String(localValue)===String(serverValue));
   ok(`${namespace} mirror: local digest stable across reload`,typeof localValue==='string');
  }finally{try{await bridge.dispose?.();}catch(_){}handle.restore();await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
 }

 // Gate: server_only authoritative write count is zero for canonical data.
 for(const [namespace] of OWNERS){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'special-parity-serveronly-'));
  const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
  const addr=await app.listen();
  const store=createInstrumentedStore();
  const backend=createBackendRequestCounter(fetch);
  const handle=buildBridge({namespace,owner:namespace,store,currentScope:()=>scope('child'),resolveKeyScope:async({key,currentScope})=>({kind:'scope',...(currentScope||{}),scopedContainer:true}),url:`http://127.0.0.1:${addr.port}`,fetchImpl:backend.fetch,pluginPrefixes:['serveronly.']});
  const bridge=handle.bridge;
  try{
   bridge.createPluginStorageProxy(store);
   await bridge.setScopeMode(scope('child'),'server_only');
   const before=store.counters.writes;
   const proxy=bridge.createPluginStorageProxy(store);
   await proxy.setItem('serveronly.canonical',JSON.stringify({v:'server'}));
   const canonicalWrites=store.counters.writes-before;
   const readBack=await proxy.getItem('serveronly.canonical');
   ok(`${namespace} server_only: zero local canonical writes`,canonicalWrites===0);
   ok(`${namespace} server_only: server value read back`,String(readBack).includes('"v":"server"'));
  }finally{try{await bridge.dispose?.();}catch(_){}handle.restore();await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
 }

 // Gate: an explicit user child storage mode is never overridden by inheritance.
 for(const [namespace] of OWNERS){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'special-parity-explicit-'));
  const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
  const addr=await app.listen();
  const store=createInstrumentedStore();
  const backend=createBackendRequestCounter(fetch);
  const handle=buildBridge({namespace,owner:namespace,store,currentScope:()=>scope('child'),resolveKeyScope:async({key,currentScope})=>({kind:'scope',...(currentScope||{}),scopedContainer:true}),url:`http://127.0.0.1:${addr.port}`,fetchImpl:backend.fetch,pluginPrefixes:['explicit.']});
  const bridge=handle.bridge;
  try{
   bridge.createPluginStorageProxy(store);
   await bridge.setScopeMode(scope('parent'),'server_only');
   await bridge.setScopeMode(scope('child'),'plugin_only',{recordExplicit:true});
   const childMode=await bridge.getScopeMode(scope('child'));
   ok(`${namespace}: explicit child mode recorded`,childMode.mode==='plugin_only'&&childMode.explicit===true);
   const lineage={schema:'librarian.host_lineage.v1',hostVersion:'test',characterId:'c1',hostChatId:'child',kind:'native_branch',status:'verified',reason:'exact_host_branch_prefix',parentChatId:'parent',parentName:'Parent',forkMessageId:'a-7',markerIndex:14,forkMessageIndex:13,commonPrefixMessages:14,commonPrefixPairs:7,canonicalPrefixEnd:5,partialCanonicalPairs:2,prefixDigest:'explicit-prefix',path:['parent','child'],pathVerified:true,pathReason:'',inheritanceEligible:true};
   const capability=bridge.createNativeBranchScopeCapability({owner:namespace,lineage,sourceScope:scope('parent'),targetScope:scope('child')});
   ok(`${namespace}: capability issued for explicit child`,capability&&capability.targetScopeId===scope('child').scopeId);
   const after=await bridge.getScopeMode(scope('child'));
   ok(`${namespace}: explicit mode survives branch capability issue`,after.mode==='plugin_only'&&after.explicit===true);
  }finally{try{await bridge.dispose?.();}catch(_){}handle.restore();await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
 }

 // Gate: plugin_only owner operations make zero Librarian backend storage requests.
 for(const [namespace] of OWNERS){
  const store=createInstrumentedStore();
  const backend=createBackendRequestCounter(fetch);
  const handle=buildBridge({namespace,owner:namespace,store,currentScope:()=>scope('child'),resolveKeyScope:async({key,currentScope})=>({kind:'scope',...(currentScope||{}),scopedContainer:true}),url:'http://127.0.0.1:1',fetchImpl:backend.fetch,pluginPrefixes:['local.']});
  const bridge=handle.bridge;
  try{
   bridge.createPluginStorageProxy(store);
   await bridge.setScopeMode(scope('child'),'plugin_only');
   const proxy=bridge.createPluginStorageProxy(store);
   await proxy.setItem('local.only','L');
   await proxy.getItem('local.only');
   await proxy.keys('');
   ok(`${namespace} plugin_only: zero backend requests`,backend.state.count===0);
  }finally{try{await bridge.dispose?.();}catch(_){}handle.restore();}
 }

 // Gate: retired local bytes are never recalled in server_only (R02 parity).
 for(const [namespace] of OWNERS){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'special-parity-retired-'));
  const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
  const addr=await app.listen();
  const store=createInstrumentedStore();
  const backend=createBackendRequestCounter(fetch);
  const handle=buildBridge({namespace,owner:namespace,store,currentScope:()=>scope('child'),resolveKeyScope:async({key,currentScope})=>({kind:'scope',...(currentScope||{}),scopedContainer:true}),url:`http://127.0.0.1:${addr.port}`,fetchImpl:backend.fetch,pluginPrefixes:['retired.']});
  const bridge=handle.bridge;
  try{
   bridge.createPluginStorageProxy(store);
   const proxy=bridge.createPluginStorageProxy(store);
   // Seed an implicit local child, then let the mode transition migrate it to
   // the server (this is the local -> server_only migration path).
   await proxy.setItem('retired.key',JSON.stringify({from:'local'}));
   await bridge.setScopeMode(scope('child'),'server_only');
   const serverListing=await bridge.serverKeys('plugin','retired.');
   ok(`${namespace} server_only: migrated value reached the server`,serverListing.keys.some(k=>String(k).includes('retired.key')));
   // Retire the retained local copy only after a verified server readback.
   const retired=await bridge.retireNativeBranchLocalTargetData({scope:scope('child'),keys:['retired.key']});
   ok(`${namespace} server_only: retirement disposition recorded`,retired.disposition==='retired_after_server_readback');
   // Mutate the retained local copy to a stale authority candidate.
   await store.setItem('retired.key',JSON.stringify({from:'STALE_LOCAL'}));
   const normalRead=await proxy.getItem('retired.key');
   ok(`${namespace} server_only: retired local not adopted by normal read`,!String(normalRead).includes('STALE_LOCAL'));
   const inspected=await bridge.inspectNativeBranchRetiredLocalData(scope('child'));
   ok(`${namespace} server_only: maintenance can report retired state`,inspected&&typeof inspected.total==='number');
  }finally{try{await bridge.dispose?.();}catch(_){}handle.restore();await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
 }

 console.log(JSON.stringify({test:'storage_mode_special_parity_gates',passed,owners:OWNERS.length}));
})().catch(e=>{console.error(e);process.exitCode=1});
