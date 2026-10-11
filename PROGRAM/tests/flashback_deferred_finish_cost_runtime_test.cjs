'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {test}=require('node:test');
const {createCostFixture,diskStore,turnMessages}=require('./fixtures/flashback_finish_attribution_fixture.cjs');
const assertOneFreshTail=reads=>assert.equal(reads.length,1,'a deferred pending-only result needs one fresh tail read rather than two complete corpus scans');
test('deferred finalized raw acknowledgement checks its physical tail without two redundant full-scope readiness scans',async()=>{
 const scoped=process.env.FLASHBACK_FINISH_LEGACY_GLOBAL_ATTRIBUTION!=='1';
 const realStartupOverlap=true;
 const x=await createCostFixture({finishReadAttribution:true,scopedFinishAttribution:scoped,realStartupOverlap,beforeFinish:realStartupOverlap?async({waitForRealStartupRead})=>waitForRealStartupRead():undefined});
 try{
  await x.seed(128);
  const tail=await x.append(129),reads=tail.events.filter(e=>e.op==='get'&&e.family==='rawShard'&&e.phase==='finish');
  assert.equal(tail.result.embeddingComplete,false);assert.equal(tail.result.embeddingPending,1);assert.equal(x.providerCalls(),0);
  assert.equal(tail.result.embeddingWork.reason,'raw_publication_pending_only');
  assert.equal(tail.result.embeddingWork.currentScopeReadVerified,false);
  assert.equal(tail.result.embeddingWork.selectedPhysicalRawVerified,true);
  assert.equal(tail.result.embeddingWork.semanticReady,false);
  const outsiders=tail.events.filter(e=>e.op==='get'&&e.family==='rawShard'&&e.backgroundOrigin==='restoreLegacyCompactedSourceScope'&&e.legacyPhase==='finish');
  assert.equal(outsiders.length,2,'two actual scheduled startup reads overlap the finish window');
  assert(outsiders.every(e=>e.finishOperationId===null&&e.asyncPhase===null),'scheduled startup reads have an independent async origin');
  assert.equal(tail.events.find(e=>e.op==='publication-pages').pageCount,1,'private publication receipt selects only the fresh tail');
  const evidence={phase:'deferred_finish_physical_tail',rawShardReads:reads.length,totalRawShardReads:tail.events.filter(e=>e.op==='get'&&e.family==='rawShard').length,scheduledOutsideFinishReads:outsiders.length,readBytes:reads.reduce((n,e)=>n+e.bytes,0),expectedRawShardReads:1,actualModelCalls:0,startupReadOverlap:tail.events.filter(e=>e.op==='startup-read-origin'),publicationPages:tail.events.filter(e=>e.op==='publication-pages'),attributionMode:scoped?'async-operation':'legacy-global',rawShardReadAttribution:tail.events.filter(e=>e.op==='get'&&e.family==='rawShard').map(({key,bytes,phase,asyncPhase,finishOperationId,legacyPhase,backgroundOrigin,backgroundReadOrdinal,readStack})=>({key,bytes,phase,asyncPhase,finishOperationId,legacyPhase,backgroundOrigin,backgroundReadOrdinal,readStack})),sourceSha256:x.hash(fs.readFileSync(path.resolve(__dirname,'../plugins/Flashback_Memory.js')))};
  const out=process.env.FLASHBACK_DEFERRED_EVIDENCE;if(out){fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(evidence,null,2)+'\n','utf8');}
  console.log(JSON.stringify(evidence));assertOneFreshTail(reads);
  // Real scheduled startup overlap proves that unrelated reads remain in total I/O.
  // A nested finish-owned read still fails the identical one-read obligation.
  if(scoped)for(const nestedOwnedRead of [false,true]){
   const concurrent=await createCostFixture({finishReadAttribution:true,scopedFinishAttribution:true,beforeFinish:async({f,readOutsideFinish},scope)=>{await readOutsideFinish();if(nestedOwnedRead)await Promise.resolve().then(()=>f.context.__appendCost.loadScopeRecordsRaw(scope.scopeKey));}});
   try{await concurrent.seed(8);const overlap=await concurrent.append(9),all=overlap.events.filter(e=>e.op==='get'&&e.family==='rawShard'),owned=all.filter(e=>e.phase==='finish'),outsider=all.filter(e=>e.legacyPhase==='finish'&&e.finishOperationId===null);
    assert.equal(owned.length,nestedOwnedRead?2:1,'count every finish-owned read, including nested async descendants; exclude only the unrelated operation');
    if(nestedOwnedRead)assert.throws(()=>assertOneFreshTail(owned),assert.AssertionError,'nested finish-owned reads must fail the same exact one-read obligation');
    assert(outsider.length>=1,'a real concurrent outside-operation physical read remains visible in total I/O');
    assert(all.length>owned.length,'total I/O must retain unrelated reads');
    assert(owned.every(e=>e.finishOperationId!==null&&e.asyncPhase==='finish'));
    assert.equal(overlap.result.embeddingWork.reason,'raw_publication_pending_only');assert.equal(concurrent.providerCalls(),0);
    console.log(JSON.stringify({phase:'concurrent_finish_attribution_negative',nestedOwnedRead,totalRawShardReads:all.length,finishOwnedRawShardReads:owned.length,outsideOperationRawShardReads:outsider.length,publicationPages:overlap.events.filter(e=>e.op==='publication-pages')}));
   }finally{await concurrent.dispose();}
  }
 }finally{await x.dispose();}
});

test('registered finalized output persists exact raw provenance, drops duplicate and remains pending after restart',async()=>{
 const x=await createCostFixture({settings:{captureAfterRequest:true}});
 try{const deadline=Date.now()+10000;while(!x.f.api.getCaptureBackendState().registered){assert(Date.now()<deadline);await new Promise(r=>setTimeout(r,20));}
  await x.seed(0);const pair=turnMessages(1);
  await x.f.api._selectionTest.beforeRequest([{role:'user',chatId:pair[0].chatId,content:pair[0].data}],'model');
  const tail=await x.append(1,'A','output'),record=tail.loaded.records.find(r=>r.sourceHash===tail.source.sourceHash);
  assert(record);assert.equal(record.text,'User:\n'+pair[0].data+'\n\n---\n\nAssistant:\n'+pair[1].data);
  assert.equal(record.metadata.captureAuthority.source,'risu_chat_output');assert(record.metadata.sourceRawDigest);assert(record.sourceHash);assert(record.sourceId);
  assert.equal(tail.result.embeddingWork.reason,'raw_publication_pending_only');assert.equal(tail.result.embeddingComplete,false);
  assert(tail.frontiers.durableAckMs>=0&&tail.frontiers.durableAckMs<=tail.frontiers.criticalPathMs);
  const before=x.f.api.getCaptureBackendState();await x.f.dispatchRisuChatEvent('output',{char:x.f.character,chat:x.f.currentChat,characterIndex:0,chatIndex:0,messageIndex:1});
  const duplicateDeadline=Date.now()+5000;while(x.f.api.getCaptureBackendState().duplicateDrops<=before.duplicateDrops){assert(Date.now()<duplicateDeadline);await new Promise(r=>setTimeout(r,20));}
  const after=await x.read();assert.equal(after.records.length,1);assert.equal(after.records[0].sourceHash,record.sourceHash);assert.equal(after.records[0].text,record.text);
  const fresh=await createCostFixture({root:x.root,chat:x.f.currentChat});try{const actual=await fresh.read(),found=actual.records.find(r=>r.sourceHash===record.sourceHash);
   assert(found);assert.equal(found.text,record.text);assert.equal(found.sourceId,record.sourceId);assert.deepEqual(fresh.clone(found.metadata.captureAuthority),x.clone(record.metadata.captureAuthority));assert.equal(found.metadata.sourceRawDigest,record.metadata.sourceRawDigest);
   assert.equal(found.vector.length,0);assert(found.embeddingWork);assert.equal(fresh.providerCalls(),0);
  }finally{await fresh.dispose();}
  assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

for(const mutation of ['profile','generation','worldline','manifest','scope','owner','backend-url'])test('publication receipt falls back on '+mutation+' boundary change after ACK',async()=>{
 const x=await createCostFixture({beforeFinish:async({f,pluginStorage,trace},scope,settings)=>{
  if(mutation==='profile')await f.api.saveSettings({...settings,embeddingModel:'changed-profile'});
  if(mutation==='generation')f.context.__appendCost.Runtime.embeddingGeneration++;
  if(mutation==='worldline'){
   const key=f.context.__appendCost.scopeKeys.worldline(scope.scopeKey),raw=await pluginStorage.getItem(key),value=raw?JSON.parse(raw):{scopeKey:scope.scopeKey};
   value.revision=Number(value.revision||0)+1;await pluginStorage.setItem(key,JSON.stringify(value));
  }
  if(mutation==='manifest'){
   const key=f.context.__appendCost.scopeKeys.manifest(scope.scopeKey),value=JSON.parse(await pluginStorage.getItem(key));
   value.updatedAt='2040-01-01T00:00:00.000Z';await pluginStorage.setItem(key,JSON.stringify(value));
  }
  if(mutation==='scope'){f.currentChat.id='other-chat';f.currentChat.chatId='other-chat';}
  if(mutation==='owner'){
   const replacement=diskStore(path.join(pluginStorage.dir,'replacement'),'plugin',trace);
   for(const [key,value]of pluginStorage.values)await replacement.setItem(key,value);
   f.host.pluginStorage=replacement;
  }
  if(mutation==='backend-url')await f.context.__fixtureStorageBridge.setServerUrl('http://127.0.0.1:39491');
 }});
 try{await x.seed(8);const tail=await x.append(9);assert.equal(tail.result.embeddingWork.reason,'raw_embedding_deferred');
  assert.equal(tail.result.embeddingComplete,false);assert.equal(tail.result.embeddingPending,1);assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});

test('verified private publication receipt is consumed once and is unavailable in a fresh realm',async()=>{
 const x=await createCostFixture();try{await x.seed(8);const tail=await x.append(9),publication=x.f.context.__appendCostPublication;
  const second=await x.f.context.__appendCost.finishPublishedRawEmbedding(x.scope,x.cfg,tail.loaded.records.filter(r=>r.sourceHash===tail.source.sourceHash),{deferEmbedding:true},publication);
  assert.equal(second.embeddingWork.reason,'raw_embedding_deferred');assert.equal(second.embeddingComplete,false);
  const fresh=await createCostFixture({root:x.root,chat:x.f.currentChat});try{const actual=await fresh.read();const record=actual.records.find(r=>r.sourceHash===tail.source.sourceHash);
   assert.equal(record.text,tail.source.text);assert.equal(record.sourceId,tail.source.sourceId);
   assert.equal(record.sourceHash,tail.source.sourceHash);assert.equal(fresh.hash(record.text),tail.sourceSha256);
   const next=await fresh.f.context.__appendCost.finishPublishedRawEmbedding(fresh.scope,fresh.cfg,[record],{deferEmbedding:true},publication);
   assert.equal(next.embeddingWork.reason,'raw_embedding_deferred');assert.equal(next.embeddingComplete,false);assert.equal(fresh.providerCalls(),0);
  }finally{await fresh.dispose();}
 }finally{await x.dispose();}
});

for(const damage of ['removed','altered'])test('raw-only receipt never certifies nonselected '+damage+' page as current corpus or semantic ready',async()=>{
 const x=await createCostFixture({precomputedVectors:true,beforeFinish:async({pluginStorage},scope,settings,records)=>{
  const row=[...pluginStorage.values].find(([key,value])=>key.includes(':shard:')&&String(value).includes('SigilaaaabA')&&!String(value).includes(records[0].sourceHash));assert(row);
  if(damage==='removed')fs.unlinkSync(pluginStorage.fileFor(row[0]));else{const e=JSON.parse(fs.readFileSync(pluginStorage.fileFor(row[0]),'utf8'));e.value='{altered-after-ack';fs.writeFileSync(pluginStorage.fileFor(row[0]),JSON.stringify(e),'utf8');}
 }});
 try{await x.seed(128);const tail=await x.append(129);assert.equal(tail.result.embeddingWork.reason,'raw_publication_pending_only');
  assert.equal(tail.result.embeddingWork.currentScopeReadVerified,false);assert.equal(tail.result.embeddingComplete,false);
  const fresh=await createCostFixture({root:x.root,chat:x.f.currentChat,precomputedVectors:true});try{
   const actual=await fresh.read();assert(actual.manifest.missingShards>0);
   await assert.rejects(fresh.f.api.inspectEmbeddingWork(),/incomplete|missing|corrupt/i);
   const messages=await fresh.f.api._selectionTest.beforeRequest([{role:'user',chatId:'fresh-query',content:'Find the codeword SigilaaaabA and its brass ledger.'}],'model');
   assert(!JSON.stringify(messages).includes('The codeword SigilaaaabA'),'final consumer cannot emit unavailable source');assert.equal(fresh.providerCalls(),0);
  }finally{await fresh.dispose();}
 }finally{await x.dispose();}
});

for(const damage of ['removed','altered'])test('same owner/backend/manifest after ACK refuses '+damage+' selected physical raw page',async()=>{
 let damaged=false;
 const x=await createCostFixture({beforeFinish:async({f,pluginStorage},scope,settings,records)=>{
  const row=[...pluginStorage.values].find(([key,value])=>key.includes(':shard:')&&String(value).includes(records[0].sourceHash));
  assert(row,'published raw page exists before damage');
  if(damage==='removed')fs.unlinkSync(pluginStorage.fileFor(row[0]));
  else{const e=JSON.parse(fs.readFileSync(pluginStorage.fileFor(row[0]),'utf8'));const page=JSON.parse(e.value);page.records[0].text+=' altered-after-ack';page.checksum=f.context.__appendCost.storageShardChecksum(page.records);e.value=JSON.stringify(page);fs.writeFileSync(pluginStorage.fileFor(row[0]),JSON.stringify(e),'utf8');}
  damaged=true;
 }});
 try{await x.seed(128);await assert.rejects(x.append(129),error=>error.code==='FLASHBACK_RAW_PUBLICATION_READBACK_FAILED');assert(damaged);assert.equal(x.providerCalls(),0);
  const fresh=await createCostFixture({root:x.root,chat:x.f.currentChat});try{const actual=await fresh.read();
   if(damage==='removed')assert(actual.manifest.missingShards>0||actual.manifest.corruptShards>0);
   else if(actual.manifest.rawPageLayout==='flashback.raw_pages.v1'){
    assert(actual.manifest.missingShards>0||actual.manifest.corruptShards>0,'reference format detects exact physical digest mismatch');
    assert(!actual.records.some(record=>record.text.endsWith(' altered-after-ack')),'reference reader refuses changed raw despite a repaired local checksum');
   }else assert(actual.records.some(record=>record.text.endsWith(' altered-after-ack')),'v2 physical reader exposes self-checksummed alteration despite unchanged head');
   assert.equal(fresh.providerCalls(),0);
  }finally{await fresh.dispose();}
 }finally{await x.dispose();}
});

test('a caller supplied publication object cannot bypass physical full-scope readback',async()=>{
 const x=await createCostFixture();try{const seeded=await x.seed(128);x.clearTrace();
  const result=await x.f.context.__appendCost.finishPublishedRawEmbedding(x.scope,x.cfg,seeded.records.slice(-1),{deferEmbedding:true},{manifest:seeded.manifest,records:seeded.records});
  assert.equal(result.embeddingComplete,false);assert.equal(result.embeddingWork.reason,'raw_embedding_deferred');
  assert(x.trace.filter(e=>e.op==='get'&&e.family==='rawShard'&&e.phase==='finish').length>=seeded.manifest.shardCount*2);assert.equal(x.providerCalls(),0);
 }finally{await x.dispose();}
});
