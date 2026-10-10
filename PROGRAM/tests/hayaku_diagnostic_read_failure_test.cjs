'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
(async()=>{const r=await createHayakuRuntime();try{
 const old=r.host.pluginStorage.getItem.bind(r.host.pluginStorage);
 let reads=0,writes=0;const put=r.host.pluginStorage.setItem.bind(r.host.pluginStorage);
 r.host.pluginStorage.getItem=async key=>{if(String(key).includes('failed')){reads++;throw Error('injected_index_read_failure');}return old(key);};
 r.host.pluginStorage.setItem=async(k,v)=>{if(String(k).includes('failed'))writes++;return put(k,v);};
 const result=await r.hayaku._test.saveFailedAnalysisArtifact({scopeKey:'diagnostic-read-fault',kind:'incremental_recovery',failure:{code:'PRIMARY_EVIDENCE_FAILURE',message:'original failure'},chunk:{turn:1,text:'preserve source'}});
 assert.equal(result.durable,false);assert.equal(result.volatile,true);assert.ok(reads>0);assert.equal(writes,0);
 const saved=await r.hayaku._test.readFailedAnalysisArtifact('diagnostic-read-fault',result.failureId);
 assert.equal(saved.payload.failure.code,'PRIMARY_EVIDENCE_FAILURE');assert.equal(saved.payload.source.text,'preserve source');assert.equal(r.llmCalls.length,0);
 console.log('PASS index failure preserves volatile primary evidence without writes or model calls');
}finally{await r.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});
