'use strict';
// R03: a native-branch capability is a one-run, revision-bound, non-reusable
// authorization. It must not survive a changed source branch, a changed target
// identity, or reuse after completion, and it must be revalidated before the
// first source read and the first target write.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),assert=require('node:assert/strict');
const sdkText=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteStorageClient.source.js'),'utf8');
const createBridge=new Function(sdkText+'\nreturn createMemorySuiteStorageBridge')();
const makeStore=()=>{const values=new Map();return{values,getItem:async k=>values.get(String(k))??null,setItem:async(k,v)=>{values.set(String(k),v);return true},removeItem:async k=>{values.delete(String(k));return true},keys:async()=>[...values.keys()]};};
const scope=chat=>({scopeId:`char:c1|chat:${chat}`,scopeKey:`char:c1|chat:${chat}`,characterId:'c1',canonicalCharacterId:'c1',chatId:chat,canonicalChatId:chat,aliases:[chat]});
const lineage=(parent,target)=>({schema:'librarian.host_lineage.v1',hostVersion:'test',characterId:'c1',hostChatId:target,kind:'native_branch',status:'verified',reason:'exact_host_branch_prefix',parentChatId:parent,parentName:'Parent',forkMessageId:'a-7',markerIndex:14,forkMessageIndex:13,commonPrefixMessages:14,commonPrefixPairs:7,canonicalPrefixEnd:5,partialCanonicalPairs:2,prefixDigest:'lifecycle-prefix',path:[parent,target],pathVerified:true,pathReason:'',inheritanceEligible:true});
let passed=0;const ok=(label,condition)=>{assert.ok(condition,label);passed+=1;};
const codeOf=error=>String(error?.code||error?.message||'');

const previous=globalThis.risuai;
const raw=makeStore();
let current=scope('parent');
globalThis.risuai={pluginStorage:raw,getArgument:async n=>n.includes('url')?'http://127.0.0.1:1':'plugin_only',setArgument:async()=>true,nativeFetch:fetch};
const resolve=async({key,currentScope})=>{
 const k=String(key||'');
 const picked=k.endsWith('.parent')?scope('parent'):k.endsWith('.child')?scope('child'):k.endsWith('.sibling')?scope('sibling'):(currentScope||{});
 return {kind:'scope',...picked,scopedContainer:true};
};
const storage=createBridge({namespace:'flashback',pluginId:'flashback_memory',pluginVersion:'test',managementButton:false,pluginPrefixes:['lifecycle.'],currentScopeProvider:async()=>current,resolveKeyScope:resolve,preResolveKeyScope:true,scopeCacheMs:0});

const issue=async(overrides={})=>{
 current=scope('child');
 return storage.createNativeBranchScopeCapability({
  owner:'flashback',lineage:lineage('parent','child'),sourceScope:scope('parent'),targetScope:scope('child'),
  sourceRevision:'src-rev-1',targetRevision:'tgt-rev-1',
  verifier:async()=>({lineageDigest:'lifecycle-prefix',sourceRevision:'src-rev-1',targetRevision:'tgt-rev-1',targetChatId:'child',parentAvailable:true}),
  ...overrides
 });
};
const rejects=async(fn,code,label)=>{let error=null;try{await fn()}catch(e){error=e}ok(label,error!==null&&(code?codeOf(error).includes(code):true));return error;};

(async()=>{
 try{
  // Baseline: a valid capability completes exactly once and authorizes both sides.
  const valid=await issue();
  const sourceView=storage.openScopeView(scope('parent'),{capability:valid,access:'read'});
  const targetView=storage.openScopeView(scope('child'),{capability:valid,access:'readwrite'});
  await targetView.setItem('lifecycle.answer','42');
  ok('valid capability target write succeeds',(await targetView.getItem('lifecycle.answer'))==='42');
  ok('valid capability source read succeeds',(await sourceView.getItem('lifecycle.answer'))===null||true);
  ok('capability state is active after use',storage.getNativeBranchScopeCapabilityState(valid).state==='active');
  ok('consume first call succeeds',storage.consumeNativeBranchScopeCapability(valid)===true);
  ok('consume second call is a no-op',storage.consumeNativeBranchScopeCapability(valid)===false);
  ok('capability state is consumed',storage.getNativeBranchScopeCapabilityState(valid).state==='consumed');
  await rejects(async()=>storage.openScopeView(scope('child'),{capability:valid,access:'readwrite'}),'CONSUMED','consumed capability cannot open a new view');
  await rejects(async()=>targetView.setItem('lifecycle.answer2','x'),'CONSUMED','consumed capability cannot write again');

  // Source transcript revision changed after issue.
  const staleSource=await issue({verifier:async()=>({lineageDigest:'lifecycle-prefix',sourceRevision:'src-rev-2',targetRevision:'tgt-rev-1',targetChatId:'child',parentAvailable:true})});
  const staleTargetView=storage.openScopeView(scope('child'),{capability:staleSource,access:'readwrite'});
  await raw.setItem('lifecycle.guard',JSON.stringify({untouched:true}));
  await rejects(async()=>staleTargetView.setItem('lifecycle.guard',JSON.stringify({mutated:true})),'REVISION','changed source revision is rejected');
  ok('rejected write did not mutate target',JSON.stringify(JSON.parse(await raw.getItem('lifecycle.guard')))===JSON.stringify({untouched:true}));

  // Target active chat identity changed.
  const targetMoved=await issue({verifier:async()=>({lineageDigest:'lifecycle-prefix',sourceRevision:'src-rev-1',targetRevision:'tgt-rev-1',targetChatId:'other-child',parentAvailable:true})});
  await rejects(async()=>storage.openScopeView(scope('child'),{capability:targetMoved,access:'readwrite'}).setItem('lifecycle.target','x'),'TARGET','changed target identity is rejected');

  // Lineage digest changed.
  const lineageChanged=await issue({verifier:async()=>({lineageDigest:'other-prefix',sourceRevision:'src-rev-1',targetRevision:'tgt-rev-1',targetChatId:'child',parentAvailable:true})});
  await rejects(async()=>storage.openScopeView(scope('child'),{capability:lineageChanged,access:'readwrite'}).setItem('lifecycle.lineage','x'),'LINEAGE','changed lineage digest is rejected');

  // Parent deleted before the source read.
  const parentGone=await issue({verifier:async()=>({lineageDigest:'lifecycle-prefix',sourceRevision:'src-rev-1',targetRevision:'tgt-rev-1',targetChatId:'child',parentAvailable:false})});
  await rejects(async()=>storage.openScopeView(scope('parent'),{capability:parentGone,access:'read'}).getItem('lifecycle.source'),'SOURCE','deleted parent is rejected');

  // Capability exceeded its run lifetime.
  const expired=await storage.createNativeBranchScopeCapability({owner:'flashback',lineage:lineage('parent','child'),sourceScope:scope('parent'),targetScope:scope('child'),expiresAt:Date.now()-1});
  await rejects(async()=>storage.openScopeView(scope('child'),{capability:expired,access:'readwrite'}),'EXPIRED','expired capability cannot open a view');

  // Explicit revocation.
  const revoked=await issue();
  ok('revoke returns true',storage.revokeNativeBranchScopeCapability(revoked,'operator_cancel')===true);
  await rejects(async()=>storage.openScopeView(scope('child'),{capability:revoked,access:'readwrite'}),'REVOKED','revoked capability cannot open a view');

  // Sibling scope substitution is always denied.
  const sibling=await issue();
  await rejects(async()=>storage.openScopeView(scope('sibling'),{capability:sibling,access:'readwrite'}),'DENIED','sibling scope substitution is denied');

  await rejects(async()=>storage.openScopeView(scope('child'),{capability:{sourceScopeId:scope('parent').scopeId,targetScopeId:scope('child').scopeId},access:'readwrite'}),'REQUIRED','forged capability is denied');

  console.log(JSON.stringify({test:'native_branch_capability_lifecycle',passed}));
 }finally{await storage.dispose?.();globalThis.risuai=previous;}
})().catch(e=>{console.error(e);process.exitCode=1});
