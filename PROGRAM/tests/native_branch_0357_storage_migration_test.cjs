'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createMemorySuiteServer}=require('../server/server.cjs');
const sdkText=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteStorageClient.source.js'),'utf8');
const prepText=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteNativeBranchTargetStorage.source.js'),'utf8');
const createBridge=new Function(sdkText+'\nreturn createMemorySuiteStorageBridge')();
const prepContext=vm.createContext({});vm.runInContext(prepText,prepContext);
const makeStore=()=>{const values=new Map();return{values,getItem:async k=>values.get(String(k))??null,setItem:async(k,v)=>{values.set(String(k),v);return true},removeItem:async k=>{values.delete(String(k));return true},keys:async()=>[...values.keys()]};};
const scope=chat=>({scopeId:`memory-suite:flashback:char:c1|chat:${chat}|persona:default`,scopeKey:`memory-suite:flashback:char:c1|chat:${chat}|persona:default`,characterId:'c1',canonicalCharacterId:'c1',chatId:chat,canonicalChatId:chat,aliases:[chat]});
const lineage=(parent,target)=>({schema:'librarian.host_lineage.v1',hostVersion:'test',characterId:'c1',hostChatId:target,kind:'native_branch',status:'verified',reason:'exact_host_branch_prefix',parentChatId:parent,parentName:'Parent',forkMessageId:'a-7',markerIndex:14,forkMessageIndex:13,commonPrefixMessages:14,commonPrefixPairs:7,canonicalPrefixEnd:5,partialCanonicalPairs:2,prefixDigest:'migration-prefix',path:[parent,target],pathVerified:true,pathReason:'',inheritanceEligible:true});
(async()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'native-branch-0357-migrate-'));
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});const addr=await app.listen();
 const previous=globalThis.risuai;
 try{
  const parent=scope('parent'),child=scope('child');let current=parent;const raw=makeStore();
  globalThis.risuai={pluginStorage:raw,getArgument:async n=>n.includes('url')?`http://127.0.0.1:${addr.port}`:'plugin_only',setArgument:async()=>true,nativeFetch:fetch};
  const resolve=async({key,currentScope})=>{
    const k=String(key||'');
    const picked=k.endsWith('.parent')?parent:k.endsWith('.child')?child:(currentScope||{});
    return {kind:'scope',...picked,scopedContainer:true};
  };
  const storage=createBridge({namespace:'flashback',pluginId:'flashback_memory',pluginVersion:'test',managementButton:false,pluginPrefixes:['branch.migrate.'],currentScopeProvider:async()=>current,resolveKeyScope:resolve,preResolveKeyScope:true});
  const proxy=storage.createPluginStorageProxy(raw);
  await storage.setScopeMode(parent,'server_only');
  await proxy.setItem('branch.migrate.parent',JSON.stringify({scope:'parent'}));
  current=child;
  await proxy.setItem('branch.migrate.child',JSON.stringify({scope:'child',from:'0357-local'}));
  assert.equal((await storage.getScopeMode(child)).mode,'plugin_only');assert.equal((await storage.getScopeMode(child)).explicit,false);
  assert.deepEqual(JSON.parse(await raw.getItem('branch.migrate.child')),{scope:'child',from:'0357-local'});
  const prepared=await prepContext.prepareMemorySuiteNativeBranchTargetStorage({storage,owner:'flashback',lineage:lineage('parent','child'),sourceScope:parent,targetScope:child});
  assert.equal(prepared.targetMode,'server_only');
  assert.equal(prepared.targetModeOrigin,'migrated','existing implicit child data must be marked migrated');
  assert.deepEqual(JSON.parse(await prepared.targetView.getItem('branch.migrate.child')),{scope:'child',from:'0357-local'},'existing child local data must be copied to child server scope');
  assert.deepEqual(JSON.parse(await raw.getItem('branch.migrate.child')),{scope:'child',from:'0357-local'},'server-only migration must retain local source non-destructively');
  assert.equal(prepared.receipt.migration?.migrated,true);
  console.log(JSON.stringify({test:'native_branch_0357_storage_migration',passed:7,origin:prepared.targetModeOrigin}));
  await storage.dispose?.();
 }finally{globalThis.risuai=previous;await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
