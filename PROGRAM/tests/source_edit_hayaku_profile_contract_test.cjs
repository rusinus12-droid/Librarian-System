'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');

(async()=>{
  const runtime=await createHayakuRuntime({messages:[]});
  try{
    const api=runtime.hayaku;
    assert.equal(api.getSourceEditSyncStatus().mode,'auto','HAYAKU starts in automatic source reconciliation mode');
    const stopped=await api.setSourceEditTrackingMode('off');
    assert.equal(stopped.mode,'off');
    const resumed=await api.setSourceEditTrackingMode('auto');
    assert.equal(resumed.mode,'auto');
    const manual=await api.reviewSourceEdits();
    assert.equal(manual.ok,false);
    assert.equal(manual.reason,'automatic_before_request_only');
    assert.equal(runtime.llmCalls.length,0,'changing mode and rejecting a manual review do not call a provider');
    console.log(JSON.stringify({test:'source_edit_hayaku_profile_contract',passed:5}));
  }finally{await runtime.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1});
