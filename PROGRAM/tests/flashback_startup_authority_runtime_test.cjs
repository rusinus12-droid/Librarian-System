'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),Module=require('node:module');
const {test}=require('node:test');
Error.stackTraceLimit=100;
const program=path.resolve(__dirname,'..'),sourcePath=process.env.FLASHBACK_APPEND_SOURCE||path.join(program,'plugins/Flashback_Memory.js'),source=fs.readFileSync(sourcePath,'utf8');
const needle='  globalThis.__FlashbackMemory = publicApi;',probeDir=fs.mkdtempSync(path.join(os.tmpdir(),'flashback-authority-probe-')),probePath=path.join(probeDir,'Flashback_Memory.js');
assert(source.includes(needle));fs.writeFileSync(probePath,source.replace(needle,'  globalThis.__authorityProbe={rawPublicationOwner,sameRawPublicationOwner,Runtime,begin:beginFlashbackRecallRequest,requests:flashbackRecallRequests};\n'+needle)
 .replace('      const readStartupAuthority = async () => {','      const readStartupAuthority = async () => {\n        globalThis.__authorityReadOrdinal=(globalThis.__authorityReadOrdinal||0)+1;')
 .replace('      const readStartupHost = async () => {','      const readStartupHost = async () => {\n        globalThis.__hostReadOrdinal=(globalThis.__hostReadOrdinal||0)+1;'));
const fixturePath=path.join(__dirname,'fixtures/flashback_append_cost_fixture.cjs'),fixtureSource=fs.readFileSync(fixturePath,'utf8'),nativeNeedle='  if(options.precomputedVectors&&String(url).startsWith';assert(fixtureSource.includes(nativeNeedle));
// Fixture-only transport extension; production, shared SDK and original fixture bytes are untouched.
const adapted=new Module(fixturePath,module);adapted.filename=fixturePath;adapted.paths=Module._nodeModulePaths(path.dirname(fixturePath));
const previous=process.env.FLASHBACK_APPEND_SOURCE;process.env.FLASHBACK_APPEND_SOURCE=probePath;
adapted._compile(fixtureSource.replace(nativeNeedle,'  if(options.nativeFetch&&String(url).startsWith("http://127.0.0.1:"))return await options.nativeFetch(url,init);\n'+nativeNeedle),fixturePath);
if(previous===undefined)delete process.env.FLASHBACK_APPEND_SOURCE;else process.env.FLASHBACK_APPEND_SOURCE=previous;
const {createCostFixture,diskStore}=adapted.exports,{createMemorySuiteServer}=require('../server/server.cjs');
console.log(JSON.stringify({evidence:'startup_authority_source_pin',sourceSHA256:crypto.createHash('sha256').update(source).digest('hex')}));
const live=x=>x.t.liveChatStateFromNormalized(x.t.normalizeStoredChatMessages(x.f.currentChat,x.scope.scopeKey));
const owners=x=>{const keys=x.f.context.__appendCost.scopeKeys,manifest=keys.manifest(x.scope.scopeKey),worldline=keys.worldline(x.scope.scopeKey);
 return x.clone({plugin:[...x.pluginStorage.values].filter(([k])=>k===manifest||k===worldline||k.includes(':shard:')).sort(([a],[b])=>a.localeCompare(b)),vectors:[...x.safeLocalStorage.values].filter(([k])=>k.includes('local-vector-shard')).sort(([a],[b])=>a.localeCompare(b))});};
const query=[{role:'user',content:'Find the codeword SigilaaaabA and its brass ledger.'}];
const markCorrection=async x=>{const key=x.f.context.__appendCost.scopeKeys.worldline(x.scope.scopeKey),history=JSON.parse(await x.pluginStorage.getItem(key)),node=history.nodes.find(n=>n.status==='active');assert(node);node.status='orphaned';node.activeOrdinal=0;await x.pluginStorage.setItem(key,JSON.stringify(history));};

for(const change of ['stable','profile','nonembedding','url','mode','initial-stale'])for(const correction of [false,true])test('actual startup authority '+change+' '+(correction?'proposal':'no-op')+' retains literal owners',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'flashback-startup-authority-'));
 const appA=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:path.join(root,'DATA-A'),autoBackup:false,computeEnabled:false}),appB=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:path.join(root,'DATA-B'),autoBackup:false,computeEnabled:false});
 const a=await appA.listen(),b=await appB.listen(),urlA='http://127.0.0.1:'+a.port,urlB='http://127.0.0.1:'+b.port;
 const local=diskStore(root,'local',[]),get=local.getItem;let x,inStartup=false,boundaryObserved=false,result,visited=false,modePromise,before,after,protocol,modeAtBoundary,ownerBefore,ownerAfter,generationBefore,generationAfter;
 const calls=[];local.getItem=async key=>{
  const stack=new Error().stack,value=await get.call(local,key);
  if(inStartup&&!boundaryObserved&&stack.includes('inspectFlashbackVectorPayloadMetadata')){
   boundaryObserved=true;const bridge=x.f.context.__fixtureStorageBridge,probe=x.f.context.__authorityProbe;ownerBefore=probe.rawPublicationOwner();generationBefore=probe.Runtime.embeddingGeneration;
   const cfg=await x.f.api.loadSettings(true);
   if(change==='profile')await x.f.api.saveSettings({...cfg,embeddingModel:'authority-new-profile'});
   if(change==='nonembedding')await x.f.api.saveSettings({...cfg,maxResponseItems:49999});
   if(change==='url'){
    const oldBinding=bridge.serverBinding();protocol=await bridge.configureConnection({mode:'plugin_only',url:urlB});assert.equal(protocol.ok,true);assert.equal(protocol.to.url,urlB);
    const adopted=await bridge.testConnection(urlB);assert.equal(adopted.ok,true);assert.equal(adopted.dataIdentityCertified,true);assert.notEqual(adopted.dataInstanceId,oldBinding.dataInstanceId);
   }
   if(change==='mode'){
    modePromise=bridge.setMode('server_only').then(value=>({ok:true,value}),error=>({ok:false,error:error.code||error.message}));
    for(let i=0;i<40;i++){modeAtBoundary=await bridge.getConnectionSettings({force:true});if(modeAtBoundary.transition?.phase==='draining')break;await new Promise(r=>setImmediate(r));}
    assert.equal(modeAtBoundary.transition?.phase,'draining');assert.equal(modeAtBoundary.mode,'plugin_only','actual cutover waits for the admitted startup writer');
   }
   ownerAfter=probe.rawPublicationOwner();generationAfter=probe.Runtime.embeddingGeneration;
  }
  return value;
 };
 try{
  x=await createCostFixture({root,safeLocalStorage:local,precomputedVectors:true,settings:{captureAfterRequest:true},arguments:{memory_suite_server_url:urlA},nativeFetch:async(url,init)=>{
   const parsed=new URL(url);assert([urlA,urlB].includes(parsed.origin),'only owned loopback servers are callable');calls.push(parsed.pathname);return await fetch(url,{...init,headers:{...init?.headers,Connection:'close'}});
  }});
  const bridge=x.f.context.__fixtureStorageBridge;assert.equal((await bridge.testConnection(urlA)).ok,true);
  await x.seed(8);await x.append(9);assert(JSON.stringify(await x.f.api._selectionTest.beforeRequest(query,'model')).includes('The codeword SigilaaaabA'));
  x.f.context.__rawCowBeforeConsumer=async()=>{
   visited=true;if(correction)await markCorrection(x);
   if(change==='initial-stale')await x.f.api.saveSettings({...await x.f.api.loadSettings(true),maxResponseItems:49999});
   before=owners(x);inStartup=true;
   try{result=await x.t.synchronizeFlashbackTurnWorldline(x.scope,live(x),x.cfg,{allowRetirement:false,forceReconcile:true,reason:'startup_restore_only'});}
   finally{inStartup=false;after=owners(x);}
  };
  const actual=await x.f.api._selectionTest.beforeRequest(query,'model'),injected=JSON.stringify(actual).includes('The codeword SigilaaaabA');
  if(modePromise){const outcome=await modePromise;assert.equal(outcome.ok,true);assert.equal(await bridge.getMode(),'server_only');assert.equal((await x.read()).records.length,9);}
  console.log(JSON.stringify({evidence:'startup_authority_intent',change,correction,visited,boundaryObserved,changed:result?.changed,reason:result?.reason,deferred:result?.deferred===true,deferReason:result?.deferReason,ownersSame:JSON.stringify(before)===JSON.stringify(after),injected,providerCalls:x.providerCalls(),httpRequests:calls.length}));
  assert(visited);if(change!=='initial-stale')assert(boundaryObserved,'the real physical metadata audit await is exercised');
  if(change==='stable'){assert.equal(result.deferred===true,false);assert.equal(result.changed,correction);if(!correction)assert.deepEqual(after,before);assert.equal(injected,!correction);}
  else {assert.equal(result.deferred,true,'changed authority refuses both no-op and an old repair proposal');assert.deepEqual(after,before);assert.equal(injected,false);}
  if(change==='nonembedding')assert.equal(generationAfter,generationBefore,'the full settings fence covers changes outside embedding generation');
  if(ownerBefore)assert(x.f.context.__authorityProbe.sameRawPublicationOwner(ownerBefore,ownerAfter),'the same adapter identity cannot certify unchanged storage intent');
  assert.equal(x.providerCalls(),0);
 }finally{if(x)await x.dispose();await appA.close();await appB.close();}
});

for(const change of ['last-authority-live','last-host-settings','last-host-profile','last-host-url','last-host-owner','last-host-request'])for(const correction of [false,true])test('actual final await '+change+' '+(correction?'proposal':'no-op')+' retains authority',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'flashback-last-authority-'));let appA,appB,urlA,urlB;
 if(change==='last-host-url'){
  appA=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:path.join(root,'DATA-A'),autoBackup:false,computeEnabled:false});appB=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:path.join(root,'DATA-B'),autoBackup:false,computeEnabled:false});
  urlA='http://127.0.0.1:'+(await appA.listen()).port;urlB='http://127.0.0.1:'+(await appB.listen()).port;
 }
 let x,active=false,visited=false,observed=false,result,before,after,newAttempt,newAttemptPreserved,replacementOwnerBefore,replacementOwnerAfter;
 let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 try{
  x=await createCostFixture({root,precomputedVectors:true,settings:{captureAfterRequest:true},arguments:urlA?{memory_suite_server_url:urlA}:{},nativeFetch:urlA?async(target,init)=>{
   assert([urlA,urlB].includes(new URL(target).origin));return await fetch(target,{...init,headers:{...init?.headers,Connection:'close'}});
  }:undefined});
  if(urlA)assert.equal((await x.f.context.__fixtureStorageBridge.testConnection(urlA)).ok,true);
  const host=x.f.host,method=change==='last-authority-live'?'getArgument':'getChatFromIndex',original=host[method];
  host[method]=async(...args)=>{const value=await original.apply(host,args);const ordinal=change==='last-authority-live'?x.f.context.__authorityReadOrdinal:x.f.context.__hostReadOrdinal;
   if(active&&!observed&&ordinal===2){observed=true;enter();await gate;}return value;};
  await x.seed(8);await x.append(9);assert(JSON.stringify(await x.f.api._selectionTest.beforeRequest(query,'model')).includes('The codeword SigilaaaabA'));
  x.f.context.__rawCowBeforeConsumer=async()=>{
   visited=true;if(correction)await markCorrection(x);before=owners(x);x.f.context.__authorityReadOrdinal=0;x.f.context.__hostReadOrdinal=0;active=true;
   const pending=x.t.synchronizeFlashbackTurnWorldline(x.scope,live(x),x.cfg,{allowRetirement:false,forceReconcile:true,reason:'startup_restore_only'});
   try{
    await Promise.race([entered,pending.then(()=>{throw Error('the actual final native await was not entered');})]);
    if(change==='last-authority-live')x.f.currentChat.message.at(-1).data+=' The unselected completed source changed during the final settings argument await.';
    if(change==='last-host-settings')await x.f.api.saveSettings({...await x.f.api.loadSettings(),maxResponseItems:49999});
    if(change==='last-host-profile')await x.f.api.saveSettings({...await x.f.api.loadSettings(),embeddingModel:'last-host-new-profile'});
    if(change==='last-host-url'){const bridge=x.f.context.__fixtureStorageBridge,configured=await bridge.configureConnection({mode:'plugin_only',url:urlB});assert.equal(configured.ok,true);assert.equal((await bridge.testConnection(urlB)).ok,true);}
    if(change==='last-host-owner'){
     const replacement=diskStore(root,'new-plugin-owner',[]);for(const[key,value]of x.pluginStorage.values)await replacement.setItem(key,value);host.pluginStorage=replacement;replacementOwnerBefore=owners({...x,pluginStorage:replacement});
    }
    if(change==='last-host-request')newAttempt=x.f.context.__authorityProbe.begin(x.scope.scopeKey);
    release();result=await pending;
   }finally{active=false;newAttemptPreserved=newAttempt?!newAttempt.cancelled:undefined;after=owners(x);if(replacementOwnerBefore)replacementOwnerAfter=owners({...x,pluginStorage:host.pluginStorage});}
  };
  const actual=await x.f.api._selectionTest.beforeRequest(query,'model'),injected=JSON.stringify(actual).includes('The codeword SigilaaaabA');
  console.log(JSON.stringify({evidence:'startup_last_native_await',change,correction,visited,observed,changed:result?.changed,reason:result?.reason,deferred:result?.deferred===true,deferReason:result?.deferReason,ownersSame:JSON.stringify(before)===JSON.stringify(after),newAttemptPreserved,injected,providerCalls:x.providerCalls()}));
  assert(visited);assert(observed);assert.equal(result.deferred,true);assert.deepEqual(after,before);if(replacementOwnerBefore)assert.deepEqual(replacementOwnerAfter,replacementOwnerBefore,'the replacement live adapter owner is also preserved');assert.equal(injected,false);if(newAttempt)assert.equal(newAttemptPreserved,true,'refusal preserves the newer actual request before old-consumer cleanup');assert.equal(x.providerCalls(),0);
 }finally{release();if(x)await x.dispose();if(appA)await appA.close();if(appB)await appB.close();}
});

for(const replacement of [false,true])for(const correction of [false,true])test('actual server-only startup '+(replacement?'same-URL DATA replacement':'unchanged DATA')+' '+(correction?'proposal':'no-op')+' preserves authority',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'flashback-startup-data-')),dataA=path.join(root,'DATA-A'),dataB=path.join(root,'DATA-B');
 let app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dataA,autoBackup:false,computeEnabled:false});const address=await app.listen(),url='http://127.0.0.1:'+address.port;
 let x,inStartup=false,boundaryObserved=false,result,visited=false,before,after,originalRows,replacementRows,oldDataId,newDataId;
 const rows=()=>['plugin','local'].flatMap(space=>app.repositories.flashback.list(space,'').records.map(r=>[space,r.key,app.repositories.flashback.get(space,r.key).value])).sort(([a,k],[b,l])=>a.localeCompare(b)||k.localeCompare(l));
 try{
  x=await createCostFixture({root,precomputedVectors:true,settings:{captureAfterRequest:true},arguments:{memory_suite_server_url:url},nativeFetch:async(target,init)=>{
   const stack=new Error().stack;
   assert.equal(new URL(target).origin,url,'the actual same-URL owned server is the only destination');
   const response=await fetch(target,{...init,headers:{...init?.headers,Connection:'close'}});
   if(inStartup&&!boundaryObserved&&stack.includes('inspectFlashbackVectorPayloadMetadata')){
    boundaryObserved=true;
    if(replacement){
     const body=await response.text(),status=response.status;originalRows=rows();oldDataId=x.f.context.__fixtureStorageBridge.serverBinding().dataInstanceId;
     await app.close();const from=path.join(dataA,'stores/flashback/flashback.sqlite'),to=path.join(dataB,'stores/flashback/flashback.sqlite');
     fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);
     app=createMemorySuiteServer({host:'127.0.0.1',port:address.port,dataDir:dataB,autoBackup:false,computeEnabled:false});await app.listen();replacementRows=rows();assert.deepEqual(replacementRows,originalRows,'physical replacement starts with exactly the same logical owner bytes');
     const adopted=await x.f.context.__fixtureStorageBridge.testConnection(url,{adoptDataInstance:true});assert.equal(adopted.ok,true);newDataId=adopted.dataInstanceId;assert.notEqual(newDataId,oldDataId);
     return new Response(body,{status});
    }
   }
   return response;
  }});
  await x.seed(8);await x.append(9);const bridge=x.f.context.__fixtureStorageBridge;assert.equal((await bridge.setMode('server_only')).to,'server_only');
  assert(JSON.stringify(await x.f.api._selectionTest.beforeRequest(query,'model')).includes('The codeword SigilaaaabA'));
  x.f.context.__rawCowBeforeConsumer=async()=>{
   visited=true;
   if(correction){const key=x.f.context.__appendCost.scopeKeys.worldline(x.scope.scopeKey),proxy=bridge.createPluginStorageProxy(x.pluginStorage),history=JSON.parse(await proxy.getItem(key)),node=history.nodes.find(n=>n.status==='active');assert(node);node.status='orphaned';node.activeOrdinal=0;await bridge.withFlashbackWriter(key,()=>proxy.setItem(key,JSON.stringify(history)));}
   before=rows();inStartup=true;
   try{result=await x.t.synchronizeFlashbackTurnWorldline(x.scope,live(x),x.cfg,{allowRetirement:false,forceReconcile:true,reason:'startup_restore_only'});}
   catch(error){result={error:error.code||error.message};}
   finally{inStartup=false;after=rows();}
  };
  const actual=await x.f.api._selectionTest.beforeRequest(query,'model'),injected=JSON.stringify(actual).includes('The codeword SigilaaaabA');
  console.log(JSON.stringify({evidence:'startup_same_url_data_authority',replacement,correction,visited,boundaryObserved,changed:result?.changed,reason:result?.reason,deferred:result?.deferred===true,deferReason:result?.deferReason,error:result?.error,logicalOwnersEqual:replacement?JSON.stringify(originalRows)===JSON.stringify(replacementRows):undefined,ownersPreserved:JSON.stringify(before)===JSON.stringify(after),injected,providerCalls:x.providerCalls()}));
  assert(visited);assert(boundaryObserved,'actual metadata HTTP response is held before SDK delivery');
  if(replacement){assert(result.deferred||result.error,'existing SDK or startup guard refuses replacement authority');assert.deepEqual(after,before);assert.equal(injected,false);}
  else {assert.equal(result.error,undefined);assert.equal(result.deferred===true,false);assert.equal(result.changed,correction);if(!correction)assert.deepEqual(after,before);assert.equal(injected,!correction);}
  assert.equal(x.providerCalls(),0);
 }finally{if(x)await x.dispose();await app.close();}
});
