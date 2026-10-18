'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {test}=require('node:test');
const {createCostFixture,turnMessages}=require('./fixtures/flashback_append_cost_fixture.cjs');
const exactPrior=(x,before,after)=>{for(const old of before){const row=after.find(r=>r.sourceHash===old.sourceHash);assert(row);assert.equal(row.text,old.text);assert.equal(row.sourceId,old.sourceId);assert.deepEqual(x.clone(row.sourceMessageIds),x.clone(old.sourceMessageIds));assert.deepEqual(x.clone(row.vector),x.clone(old.vector));}};
const rawWrites=tail=>tail.events.filter(e=>e.op==='set'&&e.family==='rawShard').length;
const ownerBytes=x=>{
 const keys=x.f.context.__appendCost.scopeKeys,manifest=keys.manifest(x.scope.scopeKey),worldline=keys.worldline(x.scope.scopeKey);
 return {plugin:[...x.pluginStorage.values].filter(([key])=>key===manifest||key===worldline||key.includes(':shard:')).sort(([a],[b])=>a.localeCompare(b)),
  vectors:x.clone([...x.safeLocalStorage.values].filter(([key])=>key.includes('local-vector-shard')).sort(([a],[b])=>a.localeCompare(b)))};
};
const currentLive=x=>x.t.liveChatStateFromNormalized(x.t.normalizeStoredChatMessages(x.f.currentChat,x.scope.scopeKey));
const startupRestore=x=>x.t.synchronizeFlashbackTurnWorldline(x.scope,currentLive(x),x.cfg,{allowRetirement:false,forceReconcile:true,reason:'startup_restore_only'});

test('native immutable append reuses exact raw/vector pages, advances only its tail and reads in a fresh realm',async()=>{
 const x=await createCostFixture({precomputedVectors:true});
 try{
  const before=await x.seed(128),oldRaw=new Map([...x.pluginStorage.values].filter(([key])=>key.includes(':shard:'))),oldVectors=new Map(x.safeLocalStorage.values);
  const first=await x.append(129);assert.equal(rawWrites(first),1);assert.equal(first.events.filter(e=>e.op==='set'&&e.family==='vector').length,0);
  assert.equal(first.loaded.manifest.rawPageLayout,'flashback.raw_pages.v1');assert.equal(first.loaded.manifest.rawPageReferences.length,3);
  assert.equal(first.loaded.manifest.rawPageReferences[0].payloadCommitId,before.manifest.commitId);exactPrior(x,before.records,first.loaded.records);
  const firstHead=first.loaded.manifest.commitId,second=await x.append(130);assert.equal(rawWrites(second),1);assert.equal(second.loaded.records.length,130);exactPrior(x,first.loaded.records,second.loaded.records);
  assert.notEqual(second.loaded.manifest.commitId,firstHead);assert.equal(second.loaded.manifest.rawPageReferences[0].payloadCommitId,before.manifest.commitId);
  for(const [key,raw]of oldRaw)assert.equal(await x.pluginStorage.getItem(key),raw);for(const [key,value]of oldVectors)assert.deepEqual(x.clone(await x.safeLocalStorage.getItem(key)),x.clone(value));
  const fresh=await createCostFixture({root:x.root,chat:x.f.currentChat,precomputedVectors:true});
  try{const actual=await fresh.f.context.__appendCost.loadScopeRecordsRaw(x.scope.scopeKey);assert.equal(actual.records.length,130);exactPrior(fresh,second.loaded.records,actual.records);assert.equal(actual.manifest.missingShards,0);assert.equal(actual.manifest.corruptShards,0);assert.equal(fresh.providerCalls(),0);}
  finally{await fresh.dispose();}
  assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

for(const failure of ['false','noop','corrupt','write_throw'])test('owning head '+failure+' preserves exact generations and resolves only verified physical authority',async()=>{
 const x=await createCostFixture({precomputedVectors:true});
 try{
  const before=await x.seed(128),oldRaw=new Map([...x.pluginStorage.values].filter(([key])=>key.includes(':shard:'))),oldVectors=new Map(x.safeLocalStorage.values),manifestKey=x.f.context.__appendCost.scopeKeys.manifest(x.scope.scopeKey);
  x.pluginStorage.fault=(op,key)=>op==='set'&&key===manifestKey?failure:null;
  if(failure==='write_throw'){
   const verified=await x.append(129);assert.equal(verified.loaded.records.length,129);assert.equal(verified.result.embeddingWork.reason,'raw_publication_pending_only');assert.equal(verified.result.embeddingComplete,false);
  }else await assert.rejects(x.append(129));x.pluginStorage.fault=null;
  for(const [key,raw]of oldRaw)assert.equal(await x.pluginStorage.getItem(key),raw);for(const [key,value]of oldVectors)assert.deepEqual(x.clone(await x.safeLocalStorage.getItem(key)),x.clone(value));
  assert([...x.pluginStorage.values].some(([key,raw])=>key.includes(':shard:')&&String(raw).includes(x.currentSources().at(-1).sourceHash)),'candidate raw survives uncertain head authority');
  const fresh=await createCostFixture({root:x.root,chat:x.f.currentChat,precomputedVectors:true});
  try{const actual=await fresh.f.context.__appendCost.loadScopeRecordsRaw(x.scope.scopeKey);assert([128,129].includes(actual.records.length));exactPrior(fresh,before.records,actual.records);assert.equal(actual.manifest.missingShards,0);assert.equal(actual.manifest.corruptShards,0);assert.equal(fresh.providerCalls(),0);}
  finally{await fresh.dispose();}
  const source=x.currentSources().at(-1);await x.f.context.__appendCost.ingestSources([source],x.cfg,x.scope,{deferEmbedding:true,replaceTurnPair:true,skipEpisodeRebuild:true});
  const retry=await x.read();assert.equal(retry.records.length,129);exactPrior(x,before.records,retry.records);assert.equal(retry.records.filter(r=>r.sourceHash===source.sourceHash).length,1);assert.equal(retry.records.find(r=>r.sourceHash===source.sourceHash).text,source.text);assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

for(const damage of ['removed-raw','altered-raw','removed-vector'])test('reused '+damage+' before owning head publication cannot return a durable capture',async()=>{
 const x=await createCostFixture({precomputedVectors:true});
 try{
  const before=await x.seed(128);await x.t.retireExternalRecordsForScope(x.scope,{settings:x.cfg});
  const t=x.f.context.__appendCost,manifestKey=t.scopeKeys.manifest(x.scope.scopeKey),headRaw=await x.pluginStorage.getItem(manifestKey),rawKey=t.scopeKeys.commitShard(x.scope.scopeKey,before.manifest.commitId,0),vectorKey=before.records[0].vectorRef.storageKey;let mutated=false;
  x.pluginStorage.fault=(op,key)=>{if(!mutated&&op==='set'&&key.endsWith(':shard:0002')){
   mutated=true;if(damage==='removed-raw')fs.unlinkSync(x.pluginStorage.fileFor(rawKey));
   else if(damage==='removed-vector')fs.unlinkSync(x.safeLocalStorage.fileFor(vectorKey));
   else{const e=JSON.parse(fs.readFileSync(x.pluginStorage.fileFor(rawKey),'utf8')),page=JSON.parse(e.value);page.records[0].text+=' post-attestation-tamper';page.checksum=t.storageShardChecksum(page.records);e.value=JSON.stringify(page);fs.writeFileSync(x.pluginStorage.fileFor(rawKey),JSON.stringify(e),'utf8');}
  }return null;};
  await assert.rejects(x.append(129),error=>error.code==='FLASHBACK_REBUILD_COMMIT_READBACK_FAILED');assert(mutated);x.pluginStorage.fault=null;
  assert.equal(await x.pluginStorage.getItem(manifestKey),headRaw,'failed candidate never replaces owner head');assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

for(const mutation of ['generation','profile','worldline','same-commit-head','scope','backend-url'])test('late '+mutation+' change refuses immutable append adoption',async()=>{
 const x=await createCostFixture({precomputedVectors:true});
 try{
  const before=await x.seed(128),t=x.f.context.__appendCost,manifestKey=t.scopeKeys.manifest(x.scope.scopeKey),oldRaw=new Map([...x.pluginStorage.values].filter(([key])=>key.includes(':shard:'))),oldVectors=new Map(x.safeLocalStorage.values),set=x.pluginStorage.setItem;let mutated=false;
  x.pluginStorage.setItem=async(key,value)=>{if(!mutated&&String(key).endsWith(':shard:0002')){
   mutated=true;
   if(mutation==='generation')t.Runtime.embeddingGeneration++;
   if(mutation==='profile')await x.f.api.saveSettings({...x.cfg,embeddingModel:'different-profile'});
   if(mutation==='scope'){x.f.currentChat.id='late-other-scope';x.f.currentChat.chatId='late-other-scope';}
   if(mutation==='backend-url')await x.f.context.__fixtureStorageBridge.setServerUrl('http://127.0.0.1:39491');
   if(mutation==='same-commit-head'){const head=JSON.parse(await x.pluginStorage.getItem(manifestKey));head.updatedAt='2040-02-01T00:00:00.000Z';await set.call(x.pluginStorage,manifestKey,JSON.stringify(head));}
   if(mutation==='worldline'){const key=t.scopeKeys.worldline(x.scope.scopeKey),raw=await x.pluginStorage.getItem(key),v=raw?JSON.parse(raw):{scopeKey:x.scope.scopeKey};v.revision=Number(v.revision||0)+1;await set.call(x.pluginStorage,key,JSON.stringify(v));}
  }return set.call(x.pluginStorage,key,value);};
  await assert.rejects(x.append(129),error=>error.code==='FLASHBACK_RAW_PAGE_APPEND_BOUNDARY_CHANGED');assert(mutated);
  const head=JSON.parse(await x.pluginStorage.getItem(manifestKey));assert.equal(head.commitId,before.manifest.commitId);assert.equal(head.count,128);
  for(const [key,raw]of oldRaw)assert.equal(await x.pluginStorage.getItem(key),raw);for(const [key,value]of oldVectors)assert.deepEqual(x.clone(await x.safeLocalStorage.getItem(key)),x.clone(value));assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

test('actual append generations export and restore all physical reference pages, raw provenance and retained vectors',async()=>{
 const x=await createCostFixture({precomputedVectors:true,ownerDiagnostics:process.env.REGRESSION_PORTABLE_OWNER_DIAGNOSTIC==='1'});
 try{
  await x.seed(128);await x.t.retireExternalRecordsForScope(x.scope.scopeKey);await x.append(129);const tail=await x.append(130),portable=x.f.context.__FlashbackPortableMemoryBackup;await x.f.context.__fixtureStorageBridge.whenFlashbackWritersIdle();if(x.f.context.__appendOwnerSnapshot)console.log(JSON.stringify({portableOwnerBeforeExport:x.f.context.__appendOwnerSnapshot()}));const envelope=await portable.exportCurrentScope();await portable.validateBackup(envelope);
  for(const ref of tail.loaded.manifest.rawPageReferences)assert(envelope.records.some(r=>r.key===ref.storageKey));assert.equal(envelope.localVectorSidecars.length,2);
  const fresh=await createCostFixture({chat:x.f.currentChat,precomputedVectors:true});
  try{await fresh.f.context.__FlashbackPortableMemoryBackup.restoreCurrentScope(envelope);const actual=await fresh.f.context.__appendCost.loadScopeRecordsRaw(x.scope.scopeKey);assert.equal(actual.records.length,130);assert.equal(actual.manifest.rawPageDirectoryDigest,tail.loaded.manifest.rawPageDirectoryDigest);exactPrior(fresh,tail.loaded.records,actual.records);assert.equal(fresh.providerCalls(),0);}
  finally{await fresh.dispose();}assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

test('a partially filled immutable tail rewrites one tail and preserves the prior physical vector page',async()=>{
 const x=await createCostFixture({precomputedVectors:true});
 try{
  const before=await x.seed(65),oldRaw=new Map([...x.pluginStorage.values].filter(([key])=>key.includes(':shard:'))),oldVectors=new Map(x.safeLocalStorage.values);
  const tail=await x.append(66);assert.equal(rawWrites(tail),1);assert.equal(tail.events.filter(e=>e.op==='set'&&e.family==='vector').length,1);assert.equal(tail.loaded.records.length,66);exactPrior(x,before.records,tail.loaded.records);
  assert.equal(tail.loaded.manifest.rawPageReferences[0].payloadCommitId,before.manifest.commitId);assert.equal(tail.loaded.manifest.rawPageReferences[1].payloadCommitId,tail.loaded.manifest.commitId);
  for(const [key,raw]of oldRaw)assert.equal(await x.pluginStorage.getItem(key),raw);for(const [key,value]of oldVectors)assert.deepEqual(x.clone(await x.safeLocalStorage.getItem(key)),x.clone(value));
 }finally{await x.dispose();}
});

for(const failure of ['false','noop','corrupt','write_throw'])test('refused '+failure+' delta publication retains old physical raw/vector and supports explicit exact retry',async()=>{
 const x=await createCostFixture({precomputedVectors:true});
 try{
  const before=await x.seed(128),oldRaw=new Map([...x.pluginStorage.values].filter(([key])=>key.includes(':shard:'))),oldVectors=new Map(x.safeLocalStorage.values);
  x.pluginStorage.fault=(op,key)=>op==='set'&&key.includes(':records:commit:')&&key.endsWith(':shard:0002')?failure:null;
  await assert.rejects(x.append(129));x.pluginStorage.fault=null;
  const intact=await x.f.context.__appendCost.loadScopeRecordsRaw(x.scope.scopeKey);assert.equal(intact.records.length,128);exactPrior(x,before.records,intact.records);
  for(const [key,raw]of oldRaw)assert.equal(await x.pluginStorage.getItem(key),raw);for(const [key,value]of oldVectors)assert.deepEqual(x.clone(await x.safeLocalStorage.getItem(key)),x.clone(value));
  const source=x.currentSources().at(-1);const result=await x.f.context.__appendCost.ingestSources([source],x.cfg,x.scope,{deferEmbedding:true,replaceTurnPair:true,skipEpisodeRebuild:true});
  assert.equal(result.embeddingComplete,false);const retry=await x.read();assert.equal(retry.records.length,129);const actual=retry.records.find(r=>r.sourceHash===source.sourceHash);assert(actual);assert.equal(actual.text,source.text);assert.equal(actual.sourceId,source.sourceId);exactPrior(x,before.records,retry.records);assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

test('actual registered finalized output reuses durable prefix pages and preserves capture provenance on restart',async()=>{
 const x=await createCostFixture({precomputedVectors:true,settings:{captureAfterRequest:true}});
 try{
  const before=await x.seed(128);await x.f.api._selectionTest.beforeRequest([{role:'user',content:'Find the codeword SigilaaaabA and its brass ledger.'}],'model');
  const baseline=await x.read(),pair=turnMessages(129);
  await x.f.api._selectionTest.beforeRequest([{role:'user',chatId:pair[0].chatId,content:pair[0].data}],'model');
  const tail=await x.append(129,'A','output');assert.equal(rawWrites(tail),1);assert.equal(tail.loaded.manifest.rawPageLayout,'flashback.raw_pages.v1');
  exactPrior(x,baseline.records,tail.loaded.records);const record=tail.loaded.records.find(r=>r.text===tail.source.text);assert(record);assert.equal(record.metadata.captureAuthority.source,'risu_chat_output');assert(record.metadata.sourceRawDigest);
  const fresh=await createCostFixture({root:x.root,chat:x.f.currentChat,precomputedVectors:true});try{const actual=await fresh.f.context.__appendCost.loadScopeRecordsRaw(x.scope.scopeKey);const row=actual.records.find(r=>r.sourceHash===record.sourceHash);assert(row);assert.equal(row.text,record.text);assert.equal(row.sourceId,record.sourceId);assert.deepEqual(fresh.clone(row.metadata.captureAuthority),x.clone(record.metadata.captureAuthority));exactPrior(fresh,baseline.records,actual.records);}
  finally{await fresh.dispose();}
  assert.equal(before.records.length,128);assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

test('metadata-changing full-writer fallback retains every older referenced raw/vector generation',async()=>{
 const x=await createCostFixture({precomputedVectors:true});
 try{
  await x.seed(128);const tail=await x.append(129),raws=new Map([...x.pluginStorage.values].filter(([key])=>key.includes(':shard:'))),vectors=new Map(x.safeLocalStorage.values);
  const changed=tail.loaded.records.map((r,i)=>i===0?{...r,metadata:{...r.metadata,rawCowRegressionMarker:'logical metadata update'}}:r);
  const saved=await x.f.context.__appendCost.saveScopeRecords(x.scope,changed,x.cfg,x.scope,{metadataOnly:true});
  assert.equal(saved.manifest.rawPageLayout,undefined);assert.equal(saved.manifest.rawPageRetentionRequired,true);assert.equal(saved.performance.shardWrites,3);
  const current=await x.f.context.__appendCost.loadScopeRecordsRaw(x.scope.scopeKey);assert.equal(current.records.length,129);exactPrior(x,tail.loaded.records,current.records);assert.equal(current.records[0].metadata.rawCowRegressionMarker,'logical metadata update');
  for(const [key,raw]of raws)assert.equal(await x.pluginStorage.getItem(key),raw);for(const [key,value]of vectors)assert.deepEqual(x.clone(await x.safeLocalStorage.getItem(key)),x.clone(value));assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

for(const damage of ['removed-raw','altered-raw','removed-vector'])test('actual registered capture to final hook rejects reused '+damage+' after recall preparation',async()=>{
 const x=await createCostFixture({precomputedVectors:true,settings:{captureAfterRequest:true}});
 try{
  await x.seed(128);const query=[{role:'user',chatId:'actual-cow-query',content:'Find the codeword SigilaaaabA and its brass ledger.'}];
  await x.f.api._selectionTest.beforeRequest(query,'model');const pair=turnMessages(129);await x.f.api._selectionTest.beforeRequest([{role:'user',chatId:pair[0].chatId,content:pair[0].data}],'model');
  const tail=await x.append(129,'A','output');x.f.context.__rawCowWriterCalls=[];x.clearTrace();
  const good=await x.f.api._selectionTest.beforeRequest(query,'model');assert(JSON.stringify(good).includes('The codeword SigilaaaabA'),JSON.stringify({reason:x.f.context.__appendCost.Runtime.lastRecall?.reason,skipped:x.f.context.__appendCost.Runtime.lastRecall?.skipped,lastError:x.f.context.__appendCost.Runtime.lastError,readiness:x.f.context.__appendCost.Runtime.lastRecall?.modelReadiness,output:good}));
  const head=await x.t.loadScopeManifest(x.scope);console.log(JSON.stringify({stage:'next-registered-hook',damage,layout:head.rawPageLayout||'v2',rawWrites:x.trace.filter(e=>e.op==='set'&&e.family==='rawShard').length,writers:x.clone(x.f.context.__rawCowWriterCalls)}));
  let mutated=false;x.f.context.__rawCowBeforeConsumer=async recall=>{assert(recall.records.length>0);const selected=recall.records.map(r=>r.record||r).find(r=>r.text.includes('SigilaaaabA'));assert(selected);const storageKey=head.rawPageReferences?.[0]?.storageKey||x.f.context.__appendCost.scopeKeys.commitShard(x.scope.scopeKey,head.commitId,0);
   if(damage==='removed-raw')await x.pluginStorage.removeItem(storageKey);
   else if(damage==='removed-vector')await x.safeLocalStorage.removeItem(selected.vectorRef.storageKey);
   else{const page=JSON.parse(await x.pluginStorage.getItem(storageKey));page.records[0].text+=' final-stage-tamper';page.checksum=x.f.context.__appendCost.storageShardChecksum(page.records);await x.pluginStorage.setItem(storageKey,JSON.stringify(page));}mutated=true;
  };
  const blocked=await x.f.api._selectionTest.beforeRequest(query,'model');assert(mutated);assert(!JSON.stringify(blocked).includes('The codeword SigilaaaabA'));assert.equal(tail.loaded.records.length,129);assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

test('equivalent startup restore preserves exact owner bytes and the actual prepared recall',async()=>{
 const x=await createCostFixture({precomputedVectors:true,settings:{captureAfterRequest:true}});
 try{
  await x.seed(8);await x.append(9);
  const query=[{role:'user',content:'Find the codeword SigilaaaabA and its brass ledger.'}];
  const initial=await x.f.api._selectionTest.beforeRequest(query,'model');assert(JSON.stringify(initial).includes('The codeword SigilaaaabA'));
  const worldlineKey=x.f.context.__appendCost.scopeKeys.worldline(x.scope.scopeKey),history=JSON.parse(await x.pluginStorage.getItem(worldlineKey));
  history.retiredRecords.push({...x.clone((await x.read()).records[0]),id:'retained-history-marker',hash:'retained-history-marker',
   lifecycleStatus:'inactive_variant',retiredAt:'2026-10-03T00:00:00.000Z',vectorRef:null});
  await x.pluginStorage.setItem(worldlineKey,JSON.stringify(history));
  let before,after,result,visited=false;
  x.f.context.__rawCowBeforeConsumer=async()=>{visited=true;before=ownerBytes(x);result=await startupRestore(x);after=ownerBytes(x);};
  const actual=await x.f.api._selectionTest.beforeRequest(query,'model');
  console.log(JSON.stringify({evidence:'equivalent_startup_prepared_recall',visited,changed:result?.changed,reason:result?.reason,
   exactOwnerBytes:JSON.stringify(before)===JSON.stringify(after),injected:JSON.stringify(actual).includes('The codeword SigilaaaabA'),providerCalls:x.providerCalls()}));
  assert(visited);assert.deepEqual(after,before,'an equivalent startup observation must not replace any manifest, worldline, raw or vector bytes');
  assert.equal(result.changed,false);assert(JSON.stringify(actual).includes('The codeword SigilaaaabA'),'equivalent background observation keeps prepared canonical evidence current');
  assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

test('startup repairs changed node lifecycle and invalidates the actual prepared recall',async()=>{
 const x=await createCostFixture({precomputedVectors:true,settings:{captureAfterRequest:true}});
 try{
  await x.seed(8);await x.append(9);const query=[{role:'user',content:'Find the codeword SigilaaaabA and its brass ledger.'}];
  const initial=await x.f.api._selectionTest.beforeRequest(query,'model');assert(JSON.stringify(initial).includes('The codeword SigilaaaabA'));
  const key=x.f.context.__appendCost.scopeKeys.worldline(x.scope.scopeKey);let nodeId,result,visited=false,priorRecords;
  x.f.context.__rawCowBeforeConsumer=async()=>{
   visited=true;priorRecords=(await x.read()).records;const worldline=JSON.parse(await x.pluginStorage.getItem(key));
   const node=worldline.nodes.find(n=>n.status==='active');assert(node);nodeId=node.turnNodeId;node.status='orphaned';node.activeOrdinal=0;
   await x.pluginStorage.setItem(key,JSON.stringify(worldline));result=await startupRestore(x);
  };
  const actual=await x.f.api._selectionTest.beforeRequest(query,'model');assert(visited);assert.equal(result.changed,true);
  assert.equal(result.restoredRecords,0,'a lifecycle repair restores nothing from the retired pool (the startup log must not claim it did)');
  assert.equal(JSON.parse(await x.pluginStorage.getItem(key)).nodes.find(n=>n.turnNodeId===nodeId).status,'active');
  assert(!JSON.stringify(actual).includes('The codeword SigilaaaabA'),'a real lifecycle repair still revokes prepared evidence');
  exactPrior(x,priorRecords,(await x.read()).records);assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

test('startup restores an exact retired raw/vector group and invalidates the actual prepared recall',async()=>{
 const x=await createCostFixture({precomputedVectors:true,settings:{captureAfterRequest:true}});
 try{
  await x.seed(8);await x.append(9);const query=[{role:'user',content:'Find the codeword SigilaaaabA and its brass ledger.'}];
  const initial=await x.f.api._selectionTest.beforeRequest(query,'model');assert(JSON.stringify(initial).includes('The codeword SigilaaaabA'));
  const t=x.f.context.__appendCost,key=t.scopeKeys.worldline(x.scope.scopeKey);let retired,result,visited=false,priorRecords;
  x.f.context.__rawCowBeforeConsumer=async()=>{
   visited=true;priorRecords=(await x.read()).records;retired=x.clone(priorRecords.find(r=>r.text.includes('SigilaaaabA')));assert(retired);
   const worldline=JSON.parse(await x.pluginStorage.getItem(key));worldline.retiredRecords.push({...retired,lifecycleStatus:'inactive_variant',retiredAt:'2026-10-03T00:00:00.000Z'});
   await x.pluginStorage.setItem(key,JSON.stringify(worldline));
   await t.saveScopeRecords(x.scope,priorRecords.filter(r=>r.id!==retired.id),x.cfg,x.scope,{metadataOnly:true});
   assert(!(await x.read()).records.some(r=>r.id===retired.id));result=await startupRestore(x);
  };
  const actual=await x.f.api._selectionTest.beforeRequest(query,'model');assert(visited);assert.equal(result.changed,true);assert.equal(result.restoredTurnGroups,1);assert.equal(result.restoredRecords,1,'only the retired record counts as restored');
  const active=(await x.read()).records;exactPrior(x,priorRecords,active);assert(active.some(r=>r.id===retired.id&&r.lifecycleStatus==='active'));
  assert(!JSON.parse(await x.pluginStorage.getItem(key)).retiredRecords.some(r=>r.id===retired.id),'restored raw remains in its active owner generation');
  assert(!JSON.stringify(actual).includes('The codeword SigilaaaabA'),'a changed raw owner generation still revokes prepared evidence');assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

test('two queued pure appends preserve both exact sources while a durable writer is held',async()=>{
 const x=await createCostFixture({precomputedVectors:true});
 let release;
 try{
  const before=await x.seed(128);await x.t.retireExternalRecordsForScope(x.scope,{settings:x.cfg});
  const held=new Promise(resolve=>{release=resolve;});let enteredResolve,hit=false,secondCompleted=false;const entered=new Promise(resolve=>{enteredResolve=resolve;}),set=x.pluginStorage.setItem;
  x.pluginStorage.setItem=async(key,value)=>{if(!hit&&String(key).endsWith(':shard:0002')){hit=true;enteredResolve();await held;}return set.call(x.pluginStorage,key,value);};
  const first=x.append(129);await entered;const second=x.append(130).then(value=>{secondCompleted=true;return value;});await new Promise(resolve=>setTimeout(resolve,40));assert.equal(secondCompleted,false);
  release();await Promise.all([first,second]);const actual=await x.f.context.__appendCost.loadScopeRecordsRaw(x.scope.scopeKey);assert.equal(actual.records.length,130);exactPrior(x,before.records,actual.records);
  for(const source of x.currentSources().slice(-2)){const rows=actual.records.filter(r=>r.sourceHash===source.sourceHash);assert.equal(rows.length,1);assert.equal(rows[0].text,source.text);assert.equal(rows[0].sourceId,source.sourceId);}assert.equal(x.providerCalls(),0);
 }finally{release?.();await x.dispose();}
});
