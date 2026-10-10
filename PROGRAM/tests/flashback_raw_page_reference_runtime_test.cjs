'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {test}=require('node:test');
const {createCostFixture}=require('./fixtures/flashback_append_cost_fixture.cjs');

async function referenceFixture(n=65,primeFinal=false){
 const x=await createCostFixture({precomputedVectors:true}),scope=x.scope.scopeKey,t=x.f.context.__appendCost,refs=[];
 let before=await x.seed(n);
 await x.t.retireExternalRecordsForScope(x.scope,{settings:x.cfg});before=await t.loadScopeRecordsRaw(scope);
 if(primeFinal){await x.f.api._selectionTest.beforeRequest([{role:'user',chatId:'cow-query',content:'Find the codeword SigilaaaabA and its brass ledger.'}],'model');before=await t.loadScopeRecordsRaw(scope);}
 for(let index=0;index<before.manifest.shardCount;index++){
  const storageKey=t.scopeKeys.commitShard(scope,before.manifest.commitId,index),raw=await x.pluginStorage.getItem(storageKey),value=JSON.parse(raw);
  refs.push({scopeKey:scope,storageKey,payloadCommitId:value.commitId,payloadShardIndex:index,recordCount:value.records.length,serializedValueDigest:await t.embeddingCheckpointDigest(raw)});
 }
 const head={...x.clone(before.manifest),commitId:'rawcow-fixture-head-one',rawPageLayout:'flashback.raw_pages.v1',rawPageReferences:refs,rawPageDirectoryDigest:await t.embeddingCheckpointDigest(refs)};
 delete head.manifestRawPresent;
 const publish=()=>x.pluginStorage.setItem(t.scopeKeys.manifest(scope),JSON.stringify(head));
 await publish();return{x,before,scope,t,refs,head,publish};
}

test('closed current-owner raw page directory reads exact older immutable physical raw and vectors',async()=>{
 const x=await createCostFixture({precomputedVectors:true});
 try{
  const before=await x.seed(65),scope=x.scope.scopeKey,t=x.f.context.__appendCost;
  assert.equal(before.records.length,65);const refs=[];
  for(let index=0;index<before.manifest.shardCount;index++){
   const storageKey=t.scopeKeys.commitShard(scope,before.manifest.commitId,index),raw=await x.pluginStorage.getItem(storageKey),value=JSON.parse(raw);
   assert.equal(value.scopeKey,scope);assert.equal(value.commitId,before.manifest.commitId);assert.equal(value.shard,index);
   refs.push({scopeKey:scope,storageKey,payloadCommitId:value.commitId,payloadShardIndex:index,recordCount:value.records.length,serializedValueDigest:await t.embeddingCheckpointDigest(raw)});
  }
  const head={...x.clone(before.manifest),commitId:'rawcow-fixture-head-one',rawPageLayout:'flashback.raw_pages.v1',rawPageReferences:refs,
   rawPageDirectoryDigest:await t.embeddingCheckpointDigest(refs)};
  delete head.manifestRawPresent;await x.pluginStorage.setItem(t.scopeKeys.manifest(scope),JSON.stringify(head));
  const actual=await t.loadScopeRecordsRaw(scope);
  const evidence={kind:'new-protocol-reader-contract',baseCommit:'7e24eea2328e98d01349d5cfbf5248ae685ef523',sourceSha256:x.hash(fs.readFileSync(path.resolve(__dirname,'../plugins/Flashback_Memory.js'))),
   owningHead:head.commitId,physicalPayloadCommit:before.manifest.commitId,physicalPages:refs.length,expectedRecords:65,actualRecords:actual.records.length,missingShards:actual.manifest.missingShards,actualModelCalls:0};
  if(process.env.FLASHBACK_RAW_COW_EVIDENCE){fs.mkdirSync(path.dirname(process.env.FLASHBACK_RAW_COW_EVIDENCE),{recursive:true});fs.writeFileSync(process.env.FLASHBACK_RAW_COW_EVIDENCE,JSON.stringify(evidence,null,2)+'\n','utf8');}
  console.log(JSON.stringify(evidence));assert.equal(actual.records.length,65,'new head must resolve only its explicitly authenticated older physical page references');
  const byHash=new Map(actual.records.map(record=>[record.sourceHash,record]));
  for(const old of before.records){const record=byHash.get(old.sourceHash);assert(record);assert.equal(record.text,old.text);assert.equal(record.sourceId,old.sourceId);assert.deepEqual(x.clone(record.sourceMessageIds),x.clone(old.sourceMessageIds));assert.deepEqual(x.clone(record.vector),x.clone(old.vector));}
  assert.equal(actual.manifest.missingShards,0);assert.equal(actual.manifest.corruptShards,0);assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

test('an unsupported or malformed zero-page directory is corrupt, never a valid empty scope',async()=>{
 const f=await referenceFixture(1);
 try{
  for(const mutation of [
   head=>{head.rawPageLayout='flashback.raw_pages.unknown';head.rawPageReferences=[];},
   head=>{head.rawPageReferences={};},
   head=>{head.rawPageReferences=[];head.rawPageDirectoryDigest='0'.repeat(64);},
   head=>{delete head.rawPageReferences;},
   head=>{delete head.rawPageLayout;delete head.rawPageReferences;head.rawPageDirectoryDigest='0'.repeat(64);}
  ]){
   f.head.shardCount=0;f.head.count=0;mutation(f.head);await f.publish();
   const actual=await f.t.loadScopeRecordsRaw(f.scope);
   assert.equal(actual.manifest.manifestCorrupt,true,'no physical pages must not bypass the reference protocol validator');
   assert.equal(actual.records.length,0);
  }
 }finally{await f.x.dispose();}
});

test('an authenticated empty reference directory remains a valid empty scope',async()=>{
 const f=await referenceFixture(0);
 try{const actual=await f.t.loadScopeRecordsRaw(f.scope);assert.equal(actual.records.length,0);assert.notEqual(actual.manifest.manifestCorrupt,true);assert.equal(actual.manifest.missingShards,0);}
 finally{await f.x.dispose();}
});

test('selected cold, warm and fresh-realm readers preserve exact referenced source, vectors and bounds',async()=>{
 const f=await referenceFixture(65);
 try{
  const expected=f.before.records.slice(0,64);
  for(let i=0;i<2;i++){
   const actual=await f.x.t.loadScopeRecordsForRecall(f.scope,{indexes:[0]});assert.equal(actual.records.length,64);
   for(const old of expected){const row=actual.records.find(r=>r.sourceHash===old.sourceHash);assert(row);assert.equal(row.text,old.text);assert.deepEqual(f.x.clone(row.vector),f.x.clone(old.vector));}
  }
  const critical=()=>f.x.hash([...f.x.pluginStorage.values].filter(([key])=>/manifest|:shard:|worldline/.test(key)));
  const before=critical(),fresh=await createCostFixture({root:f.x.root,chat:f.x.f.currentChat,precomputedVectors:true});
  try{const actual=await fresh.t.loadScopeRecordsForRecall(f.scope,{indexes:[0]});assert.equal(actual.records.length,64);assert.equal(actual.manifest.missingShards,0);
   assert.equal(critical(),before);assert.equal(fresh.providerCalls(),0);
   await fresh.pluginStorage.removeItem(f.refs[0].storageKey);const unavailable=await fresh.t.loadScopeRecordsForRecall(f.scope,{indexes:[0]});assert.equal(unavailable.records.length,0);assert.equal(unavailable.manifest.missingShards,1);
  }finally{await fresh.dispose();}
 }finally{await f.x.dispose();}
});

test('overlapping recall preparations each retain their own physical page validation frontier',async()=>{
 const f=await referenceFixture(65,true);
 try{
  let release,enteredResolve;const held=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{enteredResolve=resolve;});
  const original=f.x.pluginStorage.getItem;let hit=0;
  f.x.pluginStorage.getItem=async key=>{if(key===f.refs[0].storageKey){hit++;enteredResolve();await held;}return original.call(f.x.pluginStorage,key);};
  const query='Find the codeword SigilaaaabA and its brass ledger.';
  const first=f.x.f.api.recallRecords(query,f.x.cfg,f.x.scope,{currentPairIndex:100});await entered;
  const second=f.x.f.api.recallRecords(query,f.x.cfg,f.x.scope,{currentPairIndex:100});await new Promise(resolve=>setTimeout(resolve,40));release();
  const results=await Promise.all([first,second]);
  for(const result of results){assert(result.records.length>0);const binding=f.t.flashbackRecallPreparations.get(result)?.binding;assert(binding);assert(binding.rawPageReadIndexes.includes(0),'each prepared request must retain the exact page frontier consumed by its final hook');}
  assert(hit>=2,'without an owned current-store certificate both requests must establish their own physical raw read');
 }finally{await f.x.dispose();}
});

test('verified latest manifest backup recovers reference closure after a torn physical head without rewriting raw',async()=>{
 const f=await referenceFixture(65);
 try{
  await f.x.t.saveScopeManifest(f.head,f.x.scope);
  const pages=new Map(await Promise.all(f.refs.map(async ref=>[ref.storageKey,await f.x.pluginStorage.getItem(ref.storageKey)])));
  await f.x.pluginStorage.setItem(f.t.scopeKeys.manifest(f.scope),'{torn');
  const fresh=await createCostFixture({root:f.x.root,chat:f.x.f.currentChat,precomputedVectors:true});
  try{const actual=await fresh.f.context.__appendCost.loadScopeRecordsRaw(f.scope);assert.equal(actual.records.length,65);assert.equal(actual.manifest.manifestRecovered,true);assert.equal(actual.manifest.rawPageDirectoryDigest,f.head.rawPageDirectoryDigest);
   for(const old of f.before.records){const row=actual.records.find(r=>r.sourceHash===old.sourceHash);assert(row);assert.equal(row.text,old.text);assert.deepEqual(fresh.clone(row.vector),f.x.clone(old.vector));}
   for(const [key,raw]of pages)assert.equal(await fresh.pluginStorage.getItem(key),raw);assert.equal(await fresh.pluginStorage.getItem(f.t.scopeKeys.manifest(f.scope)),'{torn');
  }finally{await fresh.dispose();}
 }finally{await f.x.dispose();}
});

test('unavailable SHA-256 refuses the reference format while preserving the intact legacy reader',async()=>{
 const f=await referenceFixture(1);
 try{
  const crypto=f.x.f.context.crypto;f.x.f.context.crypto=null;
  const refused=await f.t.loadScopeRecordsRaw(f.scope);assert.equal(refused.manifest.manifestCorrupt,true);assert.equal(refused.records.length,0);assert.match(refused.manifest.rawPageError,/CRYPTO_UNAVAILABLE/);
  await f.x.pluginStorage.setItem(f.t.scopeKeys.manifest(f.scope),JSON.stringify(f.before.manifest));
  const legacy=await f.t.loadScopeRecordsRaw(f.scope);assert.equal(legacy.records.length,1);assert.notEqual(legacy.manifest.manifestCorrupt,true);
  f.x.f.context.crypto=crypto;await f.publish();assert.equal((await f.t.loadScopeRecordsRaw(f.scope)).records.length,1);
 }finally{await f.x.dispose();}
});

test('actual source integrity snapshot follows closed references and detects valid-checksum physical tamper',async()=>{
 const f=await referenceFixture(65);
 try{
  const snapshot=await f.x.t.flashbackSourceIntegritySnapshot(f.scope);assert.equal(snapshot.missingShards,0);assert.equal(snapshot.corruptShards,0);assert.equal(snapshot.vectorSidecars.length,2);
  assert.deepEqual(f.x.clone(snapshot.shardHashes.map(row=>row.key)),f.refs.map(ref=>ref.storageKey));
  const page=JSON.parse(await f.x.pluginStorage.getItem(f.refs[0].storageKey));page.records[0].text+=' altered';page.checksum=f.t.storageShardChecksum(page.records);await f.x.pluginStorage.setItem(f.refs[0].storageKey,JSON.stringify(page));
  assert.equal((await f.x.t.flashbackSourceIntegritySnapshot(f.scope)).corruptShards,1);
  await f.x.pluginStorage.removeItem(f.refs[0].storageKey);assert.equal((await f.x.t.flashbackSourceIntegritySnapshot(f.scope)).missingShards,1);
 }finally{await f.x.dispose();}
});

for(const [name,mutation] of [
 ['foreign owner',ref=>{ref.scopeKey='foreign-owner';}],
 ['foreign physical key',ref=>{ref.storageKey='flashback:foreign:records:shard:0000';}],
 ['wrong payload index',ref=>{ref.payloadShardIndex=1;}],
 ['wrong record count',ref=>{ref.recordCount++;}],
 ['wrong physical value digest',ref=>{ref.serializedValueDigest='0'.repeat(64);}]
])test('closed directory rejects '+name+' even with recomputed directory digest',async()=>{
 const f=await referenceFixture(1);
 try{
  mutation(f.head.rawPageReferences[0]);f.head.rawPageDirectoryDigest=await f.t.embeddingCheckpointDigest(f.head.rawPageReferences);await f.publish();
  const actual=await f.t.loadScopeRecordsRaw(f.scope);
  assert.equal(actual.records.length,0);
  assert(actual.manifest.manifestCorrupt===true||actual.manifest.corruptShards>0||actual.manifest.recordCountMismatch===true);
 }finally{await f.x.dispose();}
});

test('warm reference reader never supplies removed or validly altered physical raw from RAM',async()=>{
 const f=await referenceFixture(1);
 try{
  assert.equal((await f.t.loadScopeRecordsRaw(f.scope)).records.length,1);
  const ref=f.refs[0],raw=await f.x.pluginStorage.getItem(ref.storageKey);
  await f.x.pluginStorage.removeItem(ref.storageKey);
  let actual=await f.t.loadScopeRecordsRaw(f.scope);assert.equal(actual.records.length,0);assert.equal(actual.manifest.missingShards,1);
  const changed=JSON.parse(raw);changed.records[0].text+=' altered after publication';changed.checksum=f.t.storageShardChecksum(changed.records);
  await f.x.pluginStorage.setItem(ref.storageKey,JSON.stringify(changed));
  actual=await f.t.loadScopeRecordsRaw(f.scope);assert.equal(actual.records.length,0);assert.equal(actual.manifest.corruptShards,1);
 }finally{await f.x.dispose();}
});

test('ordinary full rewrite of a reference layout writes an intact v2 generation',async()=>{
 const f=await referenceFixture(65);
 try{
  await f.x.t.saveAllRecords(f.before.records,f.x.cfg,f.x.scope);
  const actual=await f.t.loadScopeRecordsRaw(f.scope);
  assert.equal(actual.records.length,65);assert.equal(actual.manifest.manifestCorrupt,undefined);
  assert(!actual.manifest.rawPageLayout);assert(!actual.manifest.rawPageReferences);
  for(const old of f.before.records){const record=actual.records.find(r=>r.sourceHash===old.sourceHash);assert(record);assert.equal(record.text,old.text);assert.deepEqual(f.x.clone(record.vector),f.x.clone(old.vector));}
 }finally{await f.x.dispose();}
});

test('v2 conversion and listed cleanup conservatively retain prior reference physical pages',async()=>{
 const f=await referenceFixture(65);
 try{
  f.head.commitId=f.before.manifest.commitId;await f.publish();
  const expected=new Map(await Promise.all(f.refs.map(async ref=>[ref.storageKey,await f.x.pluginStorage.getItem(ref.storageKey)])));
  await f.t.saveScopeRecords(f.x.scope,f.before.records,f.x.cfg,f.x.scope);
  const current=await f.x.t.loadScopeManifest(f.scope);
  for(const [key,raw]of expected)assert.equal(await f.x.pluginStorage.getItem(key),raw,'ordinary conversion retains the prior reference physical page');
  assert.equal(current.rawPageRetentionRequired,true,'no automatic collector may discard unproved reference generations after v2 conversion');
  await f.t.cleanupListedScopeShardOrphans(f.scope,current.commitId);
  for(const [key,raw]of expected)assert.equal(await f.x.pluginStorage.getItem(key),raw,'listed cleanup retains every authenticated previous page');
 }finally{await f.x.dispose();}
});

test('explicit same-chat owner recovery copies a reference source into an intact recipient v2 generation',async()=>{
 const f=await referenceFixture(65);
 try{
  const target={...f.x.scope,scopeKey:f.scope+'-recipient',personaId:'recipient-persona'};
  const result=await f.x.t.cloneScopeStorage(f.x.scope,target,f.x.cfg,{mode:'same_chat_persona_recovery'});assert.equal(result.ok,true);
  const actual=await f.t.loadScopeRecordsRaw(target.scopeKey);
  assert.equal(actual.records.length,65);assert(!actual.manifest.rawPageLayout);assert(!actual.manifest.rawPageReferences);
  for(const old of f.before.records){const record=actual.records.find(r=>r.sourceHash===old.sourceHash);assert(record);assert.equal(record.text,old.text);assert.deepEqual(f.x.clone(record.vector),f.x.clone(old.vector));assert.equal(record.scopeKey,target.scopeKey);}
  assert.equal((await f.t.loadScopeRecordsRaw(f.scope)).records.length,65);
 }finally{await f.x.dispose();}
});

test('actual portable export keeps every referenced older physical raw page and vector dependency',async()=>{
 const f=await referenceFixture(65);
 try{
  const portable=f.x.f.context.__FlashbackPortableMemoryBackup;assert(portable);
  const envelope=await portable.exportCurrentScope();await portable.validateBackup(envelope);
  for(const ref of f.refs)assert(envelope.records.some(r=>r.key===ref.storageKey));
  assert.equal(envelope.localVectorSidecars.length,2);
  const fresh=await createCostFixture({precomputedVectors:true,chat:f.x.f.currentChat});
  try{
   const restored=await fresh.f.context.__FlashbackPortableMemoryBackup.restoreCurrentScope(envelope);
   assert(restored);const actual=await fresh.f.context.__appendCost.loadScopeRecordsRaw(f.scope);
   assert.equal(actual.records.length,65);assert.equal(actual.manifest.rawPageDirectoryDigest,f.head.rawPageDirectoryDigest);
   for(const old of f.before.records){const record=actual.records.find(r=>r.sourceHash===old.sourceHash);assert(record);assert.equal(record.text,old.text);assert.equal(record.sourceId,old.sourceId);assert.deepEqual(fresh.clone(record.sourceMessageIds),f.x.clone(old.sourceMessageIds));assert.deepEqual(fresh.clone(record.vector),f.x.clone(old.vector));}
   assert.equal(fresh.providerCalls(),0);
  }finally{await fresh.dispose();}
 }finally{await f.x.dispose();}
});

for(const damage of ['removed','altered'])test('portable export refuses '+damage+' referenced physical page after warm read',async()=>{
 const f=await referenceFixture(1);
 try{
  assert.equal((await f.t.loadScopeRecordsRaw(f.scope)).records.length,1);
  if(damage==='removed')await f.x.pluginStorage.removeItem(f.refs[0].storageKey);
  else{const page=JSON.parse(await f.x.pluginStorage.getItem(f.refs[0].storageKey));page.records[0].text+=' changed';page.checksum=f.t.storageShardChecksum(page.records);await f.x.pluginStorage.setItem(f.refs[0].storageKey,JSON.stringify(page));}
  await assert.rejects(f.x.f.context.__FlashbackPortableMemoryBackup.exportCurrentScope(),/active_shard_(?:missing|digest_invalid)/);
 }finally{await f.x.dispose();}
});

test('warm reference raw survives removed vector page without false vector readiness',async()=>{
 const f=await referenceFixture(1);
 try{
  const warm=await f.t.loadScopeRecordsRaw(f.scope);assert.equal(warm.records[0].vector.length,32);
  const key=warm.records[0].vectorRef.storageKey;await f.x.safeLocalStorage.removeItem(key);
  const actual=await f.t.loadScopeRecordsRaw(f.scope);assert.equal(actual.records.length,1);assert.equal(actual.records[0].text,warm.records[0].text);
  assert.equal(actual.records[0].vector.length,0);assert.equal(actual.records[0].vectorPayloadMissing,true);
 }finally{await f.x.dispose();}
});

test('reference reader rejects a foreign vector payload envelope without losing its durable raw',async()=>{
 const f=await referenceFixture(1);
 try{
  const warm=await f.t.loadScopeRecordsRaw(f.scope),key=warm.records[0].vectorRef.storageKey;
  const raw=await f.x.safeLocalStorage.getItem(key),payload=typeof raw==='string'?JSON.parse(raw):f.x.clone(raw);payload.scopeKey='foreign-owner';await f.x.safeLocalStorage.setItem(key,payload);
  const actual=await f.t.loadScopeRecordsRaw(f.scope);assert.equal(actual.records.length,1);assert.equal(actual.records[0].text,warm.records[0].text);
  assert.equal(actual.records[0].vector.length,0);assert.equal(actual.records[0].vectorPayloadMissing,true);
 }finally{await f.x.dispose();}
});

for(const damage of ['directory','removed-page','altered-page','removed-vector'])test('registered final consumer rejects '+damage+' after preparing reference recall',async()=>{
 const f=await referenceFixture(65,true);
 try{
  const query=[{role:'user',chatId:'cow-query',content:'Find the codeword SigilaaaabA and its brass ledger.'}];
  const good=await f.x.f.api._selectionTest.beforeRequest(query,'model');
  const state=f.t.Runtime.lastRecall;
  assert(JSON.stringify(good).includes('The codeword SigilaaaabA'),'positive final consumer must use the seeded source '+JSON.stringify({reason:state?.reason,skipped:state?.skipped,readiness:state?.modelReadiness,candidates:state?.candidates,query:state?.queryText,mockQueryCalls:f.x.mockQueryCalls(),lastError:f.t.Runtime.lastError,output:good}));
  assert.equal((await f.x.t.loadScopeManifest(f.scope)).rawPageLayout,'flashback.raw_pages.v1','positive request must consume the reference format rather than convert the fixture');
  f.x.f.context.__rawCowBeforeConsumer=async recall=>{
   assert(recall.records.length>0,'tamper occurs after actual recall preparation');
   assert.equal((await f.x.t.loadScopeManifest(f.scope)).commitId,f.head.commitId,'tamper retains the actual prepared reference head');
   if(damage==='directory'){f.head.rawPageReferences[0].serializedValueDigest='0'.repeat(64);f.head.rawPageDirectoryDigest=await f.t.embeddingCheckpointDigest(f.head.rawPageReferences);await f.publish();}
   else if(damage==='removed-vector'){const page=JSON.parse(await f.x.pluginStorage.getItem(f.refs[0].storageKey));await f.x.safeLocalStorage.removeItem(page.records[0].vectorRef.storageKey);}
   else if(damage==='removed-page')await f.x.pluginStorage.removeItem(f.refs[0].storageKey);
   else{const page=JSON.parse(await f.x.pluginStorage.getItem(f.refs[0].storageKey));page.records[0].text+=' altered after recall';page.checksum=f.t.storageShardChecksum(page.records);await f.x.pluginStorage.setItem(f.refs[0].storageKey,JSON.stringify(page));}
  };
  const blocked=await f.x.f.api._selectionTest.beforeRequest(query,'model');assert(!JSON.stringify(blocked).includes('The codeword SigilaaaabA'),'final registered consumer must validate the physical reference selected in this request');
  assert.equal(f.x.providerCalls(),0);
 }finally{await f.x.dispose();}
});
