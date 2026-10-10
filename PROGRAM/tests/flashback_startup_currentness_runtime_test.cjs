'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {test}=require('node:test');
const productPath=process.env.FLASHBACK_APPEND_SOURCE||path.resolve(__dirname,'../plugins/Flashback_Memory.js');
const productSource=fs.readFileSync(productPath,'utf8'),probeDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'flashback-startup-attempt-probe-'));
const probePath=path.join(probeDirectory,'Flashback_Memory.js'),needle='  globalThis.__FlashbackMemory = publicApi;';
assert(productSource.includes(needle));fs.writeFileSync(probePath,productSource.replace(needle,
 '  globalThis.__startupAttemptProbe = { requests: flashbackRecallRequests, begin: beginFlashbackRecallRequest };\n'+needle));
const previousSource=process.env.FLASHBACK_APPEND_SOURCE;process.env.FLASHBACK_APPEND_SOURCE=probePath;
const {createCostFixture,diskStore}=require('./fixtures/flashback_append_cost_fixture.cjs');
if(previousSource===undefined)delete process.env.FLASHBACK_APPEND_SOURCE;else process.env.FLASHBACK_APPEND_SOURCE=previousSource;
console.log(JSON.stringify({evidence:'startup_currentness_source_pin',sourceSHA256:require('node:crypto').createHash('sha256').update(productSource).digest('hex'),fixtureOnlyProbe:'exports actual request token/branch functions'}));
const currentLive=x=>x.t.liveChatStateFromNormalized(x.t.normalizeStoredChatMessages(x.f.currentChat,x.scope.scopeKey));
const ownerBytes=x=>{
 const keys=x.f.context.__appendCost.scopeKeys,manifest=keys.manifest(x.scope.scopeKey),worldline=keys.worldline(x.scope.scopeKey);
 return x.clone({plugin:[...x.pluginStorage.values].filter(([key])=>key===manifest||key===worldline||key.includes(':shard:')).sort(([a],[b])=>a.localeCompare(b)),
  vectors:[...x.safeLocalStorage.values].filter(([key])=>key.includes('local-vector-shard')).sort(([a],[b])=>a.localeCompare(b))});
};

for(const mutation of ['unchanged','scope','profile','before-startup-source','live-source','live-current-prompt','unselected-live-source','literal-only-source','unavailable-live-source',
 'late-raw','late-vector','late-record-timestamp','late-head','late-worldline','new-attempt-same-scope','new-attempt-new-scope','new-branch'])test('startup payload await '+mutation+' keeps literal owners and current prepared recall',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'flashback-startup-currentness-')),safeLocalStorage=diskStore(root,'local',[]);
 const get=safeLocalStorage.getItem;let x,inStartup=false,boundaryObserved=false,visited=false,result,before,after,damagedOwners,newAttempt,newAttemptPreserved;const awaitStacks=[];
 safeLocalStorage.getItem=async key=>{
  const stack=new Error().stack,value=await get.call(safeLocalStorage,key);
  if(inStartup)awaitStacks.push(stack);
  if(inStartup&&!boundaryObserved&&stack.includes('inspectFlashbackVectorPayloadMetadata')){
   boundaryObserved=true;
   if(mutation==='scope'){x.f.currentChat.id='startup-await-other-scope';x.f.currentChat.chatId='startup-await-other-scope';}
   if(mutation==='profile')await x.f.api.saveSettings({...x.cfg,embeddingModel:'startup-await-other-profile'});
   if(mutation==='live-source')x.f.currentChat.message[1].data+=' A different current source revision is now visible.';
   if(mutation==='live-current-prompt')x.f.currentChat.message.at(-1).data='The currently pending prompt has changed to an unrelated map request.';
   if(mutation==='unselected-live-source')x.f.currentChat.message.at(-1).data+=' The last completed source revision changed independently.';
   if(mutation==='literal-only-source')x.f.currentChat.message[1].data+='  ';
   if(mutation==='unavailable-live-source'){delete x.f.currentChat.message;delete x.f.currentChat.messages;}
   if(mutation.startsWith('new-attempt')||mutation==='new-branch'){
    x.f.currentChat.message[1].data+=' A source revision changed during a superseded request attempt.';
    const probe=x.f.context.__startupAttemptProbe;
    if(mutation==='new-branch'){newAttempt=probe.requests.active;newAttempt.branch++;}
    else newAttempt=probe.begin(mutation==='new-attempt-same-scope'?x.scope.scopeKey:'a-new-scope-request');
   }
   const keys=x.f.context.__appendCost.scopeKeys;
   if(mutation==='late-raw'||mutation==='late-record-timestamp'){
    const head=await x.t.loadScopeManifest(x.scope),storageKey=keys.commitShard(x.scope.scopeKey,head.commitId,0),page=JSON.parse(await x.pluginStorage.getItem(storageKey));
    if(mutation==='late-raw')page.records.at(-1).text+=' An unselected physical raw body changed with a valid shard checksum.';
    else page.records.at(-1).updatedAt='1999-02-03T04:05:06.000Z';
    page.checksum=x.f.context.__appendCost.storageShardChecksum(page.records);await x.pluginStorage.setItem(storageKey,JSON.stringify(page));
   }
   if(mutation==='late-vector')await x.safeLocalStorage.removeItem(key);
   if(mutation==='late-head'){const head=JSON.parse(await x.pluginStorage.getItem(keys.manifest(x.scope.scopeKey)));head.updatedAt='2040-02-03T04:05:06.000Z';await x.pluginStorage.setItem(keys.manifest(x.scope.scopeKey),JSON.stringify(head));}
   if(mutation==='late-worldline'){const history=JSON.parse(await x.pluginStorage.getItem(keys.worldline(x.scope.scopeKey)));history.nodes[0].missingObservations=37;await x.pluginStorage.setItem(keys.worldline(x.scope.scopeKey),JSON.stringify(history));}
   damagedOwners=ownerBytes(x);
  }
  return value;
 };
 x=await createCostFixture({root,safeLocalStorage,precomputedVectors:true,settings:{captureAfterRequest:true}});
 try{
  await x.seed(8);await x.append(9);
  const query=[{role:'user',content:'Find the codeword SigilaaaabA and its brass ledger.'}];
  if(mutation==='live-current-prompt')x.f.currentChat.message.push({role:'user',chatId:'startup-current-query',data:query[0].content});
  const initial=await x.f.api._selectionTest.beforeRequest(query,'model');assert(JSON.stringify(initial).includes('The codeword SigilaaaabA'));
  const head=await x.t.loadScopeManifest(x.scope);assert.equal(head.rawPageLayout,undefined);assert.notEqual(head.rawPageRetentionRequired,true);
  x.f.context.__rawCowBeforeConsumer=async()=>{
   visited=true;before=ownerBytes(x);const observed=currentLive(x);
   if(mutation==='before-startup-source')x.f.currentChat.message[1].data+=' The source changed after the caller observation and before startup inspection.';
   inStartup=true;
   try{result=await x.t.synchronizeFlashbackTurnWorldline(x.scope,observed,x.cfg,{allowRetirement:false,forceReconcile:true,reason:'startup_restore_only'});}
   catch(error){result={error:error.code||error.message};}
   finally{newAttemptPreserved=newAttempt?!newAttempt.cancelled:undefined;inStartup=false;after=ownerBytes(x);}
  };
  const actual=await x.f.api._selectionTest.beforeRequest(query,'model'),injected=JSON.stringify(actual).includes('The codeword SigilaaaabA');
  console.log(JSON.stringify({evidence:'startup_payload_await_currentness',mutation,visited,boundaryObserved,changed:result?.changed,reason:result?.reason,
   error:result?.error,deferReason:result?.deferReason,newAttemptPreserved,exactOwnerBytes:JSON.stringify(damagedOwners||before)===JSON.stringify(after),injected,providerCalls:x.providerCalls(),awaitStacks:boundaryObserved?undefined:awaitStacks}));
  assert(visited);
  if(mutation==='before-startup-source')assert(result?.deferred||boundaryObserved,'the supplied stale observation is refused initially or reaches the actual audit on the old source');
  else assert(boundaryObserved,'mutation occurs inside the actual physical vector metadata read await');
  assert.deepEqual(after,damagedOwners||before,'a stale startup proposal has no authority to replace any owner bytes');
  if(newAttempt)assert.equal(newAttemptPreserved,true,'startup refusal may revoke only its captured token and branch, before the old consumer cleanup');
  assert.equal(injected,mutation==='unchanged','changed live authority must revoke the actual prepared evidence');assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

for(const changed of [false,true])test('startup full reference readset '+(changed?'rejects an unselected page body change':'retains the intact physical directory'),async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'flashback-startup-reference-')),safeLocalStorage=diskStore(root,'local',[]),get=safeLocalStorage.getItem;
 let x,inStartup=false,boundaryObserved=false,damagedOwners;
 safeLocalStorage.getItem=async key=>{
  const stack=new Error().stack,value=await get.call(safeLocalStorage,key);
  if(inStartup&&!boundaryObserved&&stack.includes('inspectFlashbackVectorPayloadMetadata')&&!stack.includes('readScopeShardRecords')){
   boundaryObserved=true;
   if(changed){const head=await x.t.loadScopeManifest(x.scope),key=head.rawPageReferences[1].storageKey,page=JSON.parse(await x.pluginStorage.getItem(key));
    page.records[0].text+=' A different nonselected physical tail body now exists.';page.checksum=x.f.context.__appendCost.storageShardChecksum(page.records);await x.pluginStorage.setItem(key,JSON.stringify(page));}
   damagedOwners=ownerBytes(x);
  }
  return value;
 };
 x=await createCostFixture({root,safeLocalStorage,precomputedVectors:true,settings:{captureAfterRequest:true}});
 try{
  await x.seed(65);const query=[{role:'user',content:'Find the codeword SigilaaaabA and its brass ledger.'}];
  assert(JSON.stringify(await x.f.api._selectionTest.beforeRequest(query,'model')).includes('The codeword SigilaaaabA'));
  const t=x.f.context.__appendCost,current=await x.t.loadScopeManifest(x.scope),refs=[];
  for(let index=0;index<current.shardCount;index++){const key=t.scopeKeys.commitShard(x.scope.scopeKey,current.commitId,index),raw=await x.pluginStorage.getItem(key),page=JSON.parse(raw);
   refs.push({scopeKey:x.scope.scopeKey,storageKey:key,payloadCommitId:page.commitId,payloadShardIndex:index,recordCount:page.records.length,serializedValueDigest:await t.embeddingCheckpointDigest(raw)});}
  await x.pluginStorage.setItem(t.scopeKeys.manifest(x.scope.scopeKey),JSON.stringify({...current,commitId:'startup-reference-owner',rawPageLayout:'flashback.raw_pages.v1',rawPageReferences:refs,rawPageDirectoryDigest:await t.embeddingCheckpointDigest(refs)}));
  let before,after,result,visited=false;x.f.context.__rawCowBeforeConsumer=async recall=>{visited=true;assert(recall.records.length>0);before=ownerBytes(x);inStartup=true;
   try{result=await x.t.synchronizeFlashbackTurnWorldline(x.scope,currentLive(x),x.cfg,{allowRetirement:false,forceReconcile:true,reason:'startup_restore_only'});}
   finally{inStartup=false;after=ownerBytes(x);}};
  const actual=await x.f.api._selectionTest.beforeRequest(query,'model'),injected=JSON.stringify(actual).includes('The codeword SigilaaaabA');
  console.log(JSON.stringify({evidence:'startup_reference_dependency',changed,visited,boundaryObserved,reason:result?.reason,deferReason:result?.deferReason,injected,providerCalls:x.providerCalls()}));
  assert(visited);assert(boundaryObserved);assert.deepEqual(after,damagedOwners||before);assert.equal(result.deferred===true,changed);assert.equal(injected,!changed);assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

test('startup observation preserves an arbitrary published active record timestamp literally',async()=>{
 const x=await createCostFixture({precomputedVectors:true,settings:{captureAfterRequest:true}});
 try{
  await x.seed(8);const query=[{role:'user',content:'Find the codeword SigilaaaabA and its brass ledger.'}];
  assert(JSON.stringify(await x.f.api._selectionTest.beforeRequest(query,'model')).includes('The codeword SigilaaaabA'));
  const records=(await x.read()).records,timestamp='1999-02-03T04:05:06.000Z',id=records[0].id;
  await x.f.context.__appendCost.saveScopeRecords(x.scope,records.map(r=>r.id===id?{...r,updatedAt:timestamp}:r),x.cfg,x.scope,{metadataOnly:true});
  assert.equal((await x.read()).records.find(r=>r.id===id).updatedAt,timestamp);
  let before,after,result,visited=false;x.f.context.__rawCowBeforeConsumer=async()=>{visited=true;before=ownerBytes(x);
   result=await x.t.synchronizeFlashbackTurnWorldline(x.scope,currentLive(x),x.cfg,{allowRetirement:false,forceReconcile:true,reason:'startup_restore_only'});after=ownerBytes(x);};
  const actual=await x.f.api._selectionTest.beforeRequest(query,'model');assert(visited);assert.equal(result.changed,false);assert.deepEqual(after,before);
  assert(JSON.stringify(actual).includes('The codeword SigilaaaabA'));assert.equal((await x.read()).records.find(r=>r.id===id).updatedAt,timestamp);assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

for(const missing of [false,true])test('startup '+(missing?'defers a missing':'retains an intact')+' retired-only vector dependency without replacing history',async()=>{
 const x=await createCostFixture({precomputedVectors:true,settings:{captureAfterRequest:true}});
 try{
  await x.seed(8);const query=[{role:'user',content:'Find the codeword SigilaaaabA and its brass ledger.'}];
  assert(JSON.stringify(await x.f.api._selectionTest.beforeRequest(query,'model')).includes('The codeword SigilaaaabA'));
  const keys=x.f.context.__appendCost.scopeKeys,key=keys.worldline(x.scope.scopeKey),history=JSON.parse(await x.pluginStorage.getItem(key));
  const retired={...x.clone((await x.read()).records[0]),id:'retired-only-vector-record',hash:'retired-only-vector-record',lifecycleStatus:'inactive_variant',retiredAt:'2026-01-01T00:00:00.000Z'};
  const sidecar=await x.t.persistFlashbackVectorShard(x.scope.scopeKey,'retired-only-vector-proof',0,[retired]);assert(sidecar.ok);
  const row=x.clone(sidecar.records[0]);assert.equal(row.vector.length,0,'the stored retired record depends on its physical sidecar');history.retiredRecords.push(row);await x.pluginStorage.setItem(key,JSON.stringify(history));
  const localSnapshot=await x.t.flashbackSourceIntegritySnapshot(x.scope.scopeKey);
  assert(!localSnapshot.vectorSidecars.some(v=>v.storageKey===row.vectorRef.storageKey),'the existing local snapshot omits retired-only dependency keys');
  if(missing){await x.safeLocalStorage.removeItem(row.vectorRef.storageKey);assert.equal((await x.t.flashbackSourceIntegritySnapshot(x.scope.scopeKey)).fingerprint,localSnapshot.fingerprint,'existing snapshot does not certify this retired-only dependency');}
  let before,after,result,visited=false;x.f.context.__rawCowBeforeConsumer=async()=>{visited=true;before=ownerBytes(x);
   result=await x.t.synchronizeFlashbackTurnWorldline(x.scope,currentLive(x),x.cfg,{allowRetirement:false,forceReconcile:true,reason:'startup_restore_only'});after=ownerBytes(x);};
  const actual=await x.f.api._selectionTest.beforeRequest(query,'model'),injected=JSON.stringify(actual).includes('The codeword SigilaaaabA');
  console.log(JSON.stringify({evidence:'startup_retired_only_dependency',missing,visited,changed:result?.changed,reason:result?.reason,exactOwnerBytes:JSON.stringify(before)===JSON.stringify(after),injected,providerCalls:x.providerCalls()}));
  assert(visited);assert.deepEqual(after,before);assert.equal(injected,!missing);assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

for(const mutation of ['inline-stale-ref-missing','inline-changed','inline-removed','inline-invalid-dim','inline-invalid-zero','inline-invalid-finite',
 'sidecar-late-missing','sidecar-late-changed','sidecar-late-corrupt'])test('startup stored retired vector authority '+mutation+' preserves literal owners',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'flashback-startup-retired-authority-')),safeLocalStorage=diskStore(root,'local',[]),get=safeLocalStorage.getItem;
 let x,inStartup=false,boundaryObserved=false,worldlineKey,vectorKey,damagedOwners;
 safeLocalStorage.getItem=async key=>{
  const stack=new Error().stack,value=await get.call(safeLocalStorage,key);
  if(inStartup&&!boundaryObserved&&stack.includes('inspectFlashbackVectorPayloadMetadata')){
   boundaryObserved=true;
   if(mutation==='inline-changed'||mutation==='inline-removed'){
    const history=JSON.parse(await x.pluginStorage.getItem(worldlineKey)),row=history.retiredRecords.find(r=>r.id==='retired-authority-proof');assert(row);
    if(mutation==='inline-changed')row.vector[0]+=0.5;else row.vector=[];
    await x.pluginStorage.setItem(worldlineKey,JSON.stringify(history));
   }
   if(mutation==='sidecar-late-missing')await safeLocalStorage.removeItem(vectorKey);
   if(mutation==='sidecar-late-changed'||mutation==='sidecar-late-corrupt'){
    const payload=JSON.parse(await get.call(safeLocalStorage,vectorKey));
    if(mutation==='sidecar-late-changed')payload.literalOwnerRevision='changed during audit';else payload.data='invalid-payload-bytes';
    await safeLocalStorage.setItem(vectorKey,JSON.stringify(payload));
   }
   damagedOwners=ownerBytes(x);
  }
  return value;
 };
 x=await createCostFixture({root,safeLocalStorage,precomputedVectors:true,settings:{captureAfterRequest:true}});
 try{
  await x.seed(8);const query=[{role:'user',content:'Find the codeword SigilaaaabA and its brass ledger.'}];
  assert(JSON.stringify(await x.f.api._selectionTest.beforeRequest(query,'model')).includes('The codeword SigilaaaabA'));
  worldlineKey=x.f.context.__appendCost.scopeKeys.worldline(x.scope.scopeKey);const history=JSON.parse(await x.pluginStorage.getItem(worldlineKey));
  const retired={...x.clone((await x.read()).records[0]),id:'retired-authority-proof',hash:'retired-authority-proof',lifecycleStatus:'inactive_variant',retiredAt:'2026-01-01T00:00:00.000Z'};
  const sidecar=await x.t.persistFlashbackVectorShard(x.scope.scopeKey,'retired-authority-proof',0,[retired]);assert(sidecar.ok);
  const row=x.clone(sidecar.records[0]);vectorKey=row.vectorRef.storageKey;
  if(mutation.startsWith('inline-')){
   row.vector=retired.vector;assert.equal(row.vector.length,row.dim);
   if(mutation==='inline-invalid-dim')row.dim++;
   if(mutation==='inline-invalid-zero')row.vector=row.vector.map(()=>0);
   if(mutation==='inline-invalid-finite')row.vector[0]=null;
   await safeLocalStorage.removeItem(vectorKey);assert.equal(await get.call(safeLocalStorage,vectorKey),null,'the inline owner has only a stale optional sidecar reference');
  }else assert.equal(row.vector.length,0,'request hydration cannot make the required stored sidecar optional');
  history.retiredRecords.push(row);await x.pluginStorage.setItem(worldlineKey,JSON.stringify(history));
  let before,after,result,visited=false;x.f.context.__rawCowBeforeConsumer=async()=>{
   visited=true;before=ownerBytes(x);inStartup=true;
   try{result=await x.t.synchronizeFlashbackTurnWorldline(x.scope,currentLive(x),x.cfg,{allowRetirement:false,forceReconcile:true,reason:'startup_restore_only'});}
   finally{inStartup=false;after=ownerBytes(x);}
  };
  const actual=await x.f.api._selectionTest.beforeRequest(query,'model'),injected=JSON.stringify(actual).includes('The codeword SigilaaaabA'),positive=mutation==='inline-stale-ref-missing';
  console.log(JSON.stringify({evidence:'startup_stored_retired_vector_authority',mutation,visited,boundaryObserved,reason:result?.reason,deferReason:result?.deferReason,injected,providerCalls:x.providerCalls()}));
  assert(visited);assert.equal(result.deferred===true,!positive);assert.deepEqual(after,damagedOwners||before,'startup never replaces the captured or subsequently mutated authoritative owner');
  if(mutation==='inline-changed'||mutation==='inline-removed'||mutation.startsWith('sidecar-late-'))assert(boundaryObserved,'the mutation occurs at the actual physical audit await');
  assert.equal(injected,positive);assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

test('startup defers a valid immutable archive dependency that the local readset cannot certify',async()=>{
 const x=await createCostFixture({precomputedVectors:true,settings:{captureAfterRequest:true}});
 try{
  await x.seed(8);const query=[{role:'user',content:'Find the codeword SigilaaaabA and its brass ledger.'}];
  assert(JSON.stringify(await x.f.api._selectionTest.beforeRequest(query,'model')).includes('The codeword SigilaaaabA'));
  const archive=await x.t.createImmutableFlashbackHandoffArchive(x.scope.scopeKey,8,x.cfg);assert.equal((await x.t.verifyFlashbackArchiveRef(archive.archiveRef)).verified,true);
  await x.t.saveScopeManifest({...await x.t.loadScopeManifest(x.scope),archiveRef:archive.archiveRef},x.scope);
  const localSnapshot=await x.t.flashbackSourceIntegritySnapshot(x.scope.scopeKey),archiveSnapshot=await x.t.flashbackSourceIntegritySnapshot(archive.archiveRef.archiveScopeKey);
  assert(archiveSnapshot.shardHashes.length>0);assert(!localSnapshot.shardHashes.some(r=>archiveSnapshot.shardHashes.some(a=>a.key===r.key)),'existing snapshot names local owners only');
  let before,after,result,visited=false;x.f.context.__rawCowBeforeConsumer=async()=>{visited=true;before=ownerBytes(x);
   result=await x.t.synchronizeFlashbackTurnWorldline(x.scope,currentLive(x),x.cfg,{allowRetirement:false,forceReconcile:true,reason:'startup_restore_only'});after=ownerBytes(x);};
  const actual=await x.f.api._selectionTest.beforeRequest(query,'model'),injected=JSON.stringify(actual).includes('The codeword SigilaaaabA');
  console.log(JSON.stringify({evidence:'startup_archive_dependency_unproved',visited,changed:result?.changed,reason:result?.reason,exactOwnerBytes:JSON.stringify(before)===JSON.stringify(after),injected,providerCalls:x.providerCalls()}));
  assert(visited);assert.deepEqual(after,before);assert.equal(injected,false);assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});
