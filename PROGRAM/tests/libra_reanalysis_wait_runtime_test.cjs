'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const {microReply,lensReply,transformSource,select,createLens}=require('./fixtures/libra_reanalysis_kinds_fixture.cjs');

async function setup(){
  const f=await fixture({transformSource});
  f.core=f.r.context.__reanalysisKindsCore;
  const job=await f.run();
  assert.ok(['completed','completed_with_warnings'].includes(job.state),JSON.stringify(job));
  return f;
}

async function holdStateReplay(f){
  let release,held=false;
  const gate=new Promise(resolve=>release=resolve);
  const storage=f.r.context.risuai.pluginStorage,set=storage.setItem.bind(storage);
  storage.setItem=async(key,value)=>{
    if(key.endsWith(':unified-replay-tx:v1')&&!held){held=true;await gate;}
    return set(key,value);
  };
  const result=f.core.rebuildCurrentStateForWorldline({reason:'reanalysis_wait_regression'});
  await waitFor(()=>held);
  return {release,result};
}

for(const kind of ['micro','lens'])test(kind+' waits for real State replay, describes the wait and starts automatically without discarding the reply',async()=>{
  const f=await setup();let replay;
  try{
    const lens=kind==='lens'?await createLens(f):null;
    f.control.onCall=args=>kind==='micro'?microReply(args,'이전 기억'):lensReply(f,1,'이전 기억');
    let inventory=await f.r.api.listReanalysisRanges({kind,lensId:lens?.lensId});
    const request=select(inventory,kind==='micro'?'1':'1-5');
    assert.equal((await f.r.api.reanalyzeSelectedRanges(request)).ok,true);
    const prior=kind==='micro'?await f.r.api.debugReadActiveMicroMemory(1):null;
    inventory=await f.r.api.listReanalysisRanges({kind,lensId:lens?.lensId});
    const generation=Number(f.core.state.worldManagerRuntimeMetaGeneration||0),calls=f.control.calls.length;
    replay=await holdStateReplay(f);
    // A second queued replay must also finish before the analysis boundary is pinned.
    const followingReplay=f.core.rebuildCurrentStateForWorldline({reason:'following_reanalysis_wait_regression'});
    f.control.onCall=args=>{
      assert.equal(f.core.state.queues.has(inventory.scopeKey),false);
      return kind==='micro'?microReply(args,'새 기억'):lensReply(f,1,'새 기억');
    };
    const execution=f.r.api.reanalyzeSelectedRanges(select(inventory,kind==='micro'?'1':'1-5'));
    const waiting=await waitFor(()=>f.core.state.activeAuxiliaryJob?.phase==='waiting_for_memory'&&f.core.state.activeAuxiliaryJob);
    assert.equal(waiting.state,'preparing');
    assert.equal(waiting.stateLabel,'다른 기억 작업 완료 대기');
    assert.equal(waiting.stepIndex,-1);
    assert.match(waiting.message,/기억 복구/);
    assert.match(waiting.message,/자동으로 시작/);
    assert.match(waiting.message,/아직 AI 분석은 시작하지 않았습니다/);
    assert.equal(f.control.calls.length,calls,'waiting never calls the provider');
    if(prior)assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).head.analysisRevisionId,prior.head.analysisRevisionId);
    replay.release();
    assert.equal((await replay.result).ok,true);
    assert.equal((await followingReplay).ok,true);
    const result=await execution;
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(f.control.calls.length,calls+1);
    assert.ok(Number(f.core.state.worldManagerRuntimeMetaGeneration||0)>generation);
    assert.equal(f.core.state.activeAuxiliaryJob.state,'completed');
    assert.equal(f.core.state.activeAuxiliaryJob.phase,'complete');
    if(prior)assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).record.claims[0].text,'새 기억');
  }finally{replay?.release();if(replay)await replay.result;await f.r.cleanup();}
});

test('cancelling a waiting reanalysis returns before the State replay finishes and makes no model call',async()=>{
  const f=await setup();let replay;
  try{
    const inventory=await f.r.api.listReanalysisRanges({kind:'micro'}),calls=f.control.calls.length;
    replay=await holdStateReplay(f);
    const execution=f.r.api.reanalyzeSelectedRanges(select(inventory,'1'));
    const job=await waitFor(()=>f.core.state.activeAuxiliaryJob?.phase==='waiting_for_memory'&&f.core.state.activeAuxiliaryJob);
    await f.r.api.cancelCanonicalJob({jobId:job.jobId});
    let result;
    void execution.then(value=>result=value);
    await waitFor(()=>result);
    assert.equal(result.ok,false);
    assert.match(result.reason,/사용자가 작업을 취소/);
    assert.equal(f.core.state.activeAuxiliaryJob.state,'cancelled');
    assert.equal(f.core.state.activeAuxiliaryJob.stateLabel,'취소됨');
    assert.equal(f.core.state.activeAuxiliaryJob.phase,'cancelled');
    assert.equal(f.control.calls.length,calls);
    assert.ok(f.core.state.queues.has(inventory.scopeKey),'cancellation does not cancel the independent State replay');
  }finally{replay?.release();if(replay)await replay.result;await f.r.cleanup();}
});

for(const mutation of ['raw','rules','restore'])test('waiting preserves the reviewed-source and restore guards after '+mutation+' changes',async()=>{
  const f=await setup();let replay;
  try{
    const inventory=await f.r.api.listReanalysisRanges({kind:'micro'}),range=inventory.ranges[0];
    const sample=await f.core.readReanalysisTurn(inventory,range);
    const request={...select(inventory,'1'),reviewedSource:{key:range.key,rawDigest:sample.rawDigest,rulesKey:f.core.sourceReanalysisRulesKey()}};
    const calls=f.control.calls.length;
    replay=await holdStateReplay(f);
    const execution=f.r.api.reanalyzeSelectedRanges(request);
    await waitFor(()=>f.core.state.activeAuxiliaryJob?.phase==='waiting_for_memory');
    if(mutation==='raw')f.chat.message[1].data+=' 검토 후 변경';
    if(mutation==='rules')await f.r.api.setSourceEditRules({version:1,ignoredTags:['changed'],unwrapTags:[],sourceTags:[],controls:[]});
    if(mutation==='restore')f.core.noteMicroRestoreBoundary();
    replay.release();
    await replay.result;
    const result=await execution;
    assert.equal(result.ok,false,JSON.stringify(result));
    assert.match(result.reason,/원문|태그|기억 작업 경계/);
    assert.equal(f.control.calls.length,calls);
  }finally{replay?.release();if(replay)await replay.result;await f.r.cleanup();}
});

test('an unrelated chat writer does not delay Micro reanalysis',async()=>{
  const f=await setup();
  try{
    f.core.state.queues.set('another-scope',new Promise(()=>{}));
    f.control.onCall=args=>microReply(args);
    const inventory=await f.r.api.listReanalysisRanges({kind:'micro'});
    const result=await f.r.api.reanalyzeSelectedRanges(select(inventory,'1'));
    assert.equal(result.ok,true,JSON.stringify(result));
  }finally{f.core.state.queues.delete('another-scope');await f.r.cleanup();}
});
