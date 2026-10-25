'use strict';
const assert=require('node:assert/strict');const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
(async()=>{const r=await createHayakuRuntime();try{
 assert.equal(r.hayaku.recovery.failedAnalysis.resolve,undefined);
 assert.equal(r.hayaku.recovery.failedAnalysis.inspectAdoption,undefined);
 assert.equal(r.hayaku._test.resolveFailedAnalysisArtifact,undefined);
 for(const method of ['list','read','summaries'])assert.equal(typeof r.hayaku.recovery.failedAnalysis[method],'function');
 assert.equal(r.llmCalls.length,0);
 console.log('PASS removed failure-resolution API; read-only diagnostics remain');
}finally{await r.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});
