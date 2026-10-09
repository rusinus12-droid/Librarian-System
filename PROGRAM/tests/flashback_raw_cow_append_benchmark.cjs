'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {performance}=require('node:perf_hooks');
const {createCostFixture,hash,turnMarker,diskStore}=require('./fixtures/flashback_append_cost_fixture.cjs');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
const sizes=(arg('--sizes')||'10,100,1000,2000').split(',').map(Number),samples=Number(arg('--samples')||3);
const evidence=arg('--evidence');assert(evidence,'explicit isolated evidence directory is required');
const sourceSha256=hash(fs.readFileSync(path.resolve(__dirname,'../plugins/Flashback_Memory.js'))),rows=[];
const identity=records=>hash(records.map(r=>({text:r.text,sourceHash:r.sourceHash,sourceId:r.sourceId,sourceMessageIds:r.sourceMessageIds,vector:r.vector,logicalOrigin:r.embeddingWork?.logicalOrigin||null})));
async function query(x,target,stage){
 const text='Find the codeword '+turnMarker(target.turnIndex||target.pairIndex)+' and its brass ledger.';
 x.clearTrace();const began=performance.now(),result=await x.f.api.recallRecords(text,x.cfg,x.scope),elapsedMs=performance.now()-began;
 const selected=result.records.map(r=>r.record||r),rank=selected.findIndex(r=>r.sourceHash===target.sourceHash)+1;
 for(const r of selected){const found=x.currentSources().find(s=>s.sourceHash===r.sourceHash);assert(found,'selected source has actual fixture provenance');assert.equal(r.text,found.text);assert.equal(r.sourceId,found.sourceId);}
 return{stage,query:text,goldSourceHash:target.sourceHash,goldTextSha256:hash(target.text),rank:rank||null,recallAtSelected:rank?1:0,reciprocalRank:rank?1/rank:0,
  elapsedMs,selectedCount:selected.length,selectedSourceHashes:selected.map(r=>r.sourceHash),stageElapsed:result.stageElapsed||null,sparseCache:result.sparseCache||null,storage:result.storage||result.storageMetrics||null,io:x.ioSummary(x.trace),hookEmissionMeasured:false};
}
async function main(){
 for(const n of sizes)for(let sample=1;sample<=samples;sample++){
  const root=path.join(evidence,'n'+n+'-sample'+sample);assert(!fs.existsSync(root),'benchmark must start with a new isolated physical store');fs.mkdirSync(root,{recursive:true});
  const x=await createCostFixture({root,precomputedVectors:true});
  try{
   const seed=await x.seed(n);await x.t.retireExternalRecordsForScope(x.scope,{settings:x.cfg});const tail=await x.append(n+1),expectedIdentity=identity(tail.loaded.records);
   for(const old of seed.records){const current=tail.loaded.records.find(r=>r.sourceHash===old.sourceHash);assert(current);assert.equal(current.text,old.text);assert.equal(current.sourceId,old.sourceId);assert.deepEqual(x.clone(current.vector),x.clone(old.vector));}
   const turns=[...new Set([1,Math.max(1,Math.floor(n/2)),n])],queries=[];
   for(const turn of turns){queries.push(await query(x,seed.sources[turn-1],'first-in-this-realm'));queries.push(await query(x,seed.sources[turn-1],'same-query-warm'));}
   const fresh=await createCostFixture({root,chat:x.f.currentChat,precomputedVectors:true});let restart;
   try{restart=await query(fresh,seed.sources[0],'fresh-realm-same-query');const actual=await fresh.f.context.__appendCost.loadScopeRecordsRaw(x.scope.scopeKey);assert.equal(identity(actual.records),expectedIdentity);assert.equal(fresh.providerCalls(),0);}
   finally{await fresh.dispose();}
   const fallbackRoot=path.join(root,'authoritative-missing-index-control'),trace=[],plugin=diskStore(fallbackRoot,'plugin',trace),local=diskStore(fallbackRoot,'local',trace);
   for(const [key,value]of x.pluginStorage.values)await plugin.setItem(key,value);for(const [key,value]of x.safeLocalStorage.values)await local.setItem(key,value);
   const manifestKey=x.f.context.__appendCost.scopeKeys.manifest(x.scope.scopeKey),head=JSON.parse(await plugin.getItem(manifestKey));delete head.shardSummaries;head.shardIndexVersion=0;await plugin.setItem(manifestKey,JSON.stringify(head));
   const fallback=await createCostFixture({root:fallbackRoot,chat:x.f.currentChat,precomputedVectors:true});let full;
   try{const selection=fallback.t.selectRecallShardIndexes(head,'Find the codeword '+turnMarker(1)+' and its brass ledger.',[],null,null,fallback.cfg);assert.equal(selection.fullScan,true);assert.equal(selection.indexes.length,head.shardCount);
    full={...await query(fallback,seed.sources[0],'actual-missing-index-full-scan-control'),selection: fallback.clone(selection)};const actual=await fallback.f.context.__appendCost.loadScopeRecordsRaw(x.scope.scopeKey);assert.equal(identity(actual.records),expectedIdentity);assert.equal(fallback.providerCalls(),0);
   }finally{await fallback.dispose();}
   assert.equal(x.providerCalls(),0);
   const row={n,sample,sourceSha256,sourceTurnsBefore:n,sourceTurnsAfter:n+1,seedMs:seed.ms,datasetSourceDigest:seed.sourceDigest,retainedSourceVectorIdentity:expectedIdentity,
    rawSourceUtf8Bytes:seed.sources.reduce((sum,s)=>sum+Buffer.byteLength(s.text),0),appendedSourceSha256:tail.sourceSha256,appendedSourceHash:tail.source.sourceHash,appendedSourceId:tail.source.sourceId,appendedSourceUtf8Bytes:tail.sourceUtf8Bytes,
    appendMs:tail.durationMs,appendIo:tail.io,rawWrites:tail.events.filter(e=>e.op==='set'&&e.family==='rawShard').length,vectorWrites:tail.events.filter(e=>e.op==='set'&&e.family==='vector').length,
    layout:tail.loaded.manifest.rawPageLayout||'v2',physicalRawReferences:tail.loaded.manifest.rawPageReferences||null,storagePerformance:tail.result.storagePerformance||null,frontiers:tail.frontiers,
    queries,restart,fullScanControl:full,quality:{scope:'fixed exact-source gold with unique precomputed 32D sign vectors and fixture mock query vectors',recall:queries.reduce((sum,q)=>sum+q.recallAtSelected,0)/queries.length,mrr:queries.reduce((sum,q)=>sum+q.reciprocalRank,0)/queries.length},
    actualModelCalls:0,actualExternalRequests:0,mockQueryCalls:x.mockQueryCalls(),diskRoot:root};
   rows.push(row);fs.writeFileSync(path.join(root,'metrics.json'),JSON.stringify(row,null,2)+'\n','utf8');
   console.log(JSON.stringify({n,sample,appendMs:row.appendMs,rawWrites:row.rawWrites,rawReads:row.appendIo.byFamily['plugin/rawShard']?.reads,readBytes:row.appendIo.readBytes,writeBytes:row.appendIo.writeBytes,coldRanks:queries.filter(q=>q.stage==='first-in-this-realm').map(q=>q.rank),restartRank:restart.rank,fullScanRank:full.rank,actualModelCalls:0}));
  }finally{await x.dispose();}
 }
 const summary={createdAt:new Date().toISOString(),kind:'bounded-immutable-append-and-physical-recall-ladder',sourceSha256,sizes,samples,rows,actualModelCalls:0,
  limitations:['precomputed synthetic vectors are fixture data, not model quality','capture timing uses actual ingestSources; registered capture/final hook is a separate 128-source regression','initial seed timing includes fixture vector setup','query first-in-realm may share caches from setup; fresh-realm is separately measured','missing-index full-scan control is an explicit isolated physical manifest invalidation','next-turn worldline/full rewrite remains open','actual model/analysis/index-ready latency and sustained queue saturation are unmeasured','retained immutable generation safe GC and persistent recovery roots remain open']};
 const out=path.join(evidence,'metrics-all.json');fs.writeFileSync(out,JSON.stringify(summary,null,2)+'\n','utf8');const bytes=fs.readFileSync(out),decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);assert(!decoded.includes('\ufffd'));console.log(JSON.stringify({summary:out,rows:rows.length,sha256:hash(bytes),utf8:true,replacementCharacters:0}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
