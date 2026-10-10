'use strict';
// R02: after a local -> server_only migration that retains local bytes, the
// retained local copy is a recovery artifact, never a second authority.
// A normal server_only owner read must never resurrect retired local data even
// when the server has no value for that key, and local bytes must survive
// non-destructively. Retirement is recorded only after a verified server
// readback; a server failure must not retire anything.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createMemorySuiteServer}=require('../server/server.cjs');
const sdkText=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteStorageClient.source.js'),'utf8');
const prepText=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteNativeBranchTargetStorage.source.js'),'utf8');
const createBridge=new Function(sdkText+'\nreturn createMemorySuiteStorageBridge')();
const prepContext=vm.createContext({});vm.runInContext(prepText,prepContext);
const makeStore=()=>{const values=new Map();return{values,getItem:async k=>values.get(String(k))??null,setItem:async(k,v)=>{values.set(String(k),v);return true},removeItem:async k=>{values.delete(String(k));return true},keys:async()=>[...values.keys()]};};
const scope=chat=>({scopeId:`memory-suite:flashback:char:c1|chat:${chat}|persona:default`,scopeKey:`memory-suite:flashback:char:c1|chat:${chat}|persona:default`,characterId:'c1',canonicalCharacterId:'c1',chatId:chat,canonicalChatId:chat,aliases:[chat]});
const lineage=(parent,target)=>({schema:'librarian.host_lineage.v1',hostVersion:'test',characterId:'c1',hostChatId:target,kind:'native_branch',status:'verified',reason:'exact_host_branch_prefix',parentChatId:parent,parentName:'Parent',forkMessageId:'a-7',markerIndex:14,forkMessageIndex:13,commonPrefixMessages:14,commonPrefixPairs:7,canonicalPrefixEnd:5,partialCanonicalPairs:2,prefixDigest:'quarantine-prefix',path:[parent,target],pathVerified:true,pathReason:'',inheritanceEligible:true});
const hostFor=port=>{const previous=globalThis.risuai;return {previous,install:raw=>{globalThis.risuai={pluginStorage:raw,getArgument:async n=>n.includes('url')?`http://127.0.0.1:${port}`:'plugin_only',setArgument:async()=>true,nativeFetch:fetch};},restore:()=>{globalThis.risuai=previous;}};};
const bridgeOptionsFor=()=>{const parent=scope('parent'),child=scope('child');let current=parent;const resolve=async({key,currentScope})=>{const k=String(key||'');const picked=k.endsWith('.parent')?parent:k.endsWith('.child')?child:(currentScope||{});return {kind:'scope',...picked,scopedContainer:true};};return {options:{namespace:'flashback',pluginId:'flashback_memory',pluginVersion:'test',managementButton:false,pluginPrefixes:['branch.retire.'],currentScopeProvider:async()=>current,resolveKeyScope:resolve,preResolveKeyScope:true,scopeCacheMs:0},setCurrent:v=>{current=v;},parent,child};};
let passed=0;const ok=(label,condition)=>{assert.ok(condition,label);passed+=1;};

(async()=>{
 const raw=makeStore();
 // ---- Scenario 1: migration retires local, then a fresh empty server must not adopt it ----
 const dirA=fs.mkdtempSync(path.join(os.tmpdir(),'native-branch-quarantine-a-'));
 const appA=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dirA,autoBackup:false});
 const addrA=await appA.listen();
 const hostA=hostFor(addrA.port);hostA.install(raw);
 const ctxA=bridgeOptionsFor();
 try{
  const storage=createBridge(ctxA.options);
  const proxy=storage.createPluginStorageProxy(raw);
  await storage.setScopeMode(ctxA.parent,'server_only');
  await proxy.setItem('branch.retire.parent',JSON.stringify({scope:'parent'}));
  ctxA.setCurrent(ctxA.child);
  await proxy.setItem('branch.retire.child',JSON.stringify({scope:'child',from:'retained-local'}));
  const prepared=await prepContext.prepareMemorySuiteNativeBranchTargetStorage({storage,owner:'flashback',lineage:lineage('parent','child'),sourceScope:ctxA.parent,targetScope:ctxA.child});
  const migration=prepared.receipt.migration||{};
  ok('retirement disposition recorded',migration.localDisposition==='retired_after_server_readback');
  ok('server digest recorded',typeof migration.serverDigest==='string'&&migration.serverDigest.length>0);
  ok('retiredAt recorded',Number.isFinite(Date.parse(migration.retiredAt||'')));
  ok('server holds migrated child value',(await prepared.targetView.getItem('branch.retire.child'))===JSON.stringify({scope:'child',from:'retained-local'}));
  ok('maintenance reports retired local',(await storage.inspectNativeBranchRetiredLocalData(ctxA.child)).total>0);
  await storage.dispose?.();
 }finally{hostA.restore();await appA.close();fs.rmSync(dirA,{recursive:true,force:true});}

 // Retained local bytes are preserved, then mutated to a stale authority candidate.
 await raw.setItem('branch.retire.child',JSON.stringify({scope:'child',from:'STALE_LOCAL_MUTATED'}));
 ok('local bytes preserved',(await raw.getItem('branch.retire.child'))===JSON.stringify({scope:'child',from:'STALE_LOCAL_MUTATED'}));

 // A fresh, empty server has no value for the key. Without retirement this read
 // would fall back to the stale local copy and re-upload it as canonical.
 const dirB=fs.mkdtempSync(path.join(os.tmpdir(),'native-branch-quarantine-b-'));
 const appB=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dirB,autoBackup:false});
 const addrB=await appB.listen();
 const hostB=hostFor(addrB.port);hostB.install(raw);
 const ctxB=bridgeOptionsFor();ctxB.setCurrent(ctxB.child);
 try{
  const reloaded=createBridge(ctxB.options);
  const reloadedProxy=reloaded.createPluginStorageProxy(raw);
  const afterReload=await reloadedProxy.getItem('branch.retire.child');
  ok('normal server_only read ignores retired local',afterReload===null);
  const serverListing=await reloaded.serverKeys('plugin','branch.retire.');
  ok('retired local is not re-uploaded to the server',!serverListing.keys.some(k=>String(k).includes('branch.retire.child')));
  const retired=await reloaded.inspectNativeBranchRetiredLocalData(ctxB.child);
  ok('maintenance reports retired local after reload',retired.total>0&&retired.disposition==='retired_after_server_readback');
  ok('maintenance lists the retired key',(retired.keys||[]).includes('branch.retire.child'));
  await reloaded.dispose?.();
 }finally{hostB.restore();await appB.close();fs.rmSync(dirB,{recursive:true,force:true});}

 // ---- Scenario 2: server failure must not retire local ----
 // The parent is genuinely server_only, then the server becomes unreachable
 // before the child policy migration can complete. The retained local bytes
 // must survive and must never be marked retired without a verified readback.
 const downRaw=makeStore();
 const dirC=fs.mkdtempSync(path.join(os.tmpdir(),'native-branch-quarantine-c-'));
 const appC=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dirC,autoBackup:false});
 const addrC=await appC.listen();
 const hostC=hostFor(addrC.port);hostC.install(downRaw);
 const ctxDown=bridgeOptionsFor();
 try{
  const setup=createBridge(ctxDown.options);
  const setupProxy=setup.createPluginStorageProxy(downRaw);
  await setup.setScopeMode(ctxDown.parent,'server_only');
  await setupProxy.setItem('branch.retire.parent',JSON.stringify({scope:'parent'}));
  ctxDown.setCurrent(ctxDown.child);
  await setupProxy.setItem('branch.retire.child',JSON.stringify({scope:'child',from:'retained-local'}));
  await setup.dispose?.();
 }finally{hostC.restore();await appC.close();fs.rmSync(dirC,{recursive:true,force:true});}

 const hostDown=hostFor(addrC.port);hostDown.install(downRaw);
 try{
  const storage=createBridge(ctxDown.options);
  let failed=false;
  try{await prepContext.prepareMemorySuiteNativeBranchTargetStorage({storage,owner:'flashback',lineage:lineage('parent','child'),sourceScope:ctxDown.parent,targetScope:ctxDown.child});}catch(_){failed=true;}
  const retired=await storage.inspectNativeBranchRetiredLocalData(ctxDown.child);
  ok('server failure does not retire local',failed&&retired.total===0);
  ok('local bytes survive server failure',(await downRaw.getItem('branch.retire.child'))===JSON.stringify({scope:'child',from:'retained-local'}));
  await storage.dispose?.();
 }finally{hostDown.restore();}

 console.log(JSON.stringify({test:'native_branch_server_only_local_quarantine',passed}));
})().catch(e=>{console.error(e);process.exitCode=1});
