'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {microReply,lensReply,transformSource,createLens,select}=require('./fixtures/libra_reanalysis_kinds_fixture.cjs');
for(const mode of ['plugin_only','mirror','server_only'])test('explicit Micro replacement remains readable after restart through '+mode,async()=>{
  const fx=await serverFixture({mode,transformSource});try{
    let f=fx.f;f.chat.message.splice(2);f.control.onCall=args=>microReply(args,'최초 미크로');
    let inventory=await f.r.api.listReanalysisRanges({kind:'micro'});assert.equal((await f.r.api.reanalyzeSelectedRanges(inventory)).ok,true);
    const prior=await f.r.api.debugReadActiveMicroMemory(1);assert.equal(prior.status,'verified');
    f.control.onCall=args=>microReply(args,'교체된 미크로');inventory=await f.r.api.listReanalysisRanges({kind:'micro'});const result=await f.r.api.reanalyzeSelectedRanges(inventory);assert.equal(result.ok,true,JSON.stringify(result));
    const after=await f.r.api.debugReadActiveMicroMemory(1);assert.equal(after.record.claims[0].text,'교체된 미크로');assert.notEqual(after.head.analysisRevisionId,prior.head.analysisRevisionId);
    f=await fx.restart();const restored=await f.r.api.debugReadActiveMicroMemory(1);assert.equal(restored.status,'verified',JSON.stringify(restored));assert.equal(restored.record.claims[0].text,'교체된 미크로');
    inventory=await f.r.api.listReanalysisRanges({kind:'micro'});assert.equal(inventory.ranges[0].status,'saved');
    assert.equal((await f.r.api.getCanonicalMemories()).length,0);assert.equal((await f.r.api.inspectScopeLenses()).memories.length,0);
  }finally{await fx.cleanup();}
});
for(const mode of ['plugin_only','mirror','server_only'])test('explicit lens reanalysis keeps its saved range and selected lens through '+mode,async()=>{
  const fx=await serverFixture({mode,transformSource});try{
    let f=fx.f;const a=await createLens(f,'기존 관점'),b=await createLens(f,'선택한 관점');f.control.onCall=()=>lensReply(f,1,'첫 렌즈 기록');
    assert.equal((await f.r.api.runLensForRange({lensId:b.lensId,startTurn:1,endTurn:2})).ok,true);
    const inventory=await f.r.api.listReanalysisRanges({kind:'lens',lensId:b.lensId}),before=await f.r.api.inspectScopeLenses();f.control.onCall=()=>lensReply(f,1,'교체된 렌즈 기록');
    const result=await f.r.api.reanalyzeSelectedRanges(select(inventory,'1-2'));assert.equal(result.ok,true,JSON.stringify(result));
    f=await fx.restart();const after=await f.r.api.inspectScopeLenses();assert.equal(after.lenses[a.lensId].recordCount,0);assert.equal(after.lenses[b.lensId].recordCount,1);assert.equal(after.memories[0].recordKey,before.memories[0].recordKey);assert.equal(after.memories[0].text,'교체된 렌즈 기록');
    assert.equal((await f.r.api.getCanonicalMemories()).length,0);assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).status,'missing');
  }finally{await fx.cleanup();}
});
