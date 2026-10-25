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
