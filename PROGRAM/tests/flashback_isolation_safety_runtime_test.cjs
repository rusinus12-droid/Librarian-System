'use strict';
// Real full plugin functions; host/provider/storage are controlled I/O only.
const assert=require('node:assert/strict'),path=require('node:path');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
(async()=>{
 const f=await createFlashback(path.resolve(__dirname,'..'));
 try {
  const t=f.api._test;
  const cfg=t.normalizeSettings({embeddingEnabled:true,embeddingProvider:'voyage_context',embeddingUrl:'https://fixture.invalid/contextualizedembeddings',embeddingModel:'context-fixture',embeddingDimensions:0,embeddingBatchSize:8,embeddingMaxRetries:0,fallbackHashEmbedding:false,episodeIndexEnabled:false});
  const calls=[];
  f.host.nativeFetch=async(_url,init)=>{const body=JSON.parse(init.body);calls.push(body.inputs);
    return new Response(JSON.stringify({data:body.inputs.map((group,index)=>({index,data:group.map((text,index)=>({index,embedding:text==='bad-chunk'?[0,0,0]:[1,0,0]}))}))}),{status:200});};
  const vectors=await t.embedTextsIsolated(['sibling-chunk','bad-chunk','healthy-turn'],cfg,{cacheMode:'bypass',disableCheckpoint:true,allowHashFallback:false,contextGroupIds:['T32','T32','T33']});
  assert.equal(vectors[0].length,0);assert.equal(vectors[1].length,0);assert.equal(vectors[2].length,3);
  assert.equal(vectors.flashbackPendingIndexes.length,2);
  assert(calls.some(groups=>groups.length===1&&groups[0].length===2&&groups[0][1]==='bad-chunk'),'retry preserves original contextual group');
  assert(!calls.some(groups=>groups.length===1&&groups[0].length===1&&['bad-chunk','sibling-chunk'].includes(groups[0][0])),'no single-chunk contextual retry');
  console.log('PASS contextual failure retries whole source group; healthy source isolated');

  const dense=t.normalizeSettings({...cfg,embeddingProvider:'openai_compat',embeddingUrl:'https://fixture.invalid/v1',embeddingModel:'dense-fixture',embeddingDimensions:3,chunkChars:256,chunkOverlap:0});
  f.host.nativeFetch=async(_url,init)=>{const body=JSON.parse(init.body);return new Response(JSON.stringify({data:body.input.map((text,index)=>({index,embedding:text.includes('BAD_SENTINEL')?[0,0,0]:[1,0,0]}))}),{status:200});};
  const body=Array.from({length:100},(_,i)=>`Alice inspected cabinet ${i} and placed the blue document on its shelf.`).join('\n')+'\nBAD_SENTINEL: the last cabinet remained locked.';
  const records=await t.buildRecordsFromSources([{sourceType:'response',sourceId:'long-turn',sourceHash:'long-source',pairIndex:32,text:body}],dense,{scopeKey:'scope-chunks'},{allowHashFallback:false});
  assert.equal(records.length,0,'one failed chunk holds back entire source turn');assert(records.flashbackIsolatedCount>0);assert.equal(records.flashbackEmbeddingStats.totalVectors,0);
  console.log('PASS incomplete multi-chunk U+A is never published as a complete replacement');

  for(const failure of ['auth','cancel','stale']){
   let calls=0;const controller=new AbortController();
   f.host.nativeFetch=async(_url,init)=>{calls++;const body=JSON.parse(init.body);
    if(calls===1){ if(failure==='cancel')controller.abort(); if(failure==='stale')t.abortEmbeddingJobs('test_source_changed'); return new Response(JSON.stringify({data:body.input.map((_,index)=>({index,embedding:[0,0,0]}))}),{status:200}); }
    return new Response('{"error":{"message":"unauthorized"}}',{status:401});};
   await assert.rejects(()=>t.embedTextsIsolated(['request-'+failure],dense,{cacheMode:'bypass',disableCheckpoint:true,signal:controller.signal,allowHashFallback:false}));
   assert(calls<=2,'bounded retry even on request-scoped failure');
  }
  console.log('PASS authentication/cancel/stale-source are not hidden as item-level pending');
 } finally {await f.cleanup();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
