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
for(const mode of ['plugin_only','mirror','server_only'])test('ten-turn lens cadence retains its first observed baseline across restart through '+mode,async()=>{
  const fx=await serverFixture({mode,transformSource});try{
    let f=fx.f;const lens=await f.r.api.createLens({name:'10턴 주기',instruction:{goal:'사건을 기록한다.'},cadence:{mode:'every_n_batches',everyNBatches:2},evidenceMode:'strict'});
    let core=f.r.context.__reanalysisKindsCore,context=await core.resolveContext();const first=await core.runScheduledLensesForCommittedBatch({context,memory:{turnRange:{start:1,end:5}}});assert.equal(first.queued.length,0);assert.equal(f.control.calls.length,0);
    f=await fx.restart();f.chat.message.push(...f.chat.message.slice().map((message,i)=>({...message,chatId:`t${6+Math.floor(i/2)}-${i%2?'a':'u'}`})));f.control.onCall=()=>lensReply(f);
    core=f.r.context.__reanalysisKindsCore;context=await core.resolveContext();const second=await core.runScheduledLensesForCommittedBatch({context,memory:{turnRange:{start:6,end:10}}});assert.equal(second.queued.length,1);await core.waitForLensQueueIdle();
    assert.equal(f.control.calls.length,1);const data=await f.r.api.inspectScopeLenses();assert.equal(data.lenses[lens.lensId].recordCount,1);assert.equal(data.memories[0].turnRange.start,1);assert.equal(data.memories[0].turnRange.end,10);
  }finally{await fx.cleanup();}
});
