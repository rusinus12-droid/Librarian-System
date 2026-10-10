'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createMemorySuiteServer}=require('../server/server.cjs');

const sdkText=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteStorageClient.source.js'),'utf8');
const nativePrepText=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteNativeBranchTargetStorage.source.js'),'utf8');
const createBridge=new Function(sdkText+'\nreturn createMemorySuiteStorageBridge')();
const prepContext=vm.createContext({}); vm.runInContext(nativePrepText,prepContext);

const makeStore=()=>{const values=new Map(); return {values,getItem:async k=>values.get(String(k))??null,setItem:async(k,v)=>{values.set(String(k),v);return true},removeItem:async k=>{values.delete(String(k));return true},keys:async()=>[...values.keys()]};};
const scope=(owner,chat)=>({scopeId:`memory-suite:${owner}:char:char-1|chat:${chat}|persona:default`,scopeKey:`memory-suite:${owner}:char:char-1|chat:${chat}|persona:default`,characterId:'char-1',canonicalCharacterId:'char-1',chatId:chat,canonicalChatId:chat,label:chat});
const lineage=(parent,target)=>({schema:'librarian.host_lineage.v1',hostVersion:'2026.8.250',characterId:'char-1',hostChatId:target,kind:'native_branch',status:'verified',reason:'exact_host_branch_prefix',parentChatId:parent,parentName:'Parent',forkMessageId:'a-7',markerIndex:14,forkMessageIndex:13,commonPrefixMessages:14,commonPrefixPairs:7,canonicalPrefixEnd:5,partialCanonicalPairs:2,prefixDigest:'abc123',path:[parent,target],pathVerified:true,pathReason:'',inheritanceEligible:true});

(async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'native-branch-storage-mode-'));
  const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
  const address=await app.listen();
  const previous=globalThis.risuai;
  try{
    const owner='flashback', parent=scope(owner,'parent'), child=scope(owner,'child');
    let current=parent;
    const raw=makeStore();
    globalThis.risuai={pluginStorage:raw,getArgument:async n=>n.includes('url')?`http://127.0.0.1:${address.port}`:'plugin_only',setArgument:async()=>true,nativeFetch:fetch};
    const storage=createBridge({namespace:owner,pluginId:'flashback_memory',pluginVersion:'test',managementButton:false,pluginPrefixes:['branch.test.'],currentScopeProvider:async()=>current,resolveKeyScope:async({currentScope})=>({kind:'scope',...(currentScope||{}),scopedContainer:true}),preResolveKeyScope:false});
    const proxy=storage.createPluginStorageProxy(raw);
    await storage.setScopeMode(parent,'server_only');
    await proxy.setItem('branch.test.memory',JSON.stringify({owner:'parent'}));
    assert.equal(await raw.getItem('branch.test.memory'),null,'server-only parent must not write canonical value locally');
    current=child;
    assert.equal(typeof storage.resolveScopeByAlias,'function','storage bridge must expose registered scope alias lookup');
    const resolvedParent=await storage.resolveScopeByAlias('parent');
    assert.equal(resolvedParent?.scopeId,parent.scopeId,'parent chat alias must resolve to the registered source scope');
    const before=await storage.getScopeMode(child); assert.equal(before.mode,'plugin_only'); assert.equal(before.explicit,false);
    const prepared=await prepContext.prepareMemorySuiteNativeBranchTargetStorage({storage,owner,lineage:lineage('parent','child'),sourceScope:parent,targetScope:child});
    assert.equal(prepared.verified,true);
    assert.equal(prepared.sourceMode,'server_only');
    assert.equal(prepared.targetMode,'server_only');
    assert.equal(prepared.targetModeOrigin,'inherited');
    assert.equal((await storage.getScopeMode(child)).mode,'server_only');
    assert.deepEqual(JSON.parse(await prepared.sourceView.getItem('branch.test.memory')),{owner:'parent'});
    await prepared.targetView.setItem('branch.test.memory',JSON.stringify({owner:'child'}));
    assert.deepEqual(JSON.parse(await prepared.targetView.getItem('branch.test.memory')),{owner:'child'});
    assert.deepEqual(JSON.parse(await prepared.sourceView.getItem('branch.test.memory')),{owner:'parent'},'source must remain unchanged');
    assert.equal(await raw.getItem('branch.test.memory'),null,'server-only child must not create local canonical value');
    console.log('PASS native branch server-only storage inheritance + explicit source/target scope views');
    await storage.dispose?.();
  } finally { globalThis.risuai=previous; await app.close(); fs.rmSync(dataDir,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1});
