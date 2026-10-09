'use strict';
// Negative contract tests for the Native Branch Storage design (audit A01-A08).
// These fail if the SDK, preparation module, or backend validator regress to the
// released 0.3.58 behaviour. Only temporary DATA is touched.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {createMemorySuiteServer}=require('../server/server.cjs');
const root=path.resolve(__dirname,'..');
const prepCtx=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root,'sdk/MemorySuiteNativeBranchTargetStorage.source.js'),'utf8'),prepCtx);
const mkScope=chat=>({scopeId:`char:c1|chat:${chat}`,scopeKey:`char:c1|chat:${chat}`,characterId:'c1',canonicalCharacterId:'c1',chatId:chat,canonicalChatId:chat,aliases:[chat]});
const lineage=(p,c)=>({schema:'librarian.host_lineage.v1',hostVersion:'2026.8.250',characterId:'c1',hostChatId:c,kind:'native_branch',status:'verified',reason:'exact_host_branch_prefix',parentChatId:p,parentName:p,forkMessageId:'a-7',markerIndex:14,forkMessageIndex:13,commonPrefixMessages:14,commonPrefixPairs:7,canonicalPrefixEnd:5,partialCanonicalPairs:2,prefixDigest:'verified-prefix',path:[p,c],pathVerified:true,pathReason:'',inheritanceEligible:true});
let passed=0;
const ok=(label,condition)=>{assert.ok(condition,label);passed+=1;};
async function scenario(variant,fn){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-branch-design-contract-'));
  const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false});
  const addr=await app.listen();const url=`http://127.0.0.1:${addr.port}`;const old=globalThis.risuai;
  let current=mkScope('p');
  const values=new Map();
  const raw={getItem:async k=>values.get(String(k))??null,setItem:async(k,v)=>{values.set(String(k),v);return true},removeItem:async k=>{values.delete(String(k));return true},keys:async()=>[...values.keys()]};
  const ns=variant==='libra'?'libra':'hayaku';let bridge;
  try{
    globalThis.risuai={pluginStorage:raw,getArgument:async n=>n.includes('url')?url:'plugin_only',setArgument:async()=>true,nativeFetch:async(...a)=>fetch(...a)};
    const source=fs.readFileSync(path.join(root,'sdk',variant==='libra'?'MemorySuiteStorageClient.libra.source.js':'MemorySuiteStorageClient.source.js'),'utf8');
    const create=new Function(source+'\nreturn createMemorySuiteStorageBridge')();
    bridge=create({namespace:ns,pluginId:ns,pluginVersion:'design-contract',managementButton:false,pluginPrefixes:['audit.'],migrationDelayMs:100000,scopeCacheMs:0,autoMigratePlugin:false,autoMigrateLocal:false,currentScopeProvider:async()=>current,resolveKeyScope:async({key,currentScope})=>({kind:'scope',...(String(key).startsWith('audit.')?mkScope(String(key).split('.')[1]):currentScope),scopedContainer:true}),preResolveKeyScope:true});
    const proxy=bridge.createPluginStorageProxy(raw);
    const prepare=async(owner=ns)=>prepCtx.prepareMemorySuiteNativeBranchTargetStorage({storage:bridge,owner,lineage:lineage('p','c'),sourceScope:mkScope('p'),targetScope:mkScope('c')});
    const httpSet=async(key,value)=>{const conn=await bridge.bootstrap();const res=await fetch(url+'/v1/kv/set',{method:'POST',headers:{Authorization:`Bearer ${conn.token}`,'Content-Type':'application/json','X-Memory-Suite-Plugin':ns},body:JSON.stringify({namespace:ns,space:'plugin',key,value,operationId:'audit-'+crypto.randomUUID()})});return {status:res.status,body:await res.json()}};
    const remoteKey=async(logical)=>{const list=await bridge.serverKeys('plugin',logical);const key=list.keys.find(k=>k===logical||k.startsWith(logical+'::'));if(!key)throw Error('test_setup_remote_key_missing:'+JSON.stringify(list));return key};
    await fn({bridge,proxy,raw,values,prepare,httpSet,remoteKey,scope:mkScope,setCurrent:c=>{current=mkScope(c)},ns});
  }finally{await bridge?.dispose?.();globalThis.risuai=old;await app.close();fs.rmSync(dir,{recursive:true,force:true});}
}
(async()=>{
  for(const variant of ['standard','libra']){
    // A02 — a child view cannot write a parent/sibling/global key in any mode.
    for(const mode of ['plugin_only','server_only'])await scenario(variant,async x=>{
      await x.bridge.setScopeMode(x.scope('p'),mode);await x.proxy.setItem('audit.p.canonical','PARENT_VALUE');x.setCurrent('c');
      const p=await x.prepare();
      let error='';try{await p.targetView.setItem('audit.p.canonical','CHILD_WRONG_KEY')}catch(e){error=e.code||e.message}
      ok(`A02 ${variant} ${mode}: parent key write denied`,error==='MEMORY_SUITE_NATIVE_BRANCH_KEY_OWNERSHIP_DENIED');
      ok(`A02 ${variant} ${mode}: parent value unchanged`,(await p.sourceView.getItem('audit.p.canonical'))==='PARENT_VALUE');
    });
    // A08 — capability owner must equal the SDK namespace.
    await scenario(variant,async x=>{
      x.setCurrent('c');let rejected=false;
      try{await x.prepare(x.ns==='libra'?'hayaku':'lia')}catch(_){rejected=true}
      ok(`A08 ${variant}: wrong owner denied`,rejected);
    });
    // A03 — an explicit plugin_only save survives automatic inheritance.
    await scenario(variant,async x=>{
      await x.bridge.setScopeMode(x.scope('p'),'server_only');x.setCurrent('c');
      await x.bridge.setScopeMode(x.scope('c'),'plugin_only');
      const before=await x.bridge.getScopeMode(x.scope('c'));
      ok(`A03 ${variant}: explicit plugin_only recorded`,before.explicit===true);
      const result=await x.prepare();
      ok(`A03 ${variant}: inherited mode does not override`,result.targetMode==='plugin_only');
    });
    // A04 — a server_only source enumerates its server keys without a local copy.
    await scenario(variant,async x=>{
      await x.bridge.setScopeMode(x.scope('p'),'server_only');await x.proxy.setItem('audit.p.canonical','SERVER_PARENT');x.setCurrent('c');
      const p=await x.prepare();
      const exact=await p.sourceView.getItem('audit.p.canonical');
      const listed=await p.sourceView.keys('audit.p.');
      ok(`A04 ${variant}: server-only source reads through`,exact==='SERVER_PARENT');
      ok(`A04 ${variant}: server-only source enumerates`,listed.includes('audit.p.canonical'));
    });
    // A01 — a divergent mirror parent is never overwritten.
    await scenario(variant,async x=>{
      await x.raw.setItem('audit.p.canonical','OLD_LOCAL');await require('./helpers/legacy_mirror_fixture.cjs').seedLegacyMirrorFixture(x.bridge,x.raw,x.scope('p'));
      const key=await x.remoteKey('audit.p.canonical');
      const write=await x.httpSet(key,'NEW_SERVER');assert.equal(write.status,200,'test setup http write');
      const before=await x.bridge.serverGet('plugin',key);x.setCurrent('c');
      let rejected=false;try{await x.prepare()}catch(_){rejected=true}
      const after=await x.bridge.serverGet('plugin',key);
      ok(`A01 ${variant}: divergent parent rejected`,rejected);
      ok(`A01 ${variant}: server parent unchanged`,before.value===after.value);
    });
    // A07 — an invalid proof changes nothing on the target.
    await scenario(variant,async x=>{
      await x.bridge.setScopeMode(x.scope('p'),'server_only');x.setCurrent('c');await x.raw.setItem('audit.c.local','OLD_CHILD');
      let rejected=false;
      try{await prepCtx.prepareMemorySuiteNativeBranchTargetStorage({storage:x.bridge,owner:x.ns,lineage:{...lineage('p','c'),prefixDigest:''},sourceScope:x.scope('p'),targetScope:x.scope('c')})}catch(_){rejected=true}
      ok(`A07 ${variant}: invalid proof rejected`,rejected);
      ok(`A07 ${variant}: target mode unchanged`,(await x.bridge.getScopeMode(x.scope('c'))).mode==='plugin_only');
    });
    // Forged (deserialized) capability is rejected.
    await scenario(variant,async x=>{
      let rejected=false;
      try{x.bridge.openScopeView(x.scope('c'),{capability:{sourceScopeId:x.scope('p').scopeId,targetScopeId:x.scope('c').scopeId},access:'readwrite'})}catch(_){rejected=true}
      ok(`forged ${variant}: plain capability rejected`,rejected);
    });
  }
  // A06 — object and JSON-string binding receipts enforce the same owner check.
  await scenario('standard',async x=>{
    const binding={schema:'librarian.native_branch_storage_binding.v1',bindingId:'t',owner:'lia',sourceScopeKey:'char:c1|chat:p',targetScopeKey:'char:c1|chat:c',sourceMode:'plugin_only',targetMode:'server_only',targetModeOrigin:'explicit',parentChatId:'p',targetChatId:'c',lineageDigest:'abc',status:'complete',createdAt:new Date().toISOString(),committedAt:new Date().toISOString()};
    const root={chatId:'c',nativeBranchStorageBinding:binding};
    const object=await x.httpSet('audit.c.invalid-object',root);
    const string=await x.httpSet('audit.c.invalid-json',JSON.stringify(root));
    ok('A06: object receipt rejected',object.status===400);
    ok('A06: JSON-string receipt rejected',string.status===400);
  });
  const m=require('../server/core/host-lineage-metadata.cjs');
  const binding={schema:'librarian.native_branch_storage_binding.v1',bindingId:'t',owner:'lia',sourceScopeKey:'char:c1|chat:p',targetScopeKey:'char:c1|chat:c',sourceMode:'plugin_only',targetMode:'server_only',targetModeOrigin:'explicit',parentChatId:'p',targetChatId:'c',lineageDigest:'abc',status:'complete',createdAt:new Date().toISOString(),committedAt:new Date().toISOString()};
  ok('A06: validator rejects object',(()=>{try{m.validateStoredHostLineage({chatId:'c',nativeBranchStorageBinding:binding},'hayaku');return false}catch(_){return true}})());
  ok('A06: validator rejects JSON string',(()=>{try{m.validateStoredHostLineage(JSON.stringify({chatId:'c',nativeBranchStorageBinding:binding}),'hayaku');return false}catch(_){return true}})());
  ok('A06: validator rejects bare root receipt',(()=>{try{m.validateStoredHostLineage(binding,'hayaku');return false}catch(_){return true}})());
  console.log(JSON.stringify({test:'native_branch_storage_design_contract',passed,violations:0}));
})().catch(error=>{console.error(error);process.exitCode=1});
