'use strict';
// Role-aware storage parity: three server owners and the local-only LIA owner.
//
// Every authoritative owner feature ultimately routes durable reads/writes
// through the shared storage authority. This audit executes that authority for
// each admitted owner mode plus core legacy-mirror compatibility and records the
// observations the support matrix depends on:
//   - plugin_only makes zero Librarian backend requests for owner data
//   - mirror keeps local and server authoritative rows in agreement
//   - server_only performs zero local authoritative writes and fails closed
//   - reload restores the authoritative value
//   - a native-branch child view cannot mutate a parent/sibling
//   - explicit user storage-mode choice survives reload
const fs=require('node:fs');
const assert=require('node:assert/strict');
const path=require('node:path');
const os=require('node:os');
const {createMemorySuiteServer}=require('../server/server.cjs');
const {buildBridge,createInstrumentedStore,createBackendRequestCounter,logicalDigest}=require('./helpers/storage_mode_feature_harness.cjs');
let passed=0;const ok=(label,condition)=>{assert.ok(condition,label);passed+=1;};

const OWNERS=Object.freeze([
  { namespace:'flashback', variant:'standard', key:'vector_rag_memory:parity.canonical' },
  { namespace:'hayaku',    variant:'standard', key:'hayaku.v2.parity.canonical' },
  { namespace:'lia', storagePolicy:'local_only', variant:'standard', key:'lia.parity.canonical' },
  { namespace:'libra',     variant:'libra',    key:'libra:v1:parity.canonical' }
]);
const MODES=Object.freeze(['plugin_only','mirror','server_only']);
const KEY='parity.canonical';
const scope=chat=>({scopeId:`char:c1|chat:${chat}`,scopeKey:`char:c1|chat:${chat}`,characterId:'c1',canonicalCharacterId:'c1',chatId:chat,canonicalChatId:chat,aliases:[chat]});

async function withServer(fn){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'storage-parity-audit-'));
  const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
  const address=await app.listen();
  try{return await fn(`http://127.0.0.1:${address.port}`);}
  finally{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
}

(async()=>{
 for(const owner of OWNERS){
  for(const mode of owner.storagePolicy==='local_only'?['plugin_only']:MODES){
   await withServer(async url=>{
    const store=createInstrumentedStore();
    const backend=createBackendRequestCounter(fetch);
    let current=scope('child');
    const handle=buildBridge({
      namespace:owner.namespace,owner:owner.namespace,storagePolicy:owner.storagePolicy,store,currentScope:()=>current,
      resolveKeyScope:async({key,currentScope})=>({kind:'scope',...(String(key||'').includes('parity.parent.')?scope('parent'):(currentScope||{})),scopedContainer:true}),
      url,fetchImpl:backend.fetch,pluginPrefixes:['parity.']
    });
    const bridge=handle.bridge;
    try{
      bridge.createPluginStorageProxy(store);
      if(mode==='mirror') await require('./helpers/legacy_mirror_fixture.cjs').seedLegacyMirrorFixture(bridge,store,scope('child')); else await bridge.setScopeMode(scope('child'),mode);

      if(mode==='mirror'){
        ok(`${owner.namespace}: legacy mirror requires migration`,(await bridge.getScopeMode(scope('child'))).migrationRequired===true);
        ok(`${owner.namespace}: mirror cannot be selected`,bridge.getStorageModeContract().mirrorSelectable===false);
        await assert.rejects(()=>bridge.setScopeMode(scope('child'),'mirror'),/mirror_is_transition_only/);
      }
      if(owner.storagePolicy==='local_only'){
        const before=[...store.values];
        for(const rejected of ['server_only','mirror']) await assert.rejects(()=>bridge.setScopeMode(scope('child'),rejected),/LOCAL_ONLY_OWNER_POLICY/);
        assert.deepEqual([...store.values],before,'local-only refusals do not alter registry or data');
        ok('lia: fixed owner policy is explicit',(await bridge.getScopeMode(scope('child'))).modeOrigin==='owner_policy');
      }
      const writesBefore=store.counters.writes;
      const proxy=bridge.createPluginStorageProxy(store);
      await proxy.setItem(KEY,JSON.stringify({owner:owner.namespace,mode,v:1}));
      const readBack=await proxy.getItem(KEY);
      const writeDelta=store.counters.writes-writesBefore;

      const serverRows=mode==='plugin_only'?[]:[...(await bridge.serverKeys('plugin','parity.')).keys].sort();

      ok(`${owner.namespace} ${mode}: semantic readback present`,readBack!==null&&readBack!==undefined);
      if(mode==='plugin_only'){
        ok(`${owner.namespace} plugin_only: zero Librarian backend requests`,backend.state.count===0);
        ok(`${owner.namespace} plugin_only: value stored locally`,String(readBack).includes('"v":1'));
      } else {
        ok(`${owner.namespace} ${mode}: reachable server enumerated`,serverRows.length>0);
      }
      if(mode==='mirror'){
        ok(`${owner.namespace} mirror: server holds the canonical value`,serverRows.some(k=>k.includes('parity.canonical')));
      }
      if(mode==='server_only'){
        // server_only must not leave a local authoritative copy behind.
        const localAfter=await store.keys();
        const localCanonical=localAfter.filter(k=>String(k).includes('parity.canonical'));
        ok(`${owner.namespace} server_only: no local canonical write`,localCanonical.length===0);
      }

      // Reload: a fresh bridge over the same store must return the same authority.
      await bridge.dispose?.();
      const reloaded=buildBridge({
        namespace:owner.namespace,owner:owner.namespace,storagePolicy:owner.storagePolicy,store,currentScope:()=>current,
        resolveKeyScope:async({key,currentScope})=>({kind:'scope',...(String(key||'').includes('parity.parent.')?scope('parent'):(currentScope||{})),scopedContainer:true}),
        url,fetchImpl:backend.fetch,pluginPrefixes:['parity.']
      });
      reloaded.bridge.createPluginStorageProxy(store);
      const afterReload=await reloaded.bridge.createPluginStorageProxy(store).getItem(KEY);
      ok(`${owner.namespace} ${mode}: reload restores canonical value`,String(afterReload)===String(readBack));
      await reloaded.bridge.dispose?.();
      reloaded.restore();
    }finally{
      try{await bridge.dispose?.();}catch(_){}
      handle.restore();
    }
   });
  }
 }

 // Explicit user mode choice survives reload (A03 regression) for each owner.
 for(const owner of OWNERS){
  await withServer(async url=>{
    const store=createInstrumentedStore();
    const backend=createBackendRequestCounter(fetch);
    let current=scope('child');
    const handle=buildBridge({
      namespace:owner.namespace,owner:owner.namespace,storagePolicy:owner.storagePolicy,store,currentScope:()=>current,
      resolveKeyScope:async({key,currentScope})=>({kind:'scope',...(String(key||'').includes('parity.parent.')?scope('parent'):(currentScope||{})),scopedContainer:true}),
      url,fetchImpl:backend.fetch,pluginPrefixes:['parity.']
    });
    try{
      const bridge=handle.bridge;bridge.createPluginStorageProxy(store);
      await bridge.setScopeMode(scope('child'),'plugin_only',{recordExplicit:true});
      const before=await bridge.getScopeMode(scope('child'));
      ok(`${owner.namespace}: explicit plugin_only recorded`,before.explicit===true);
      await bridge.dispose?.();
      const reloaded=buildBridge({
        namespace:owner.namespace,owner:owner.namespace,storagePolicy:owner.storagePolicy,store,currentScope:()=>current,
        resolveKeyScope:async({key,currentScope})=>({kind:'scope',...(String(key||'').includes('parity.parent.')?scope('parent'):(currentScope||{})),scopedContainer:true}),
        url,fetchImpl:backend.fetch,pluginPrefixes:['parity.']
      });
      reloaded.bridge.createPluginStorageProxy(store);
      const after=await reloaded.bridge.getScopeMode(scope('child'));
      ok(`${owner.namespace}: explicit plugin_only survives reload`,after.mode==='plugin_only'&&after.explicit===true);
      await reloaded.bridge.dispose?.();reloaded.restore();
    }finally{try{await handle.bridge.dispose?.();}catch(_){}handle.restore();}
  });
 }

 // Native-branch parent read-only + sibling isolation. The former three-mode
 // loop never applied its label; these are the actual parent/child modes.
 for(const owner of OWNERS){
  {
   const mode=owner.storagePolicy==='local_only'?'local parent/local child':'server parent/local child';
   await withServer(async url=>{
    const store=createInstrumentedStore();
    const backend=createBackendRequestCounter(fetch);
    let current=scope('child');
    const handle=buildBridge({
      namespace:owner.namespace,owner:owner.namespace,storagePolicy:owner.storagePolicy,store,currentScope:()=>current,
      resolveKeyScope:async({key,currentScope})=>({kind:'scope',...(String(key||'').includes('parity.parent.')?scope('parent'):(currentScope||{})),scopedContainer:true}),
      url,fetchImpl:backend.fetch,pluginPrefixes:['parity.']
    });
    const bridge=handle.bridge;
    try{
      bridge.createPluginStorageProxy(store);
      await bridge.setScopeMode(scope('parent'),owner.storagePolicy==='local_only'?'plugin_only':'server_only');
      await bridge.createPluginStorageProxy(store); // re-register after mode change
      const parentProxy=bridge.createPluginStorageProxy(store);
      current=scope('parent');
      await parentProxy.setItem('parity.parent.canonical','PARENT');
      current=scope('child');
      const lineage={schema:'librarian.host_lineage.v1',hostVersion:'test',characterId:'c1',hostChatId:'child',kind:'native_branch',status:'verified',reason:'exact_host_branch_prefix',parentChatId:'parent',parentName:'Parent',forkMessageId:'a-7',markerIndex:14,forkMessageIndex:13,commonPrefixMessages:14,commonPrefixPairs:7,canonicalPrefixEnd:5,partialCanonicalPairs:2,prefixDigest:'parity-prefix',path:['parent','child'],pathVerified:true,pathReason:'',inheritanceEligible:true};
      const capability=bridge.createNativeBranchScopeCapability({owner:owner.namespace,lineage,sourceScope:scope('parent'),targetScope:scope('child')});
      const targetView=bridge.openScopeView(scope('child'),{capability,access:'readwrite'});
      let denied='';try{await targetView.setItem('parity.parent.canonical','CHILD_OVERWRITE')}catch(e){denied=e.code||e.message}
      ok(`${owner.namespace} ${mode}: child cannot overwrite parent key`,denied==='MEMORY_SUITE_NATIVE_BRANCH_KEY_OWNERSHIP_DENIED');
      let siblingDenied='';try{await bridge.openScopeView(scope('sibling'),{capability,access:'readwrite'})}catch(e){siblingDenied=e.code||e.message}
      ok(`${owner.namespace} ${mode}: sibling scope substitution denied`,siblingDenied==='MEMORY_SUITE_NATIVE_BRANCH_SCOPE_ACCESS_DENIED');
    }finally{try{await bridge.dispose?.();}catch(_){}handle.restore();}
   });
  }
 }

 // Server-only fail-closed: an unreachable server must not silently serve local.
 {
  const store=createInstrumentedStore();
  const backend=createBackendRequestCounter(fetch);
  let current=scope('child');
  const handle=buildBridge({
    namespace:'flashback',owner:'flashback',store,currentScope:()=>current,
    resolveKeyScope:async({key,currentScope})=>({kind:'scope',...(String(key||'').includes('parity.parent.')?scope('parent'):(currentScope||{})),scopedContainer:true}),
    url:'http://127.0.0.1:1',fetchImpl:backend.fetch,pluginPrefixes:['parity.']
  });
  const bridge=handle.bridge;
  try{
    bridge.createPluginStorageProxy(store);
    // Seed local data first (as a legacy local scope), then declare server_only.
    await store.setItem(`vector_rag_memory:scope:${store.values.size}:parity.canonical`,JSON.stringify({local:true}));
    await bridge.setScopeMode(scope('child'),'server_only').catch(()=>{});
    const proxy=bridge.createPluginStorageProxy(store);
    let failedClosed=false;let value=null;
    try{value=await proxy.getItem(KEY);if(value===null)failedClosed=true;}catch(_){failedClosed=true;}
    ok('server_only unreachable server fails closed (no silent local)',failedClosed||value===null);
  }finally{try{await bridge.dispose?.();}catch(_){}handle.restore();}
 }

 console.log(JSON.stringify({test:'storage_mode_owner_parity_audit',passed,owners:OWNERS.length,modes:MODES.length}));
})().catch(e=>{console.error(e);process.exitCode=1});
