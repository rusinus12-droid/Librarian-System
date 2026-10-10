'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {performance}=require('node:perf_hooks');
const {createCostFixture,hash,turnMarker}=require('./fixtures/flashback_append_cost_fixture.cjs');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
const sizes=(arg('--sizes')||'10,100,1000,2000').split(',').map(Number),samples=Number(arg('--samples')||1);
const precomputedVectors=arg('--vectors')==='precomputed';
const evidence=arg('--evidence')||path.join(process.env.TEMP,'LIB-WM-RestorePhase2-20261002/evidence/Flashback-append-cost/baseline-ladder');
const rows=[],sourceSha256=hash(fs.readFileSync(path.resolve(__dirname,'../plugins/Flashback_Memory.js')));
const main=async()=>{
 for(const n of sizes)for(let sample=1;sample<=samples;sample++){
  const root=path.join(evidence,'n'+n+'-sample'+sample);fs.mkdirSync(root,{recursive:true});
  const x=await createCostFixture({root,precomputedVectors});
  try{
   const seed=await x.seed(n),tail=await x.append(n+1);
   const queries=[];
   for(const turn of [...new Set([1,Math.max(1,Math.floor(n/2)),n])]){
    const marker=turnMarker(turn),q='Find the codeword '+marker+' and its brass ledger.';
    x.clearTrace();const started=performance.now(),result=await x.f.api.recallRecords(q,x.cfg,x.scope),ms=performance.now()-started;
    const selected=result.records.map(r=>r.record||r),target=seed.sources[turn-1];
    const rank=selected.findIndex(r=>r.sourceHash===target.sourceHash)+1;
    queries.push({query:q,goldTurn:turn,goldSourceHash:target.sourceHash,goldSourceSha256:hash(target.text),rank:rank||null,recallAtSelected:rank>0?1:0,
     reciprocalRank:rank>0?1/rank:0,totalMs:ms,selectedCount:selected.length,selectedSourceHashes:selected.map(r=>r.sourceHash),stageElapsed:result.stageElapsed||null,sparseCache:result.sparseCache||null,storage:result.storage||result.storageMetrics||null,
     io:x.ioSummary(x.trace),stage:'production_recall_selection_no_final_hook_emission'});
   }
   assert.equal(x.providerCalls(),0);
   const row={n,sample,sourceSha256,datasetSourceDigest:seed.sourceDigest,sourceTurns:n,rawRecords:seed.records.length,
    rawSourceUtf8Bytes:seed.sources.reduce((s,r)=>s+Buffer.byteLength(r.text),0),seedMs:seed.ms,
    appendedSourceSha256:tail.sourceSha256,appendedSourceUtf8Bytes:tail.sourceUtf8Bytes,
    appendTotalMs:tail.durationMs,appendIo:tail.io,rawShardWrites:tail.events.filter(e=>e.op==='set'&&e.family==='rawShard').length,shardCount:tail.loaded.manifest.shardCount,
    storagePerformance:tail.result.storagePerformance||null,frontiers:tail.frontiers,queries,
    quality:{scope:precomputedVectors?'fixed exact-source gold with precomputed unique 32D sign vectors and mock query vectors; not natural-language semantic quality':'raw-only vectors disabled; readiness rejection is not search performance certification',goldQueries:queries.length,recall:queries.reduce((s,q)=>s+q.recallAtSelected,0)/queries.length,mrr:queries.reduce((s,q)=>s+q.reciprocalRank,0)/queries.length},
    actualModelCalls:0,actualExternalRequests:0,providerCalls:0,mockQueryCalls:x.mockQueryCalls(),diskRoot:root};
   rows.push(row);fs.writeFileSync(path.join(root,'metrics.json'),JSON.stringify(row,null,2)+'\n','utf8');
   console.log(JSON.stringify({n,sample,seedMs:row.seedMs,appendMs:row.appendTotalMs,rawShardWrites:row.rawShardWrites,rawShardReads:row.appendIo.byFamily['plugin/rawShard']?.reads,
    readBytes:row.appendIo.readBytes,writeBytes:row.appendIo.writeBytes,queryMs:queries.map(q=>q.totalMs),goldRanks:queries.map(q=>q.rank),providerCalls:0}));
  }finally{await x.dispose();}
 }
 const summary={createdAt:new Date().toISOString(),kind:precomputedVectors?'actual-source-disk-host-precomputed-lexical-gold-baseline':'actual-source-disk-host-raw-only-baseline',sourceSha256,sizes,samples,guarded:true,actualModelCalls:0,
  unmeasured:['actual provider latency','canonical analysis ready','semantic vector ready','actual host browser scheduling','registered final consumer emission','authoritative fallback comparison','generation durable ack/queue wait/memory ready/index ready separated timings'],
  rows};
 const out=path.join(evidence,'metrics-all.json');fs.writeFileSync(out,JSON.stringify(summary,null,2)+'\n','utf8');
 const bytes=fs.readFileSync(out),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);assert(!text.includes('\ufffd'));
 console.log(JSON.stringify({summary:out,rows:rows.length,bytes:bytes.length,sha256:hash(bytes),utf8:true,replacementCharacters:0}));
};
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
