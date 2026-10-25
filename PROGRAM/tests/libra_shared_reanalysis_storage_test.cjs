'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
for(const mode of ['mirror','server_only'])test('shared LIBRA review persists rules and replaces selected 5-turn memory through '+mode,async()=>{
  const fx=await serverFixture({mode,transformSource:source=>source.replace('const memoryStageEnabledForSettings =','globalThis.__sharedReviewCore=LibraMemoryCore;\n  const memoryStageEnabledForSettings =')});
  try{
    let f=fx.f;assert.equal((await f.run()).completed,1);await f.r.api.retryPendingUnifiedVectors();
    const old={...fx.getManifest().memories['1']},bytes=fx.storedRows().find(row=>row.key===old.key).raw;
    f.chat.message[1].data+='<drop>Private module output.</drop>';
    const core=f.r.context.__sharedReviewCore,before=await f.r.api.listReanalysisRanges(),sample=await core.readReanalysisTurn(before,before.ranges[0]);
    await f.r.api.setSourceEditRules({version:1,ignoredTags:['drop'],unwrapTags:[],sourceTags:[],controls:[]});
    const inventory=await f.r.api.listReanalysisRanges(),calls=f.control.calls.length;
    const result=await f.r.api.reanalyzeSelectedRanges({...inventory,ranges:[inventory.ranges[0]],reviewedSource:{key:'1',rawDigest:sample.rawDigest,rulesKey:core.sourceReanalysisRulesKey()}});
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.control.calls.length,calls+1);assert.ok(fx.getManifest().memories['1'].revision>old.revision);assert.equal(fx.storedRows().find(row=>row.key===old.key).raw,bytes);
    f=await fx.restart();await f.r.api.listReanalysisRanges();assert.equal(f.r.api.getSourceEditRules().ignoredTags.includes('drop'),true,'saved exclusion survives a fresh owner runtime');
    assert.ok(fx.requests.length>0,'actual owner storage bridge reached the local HTTP server');
  }finally{await fx.cleanup();}
});
for(const mode of ['mirror','server_only'])for(const initialStatus of ['missing','failed'])test('LIBRA '+initialStatus+' turn selection creates a canonical memory through '+mode,async()=>{
  const fx=await serverFixture({mode});try{
    const f=fx.f;if(initialStatus==='failed'){f.control.modelFails=true;const job=await f.run();assert.ok(job.failed>0);f.control.modelFails=false;}
    const batchInventory=await f.r.api.listCanonicalBatchRanges(),inventory=await f.r.api.listReanalysisRanges();assert.equal(inventory.ranges.length,5);
    // The server can retain a provider failure in the job journal while leaving
    // the canonical slot missing. Match the existing range classification and
    // verify that both states stay selectable through the restored turn UI.
    assert.ok(inventory.ranges.every(row=>row.status===batchInventory.ranges[0].status));
    assert.ok(['missing','failed'].includes(batchInventory.ranges[0].status));
    const calls=f.control.calls.length,result=await f.r.api.reanalyzeSelectedRanges({...inventory,ranges:[inventory.ranges[0],inventory.ranges[4]]});
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.control.calls.length,calls+1);assert.equal(fx.getManifest().memories['1'].status,'committed');
    assert.ok(fx.storedRows().some(row=>row.value?.schema==='libra.canonical_memory.v1'&&row.value.status==='committed'));
  }finally{await fx.cleanup();}
});
