'use strict';
const assert=require('node:assert/strict');const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
(async()=>{for(const mode of ['off','verify','retry_once']){
 const r=await createHayakuRuntime({failedRecoveryAutomation:mode});try{
  assert.equal(r.hayaku.recovery.failedAnalysis.automationStatus,undefined);
  assert.equal(r.hayaku._test.scheduleFailedAutoRecovery,undefined);
  assert.equal(r.hayaku._test.runFailedAutoRecovery,undefined);
  assert.equal(r.hayaku.memory?.failedRecoveryAutomation,undefined);
  assert.equal(r.llmCalls.length,0);
 }finally{await r.dispose();}
}console.log('PASS removed worker and automation API, including legacy settings');})().catch(e=>{console.error(e);process.exitCode=1;});
