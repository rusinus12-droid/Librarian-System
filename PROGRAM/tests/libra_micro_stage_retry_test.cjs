'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

function transformSource(source) {
  const anchor = '      debugReadActiveCompletedTurnReceipt: async turnValue => {';
  assert.ok(source.includes(anchor));
  source = source.replace(anchor, `      debugMicroStageFixture: async (action, value) => {
        const context=await resolveContext(true),pair=buildPairs(context.chat,context.scope.scopeKey)[0];
         if(action==='persist')return persistCompletedTurnReceipt(context,pair,'completed_pair_reconcile',{deferInventory:true});
         if(action==='settings')return saveMemorySettings(value);
         if(action==='binding')return {planRuntimeToken:state.microRuntimeToken,
            planRestoreGeneration:Number(state.microRestoreGeneration||0)};
         if(action==='settingsFailure'){
           state.settings={get enabled(){throw new Error('injected settings read failure');}};
           return;
         }
         if(action==='restore')return noteMicroRestoreBoundary();
         if(action==='recoveryInput')return {scope:context.scope,
           boundary:await captureReceiptRecoveryBoundary(context,pair),
           missingTurns:[receiptRecoveryIdentity(context,pair)]};
         if(action==='seedPendingPlan'){
           const revisionId=completedTurnRevisionId(pair),worldlineId=hostWorldlineIdForScope(context.scope);
           const receiptKey=key.completedTurnReceipt(context.scope,worldlineId,0,pair.turn,revisionId);
           const workKey=key.microWork(context.scope,worldlineId,0,pair.turn,revisionId,microProducerVersion);
           return storage.setVerifiedJson(workKey,{schema:'libra.micro_work.v1',scopeKey:context.scope.scopeKey,
             worldlineId,sessionEpoch:0,turn:pair.turn,sourceRevisionId:revisionId,
             sourceDigest:sourceDigest([pair]),receiptKey,producerVersion:microProducerVersion,
             status:'reserved',phase:'planned',planProvenance:'risu_chat_output_fresh_receipt',
             ...(value||{}),
             attemptId:'fixture_recovery_plan',logicalAttempts:1,physicalAttemptsUsed:0,
             attemptHistory:[],reservedAt:Date.now(),leaseExpiresAt:Date.now()+45000,result:null},context.scope);
         }
        const active=await readActiveCompletedTurnReceipt(context.scope,hostWorldlineIdForScope(context.scope),0,1);
        if(action==='schedule')return scheduleMicroForTurn(context.scope,active.receipt.worldlineId,0,1,active.receipt.revisionId);
        const ref=key.microWork(context.scope,active.receipt.worldlineId,0,1,active.receipt.revisionId,microProducerVersion);
        if(action==='work')return readRecoverableMicroJson(ref,context.scope);
        if(action==='seed')return storage.setVerifiedJson(ref,value,context.scope);
        return {scope:context.scope,receiptRef:active.receiptKey,revision:active.receipt.revisionId,
          digest:active.receipt.sourceDigest,expectedGeneration:Number(state.worldManagerRuntimeMetaGeneration||0)};
      },
`+anchor);
  const root="    debugBuildPairs(chat = {}, cacheKey = '')";
  assert.ok(source.includes(root));
  return source.replace(root,"    async debugMicroStageFixture(action,value) { return safeClone(await LibraMemoryCore.debugMicroStageFixture(action,value)); },\n"+root);
}
const cases=[];const test=(name,fn)=>cases.push({name,fn});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(fn,mode='plugin_only',options={}) {
  const x=await serverFixture({mode,transformSource,host:options.host||{}});
  try {
    x.f.chat.message=x.f.chat.message.slice(0,2);x.f.chat.messages=x.f.chat.message;
    const api=x.f.r.api;
    await api.debugMicroStageFixture('persist');
    const input=await api.debugMicroStageFixture('input');
    if(options.plan!==false){
      const binding=await api.debugMicroStageFixture('binding');
      const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
      await api.debugMicroStageFixture('seed',{schema:'libra.micro_work.v1',
        scopeKey:receipt.scopeKey,worldlineId:receipt.worldlineId,sessionEpoch:receipt.sessionEpoch,
        turn:receipt.turn,sourceRevisionId:receipt.revisionId,sourceDigest:receipt.sourceDigest,
        receiptKey:input.receiptRef,producerVersion:'micro_producer_v2',
        status:'reserved',phase:'planned',planProvenance:'risu_chat_output_fresh_receipt',
        ...binding,
        attemptId:'fixture_planned',logicalAttempts:1,physicalAttemptsUsed:0,attemptHistory:[],
        reservedAt:Date.now(),leaseExpiresAt:Date.now()+45000,result:null});
    }
    await fn({x,api,input});
    assert.equal(x.requests.filter(r=>!r.url.startsWith(x.url+'/')).length,0,'no external provider');
  } finally {await x.cleanup();}
}
const envelope=receipt=>{const quote=receipt.assistant.text.slice(0,Math.min(30,receipt.assistant.text.length));
  return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',
  personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',
    scopeKey:receipt.scopeKey,worldlineId:receipt.worldlineId,sessionEpoch:receipt.sessionEpoch,
    turn:receipt.turn,sourceRevisionId:receipt.revisionId,sourceDigest:receipt.sourceDigest,
    claims:[{changeKind:'event',text:'An event happened.',actor:'',target:'',temporalRole:'current',
      certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'none',
      evidence:{role:'assistant',messageId:receipt.assistant.chatId,startOffset:0,
        endOffset:quote.length,exactQuote:quote}}]}})};};
test('verified receipt has a separate never-started Micro status and read is call-free',async()=>fixture(async({x,api,input})=>{
  const status=await api.getReceiptRecoveryStatus({scope:input.scope});
  assert.equal(status.microJobs.find(row=>row.receiptRef===input.receiptRef)?.status,'never_started');
  assert.equal(x.f.control.calls.length,0);
}));
test('legacy verified receipt with no Micro work is unknown and never auto-invokes',async()=>fixture(async({x,api,input})=>{
  const stage=(await api.getReceiptRecoveryStatus({scope:input.scope})).microJobs[0];
  assert.equal(stage.status,'unknown');
  assert.equal((await api.resumeNeverStartedMicro(input)).status,'unknown');
  assert.equal((await api.debugMicroStageFixture('schedule')).status,'unknown');
  assert.equal(x.f.control.calls.length,0);
  assert.equal(await api.debugMicroStageFixture('work'),null,'missing work is not backfilled as a planned claim');
},'plugin_only',{plan:false}));
test('fabricated planned provenance never proves a free model call',async()=>fixture(async({x,api,input})=>{
  const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
  const binding=await api.debugMicroStageFixture('binding');
  await api.debugMicroStageFixture('seed',{schema:'libra.micro_work.v1',scopeKey:receipt.scopeKey,
    worldlineId:receipt.worldlineId,sessionEpoch:0,turn:1,sourceRevisionId:receipt.revisionId,
    sourceDigest:receipt.sourceDigest,receiptKey:input.receiptRef,producerVersion:'micro_producer_v2',
    status:'reserved',phase:'planned',planProvenance:'fabricated',...binding,
    attemptId:'wrong_marker',logicalAttempts:1,physicalAttemptsUsed:0,attemptHistory:[],
    reservedAt:Date.now(),leaseExpiresAt:Date.now()+45000,result:null});
  assert.equal((await api.getReceiptRecoveryStatus({scope:input.scope})).microJobs[0].status,'unknown');
  assert.equal((await api.debugMicroStageFixture('schedule')).status,'unknown');
  assert.equal(x.f.control.calls.length,0);
},'plugin_only',{plan:false}));
test('missing Micro journal can start only a cost-aware explicit unknown retry',async()=>fixture(async({x,api,input})=>{
  const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
  x.f.control.onCall=()=>envelope(receipt);
  const result=await api.retryMicroAnalysis(input);
  assert.equal(result.status,'verified');
  assert.equal(x.f.control.calls.length,1);
  const work=await api.debugMicroStageFixture('work');
  assert.equal(work.logicalAttempts,2);
  assert.equal(work.attemptHistory[0].status,'unknown');
  assert.equal(work.attemptHistory[0].physicalAttemptsUncertain,true);
  assert.equal(work.attemptHistory[1].physicalAttemptsUsed,1);
  assert.equal(work.physicalAttemptsUsed,1);
},'plugin_only',{plan:false}));
test('restarted unproven plan stays call-free until explicit retry opens a new durable attempt',async()=>fixture(async({x,api,input})=>{
  const before=await api.debugMicroStageFixture('work');
  await x.restart();
  const fresh=x.f.r.api;
  assert.equal((await fresh.getReceiptRecoveryStatus({scope:input.scope})).microJobs[0].status,'unknown');
  assert.equal((await fresh.resumeNeverStartedMicro(input)).status,'unknown');
  assert.equal((await fresh.debugMicroStageFixture('schedule')).status,'unknown');
  assert.equal(x.f.control.calls.length,0,'restart does not prove the old plan was free');
  const receipt=(await fresh.debugReadActiveCompletedTurnReceipt(1)).receipt;
  x.f.control.onCall=()=>envelope(receipt);
  assert.equal((await fresh.retryMicroAnalysis(input)).status,'verified');
  assert.equal(x.f.control.calls.length,1);
  const work=await fresh.debugMicroStageFixture('work');
  assert.notEqual(work.attemptId,before.attemptId);
  assert.equal(work.logicalAttempts,2);
  assert.equal(work.attemptHistory[0].attemptId,before.attemptId);
  assert.equal(work.attemptHistory[0].status,'unknown');
  assert.equal(work.attemptHistory[0].physicalAttemptsUsed,2,'uncertain old call budget is not reset');
  assert.equal(work.attemptHistory[0].physicalAttemptsUncertain,true);
  assert.equal(work.attemptHistory[1].status,'succeeded');
  assert.equal(work.attemptHistory[1].physicalAttemptsUsed,1);
}));
test('unconfirmed new manual reservation after restart prevents a provider call',async()=>fixture(async({x,api,input})=>{
  const before=await api.debugMicroStageFixture('work');
  const raw=x.local.get(input.receiptRef);
  await x.restart();
  const fresh=x.f.r.api,set=x.backend.setItem;
  x.backend.setItem=async(key,value)=>{
    if(key.includes(':micro-work:') && JSON.parse(value).phase==='manual_planned')return false;
    return set(key,value);
  };
  const result=await fresh.retryMicroAnalysis(input);
  assert.notEqual(result.status,'verified');
  assert.equal(x.f.control.calls.length,0,'durable readback is required before a new manual call');
  assert.equal((await fresh.debugMicroStageFixture('work')).attemptId,before.attemptId);
  assert.equal(x.local.get(input.receiptRef),raw);
}));
test('source change during restarted-plan manual retry discards its awaited result',async()=>fixture(async({x,api,input})=>{
  await x.restart();
  const fresh=x.f.r.api;
  const receipt=(await fresh.debugReadActiveCompletedTurnReceipt(1)).receipt;
  const raw=x.local.get(input.receiptRef);
  const workKey=[...x.local.keys()].find(key=>key.includes(':micro-work:') && JSON.parse(x.local.get(key)).receiptKey===input.receiptRef);
  assert.ok(workKey);
  x.f.control.onCall=()=>{x.f.chat.message[1].data+=' changed during explicit retry';return envelope(receipt);};
  const result=await fresh.retryMicroAnalysis(input);
  assert.equal(result.status,'stale');
  assert.equal(x.f.control.calls.length,1);
  assert.equal(x.local.get(input.receiptRef),raw,'late result cannot replace the original receipt');
  assert.equal(x.local.has(`libra:v1:scope:${input.scope.scopeKey}:micro-memory-head:${receipt.worldlineId}:e0:t1`),false);
  const work=JSON.parse(x.local.get(workKey));
  assert.equal(work.attemptHistory[0].status,'unknown');
  assert.equal(work.attemptHistory[0].physicalAttemptsUncertain,true);
}));
test('restart after Micro journal loss does not infer a never-started call',async()=>{
  const x=await serverFixture({mode:'plugin_only',transformSource});
  try{
    x.f.chat.message=x.f.chat.message.slice(0,2);x.f.chat.messages=x.f.chat.message;
    let api=x.f.r.api;
    await api.debugMicroStageFixture('persist');
    const input=await api.debugMicroStageFixture('input');
    const binding=await api.debugMicroStageFixture('binding');
    const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
    await api.debugMicroStageFixture('seed',{schema:'libra.micro_work.v1',scopeKey:receipt.scopeKey,
      worldlineId:receipt.worldlineId,sessionEpoch:0,turn:1,sourceRevisionId:receipt.revisionId,
      sourceDigest:receipt.sourceDigest,receiptKey:input.receiptRef,producerVersion:'micro_producer_v2',
      status:'reserved',phase:'planned',planProvenance:'risu_chat_output_fresh_receipt',
      ...binding,
      attemptId:'before_loss',logicalAttempts:1,physicalAttemptsUsed:0,attemptHistory:[],
      reservedAt:Date.now(),leaseExpiresAt:Date.now()+45000,result:null});
    x.f.control.modelFails=true;
    await api.debugMicroStageFixture('schedule');
    assert.ok(x.f.control.calls.length>=1);
    for(const key of [...x.local.keys()])if(key.includes(':micro-work:')||key.includes(':micro-memory'))x.local.delete(key);
    await x.restart();api=x.f.r.api;
    assert.equal((await api.debugReadActiveCompletedTurnReceipt(1)).status,'verified');
    assert.equal((await api.getReceiptRecoveryStatus({scope:input.scope})).microJobs[0].status,'unknown');
    assert.equal((await api.resumeNeverStartedMicro(input)).status,'unknown');
    assert.equal((await api.debugMicroStageFixture('schedule')).status,'unknown');
    assert.equal(x.f.control.calls.length,0);
    assert.equal(await api.debugMicroStageFixture('work'),null);
  }finally{await x.cleanup();}
});
test('fresh official output persists a planned claim before the first Micro call',async()=>{
  let listener;
  const x=await serverFixture({mode:'plugin_only',transformSource,
    host:{addRisuChatListener:async(_kind,handler)=>{listener=handler;return true;}}});
  try{
    x.f.chat.message=x.f.chat.message.slice(0,2);x.f.chat.messages=x.f.chat.message;
    const api=x.f.r.api;
    let observedWork=null;
    x.f.control.onCall=async()=>{
      observedWork=await api.debugMicroStageFixture('work');
      return envelope((await api.debugReadActiveCompletedTurnReceipt(1)).receipt);
    };
    listener({char:x.f.character,chat:x.f.chat,characterIndex:0,chatIndex:0,messageIndex:1});
    await waitFor(()=>api.getCaptureBackendState().lastMicroPublication?.status==='verified',10000);
    assert.equal(x.f.control.calls.length,1);
    assert.equal(observedWork?.phase,'invoking');
    assert.equal(observedWork?.planProvenance,'risu_chat_output_fresh_receipt');
    assert.equal(observedWork?.physicalAttemptsUsed,0);
  }finally{await x.cleanup();}
});
test('Micro OFF leaves verified receipt ready and never calls a model',async()=>fixture(async({x,api,input})=>{
  await api.debugMicroStageFixture('settings',{enabled:false});
  const receipt=await api.debugReadActiveCompletedTurnReceipt(1);
  assert.equal(receipt.status,'verified');
  const stage=(await api.getReceiptRecoveryStatus({scope:input.scope})).microJobs[0];
  assert.equal(stage.status,'OFF');
  assert.equal((await api.resumeNeverStartedMicro(input)).status,'OFF');
  assert.equal((await api.debugMicroStageFixture('schedule')).status,'OFF');
  assert.equal(x.f.control.calls.length,0);
}));
test('unavailable Micro settings report an unavailable stage without blocking receipt',async()=>fixture(async({x,api,input})=>{
  await api.debugMicroStageFixture('settingsFailure');
  assert.equal((await api.debugReadActiveCompletedTurnReceipt(1)).status,'verified');
  const stage=(await api.getReceiptRecoveryStatus({scope:input.scope})).microJobs[0];
  assert.equal(stage.status,'unavailable');
  assert.equal((await api.resumeNeverStartedMicro(input)).status,'unavailable');
  assert.equal(x.f.control.calls.length,0);
}));
test('proven never-started resumes once and duplicate event joins without another call',async()=>fixture(async({x,api,input})=>{
  const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
  x.f.control.onCall=()=>envelope(receipt);
  const [a,b]=await Promise.all([api.resumeNeverStartedMicro(input),api.resumeNeverStartedMicro(input)]);
  assert.equal(a.status,'verified');assert.equal(b.status,'verified');
  assert.equal(x.f.control.calls.length,1);
  await api.debugMicroStageFixture('schedule');
  assert.equal(x.f.control.calls.length,1);
  assert.equal((await api.getReceiptRecoveryStatus({scope:input.scope})).microJobs[0].status,'succeeded');
}));
test('failed result requires manual retry and preserves prior attempt',async()=>fixture(async({x,api,input})=>{
  x.f.control.modelFails=true;
  await api.debugMicroStageFixture('schedule');
  const before=x.f.control.calls.length;
  assert.ok(before>=1&&before<=2);
  const oldWork=await api.debugMicroStageFixture('work');
  const oldAttemptId=oldWork.attemptId,oldPhysicalUsed=oldWork.physicalAttemptsUsed;
  assert.ok(oldPhysicalUsed>=1&&oldPhysicalUsed<=2);
  await api.debugMicroStageFixture('schedule');
  assert.equal(x.f.control.calls.length,before,'failed output event cannot auto-retry');
  assert.equal((await api.getReceiptRecoveryStatus({scope:input.scope})).microJobs[0].status,'failed');
  x.f.control.modelFails=false;
  const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
  x.f.control.onCall=()=>envelope(receipt);
  const [a,b]=await Promise.all([api.retryMicroAnalysis(input),api.retryMicroAnalysis(input)]);
  assert.equal(a.attemptId,b.attemptId,'double click joins one manual attempt');
  const work=await api.debugMicroStageFixture('work');
  assert.notEqual(work.attemptId,oldAttemptId);
  assert.equal(work.logicalAttempts,oldWork.logicalAttempts+1);
  assert.equal(work.attemptHistory.find(row=>row.attemptId===oldAttemptId)?.physicalAttemptsUsed,
    oldPhysicalUsed,'the previous physical-call budget is immutable history');
  assert.equal(work.priorResults.at(-1).resultDigest,oldWork.resultDigest);
  assert.equal(work.physicalAttemptsUsed,x.f.control.calls.length-before);
  assert.ok(work.priorResults?.length>=1,'old result retained');
  assert.ok(work.attemptHistory?.length>=2,'old logical and physical history retained');
  assert.ok(x.f.control.calls.length-before<=2,'new attempt retains per-execution cap');
}));
test('legacy reserved lease expiry is unknown, never auto-resumed',async()=>fixture(async({x,api,input})=>{
  const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
  await api.debugMicroStageFixture('seed',{schema:'libra.micro_work.v1',scopeKey:input.scope.scopeKey,
    worldlineId:receipt.worldlineId,sessionEpoch:0,turn:1,sourceRevisionId:receipt.revisionId,
    sourceDigest:receipt.sourceDigest,receiptKey:input.receiptRef,producerVersion:'micro_producer_v2',
    status:'reserved',logicalAttempts:1,reservedAt:Date.now()-90000,leaseExpiresAt:Date.now()-1,result:null});
  const status=await api.getReceiptRecoveryStatus({scope:input.scope});
  assert.equal(status.microJobs[0].status,'unknown');
  await api.debugMicroStageFixture('schedule');
  assert.equal(x.f.control.calls.length,0);
  assert.equal((await api.resumeNeverStartedMicro(input)).status,'unknown');
  assert.equal(x.f.control.calls.length,0);
}));
test('result-ready publication repair uses no model call',async()=>fixture(async({x,api,input})=>{
  const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
  x.f.control.onCall=()=>envelope(receipt);
  const set=x.backend.setItem;let failed=false;
  x.backend.setItem=async(k,v)=>{if(!failed&&k.includes(':micro-memory-head:')){failed=true;return false;}return set(k,v);};
  await api.debugMicroStageFixture('schedule');
  const before=x.f.control.calls.length;
  const work=await api.debugMicroStageFixture('work');
  assert.equal(work.status,'result_ready');
  const ready=(await api.getReceiptRecoveryStatus()).microJobs[0];
  assert.equal(ready.status,'publish_ready','settled result awaiting head publication is not an active queue');
  assert.equal(typeof api.repairMicroPublication,'function');
  const repaired=await api.repairMicroPublication(input);
  assert.equal(repaired.status,'verified');
  assert.equal((await api.getReceiptRecoveryStatus()).microJobs[0].status,'succeeded');
  assert.equal(x.f.control.calls.length,before);
}));
test('unconfigured provider preset is unavailable with zero physical calls and no cost retry',async()=>fixture(async({x,api,input})=>{
  const result=await api.resumeNeverStartedMicro(input);
  const work=await api.debugMicroStageFixture('work');
  const stage=(await api.getReceiptRecoveryStatus()).microJobs[0];
  assert.ok(['verified','pending_reconciliation'].includes(result.status),'source-only publication may settle separately');
  assert.equal(x.f.control.calls.length,0,'absent host model adapter made no call');
  assert.match(work.result.reason,/preset_unconfigured/,'actual provider adapter reports the unconfigured preset');
  assert.equal(work.result.provider.skipped,true,'journal records adapter skip rather than a failed call');
  assert.equal(work.physicalAttemptsUsed,0,'no-call skip cannot consume physical budget');
  assert.equal(work.attemptHistory.at(-1).physicalAttemptsUsed,0);
  assert.equal(stage.status,'unavailable');
  assert.equal((await api.retryMicroAnalysis(input)).status,'unavailable','cost retry stays disabled');
  assert.equal(x.f.control.calls.length,0);
},'plugin_only',{host:{runLLMModel:null}}));
test('unconfirmed invocation-start record prevents a model call and planned work resumes',async()=>fixture(async({x,api,input})=>{
  const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
  x.f.control.onCall=()=>envelope(receipt);
  const set=x.backend.setItem;let fail=true;
  x.backend.setItem=async(k,v)=>{
    if(fail&&k.includes(':micro-work:')&&JSON.parse(v).phase==='invoking'){fail=false;return false;}
    return set(k,v);
  };
  const first=await api.resumeNeverStartedMicro(input);
  assert.equal(first.status,'pending_reconciliation');assert.equal(x.f.control.calls.length,0);
  const work=await api.debugMicroStageFixture('work');
  assert.equal(work.phase,'planned');
  await api.resumeNeverStartedMicro(input);
  assert.equal(x.f.control.calls.length,1);
}));
test('durable source-edit permit denial prevents Micro start',async()=>fixture(async({x,api,input})=>{
  x.local.set(`libra:v1:scope:${input.scope.scopeKey}:source-edit-consent:v1`,JSON.stringify({
    schema:'memory-suite.source-edit-consent.v1',owner:'libra',scopeKey:input.scope.scopeKey,
    tasks:{'1':{key:'1',start:1,end:5,state:'awaiting_consent',revisionId:'blocked'}},exceptions:{}}));
  const result=await api.resumeNeverStartedMicro(input);
  assert.equal(result.status,'paused');assert.equal(x.f.control.calls.length,0);
}));
test('source changed while model runs discards late result',async()=>fixture(async({x,api,input})=>{
  const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
  x.f.control.onCall=()=>{x.f.chat.message[1].data+=' edited';return envelope(receipt);};
  const result=await api.resumeNeverStartedMicro(input);
  assert.equal(result.status,'stale');assert.equal(x.f.control.calls.length,1);
  assert.equal(x.local.has(`libra:v1:scope:${input.scope.scopeKey}:micro-memory-head:${receipt.worldlineId}:e0:t1`),false);
}));
test('active legacy lease blocks both automatic and manual replay',async()=>fixture(async({x,api,input})=>{
  const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
  await api.debugMicroStageFixture('seed',{schema:'libra.micro_work.v1',scopeKey:input.scope.scopeKey,
    worldlineId:receipt.worldlineId,sessionEpoch:0,turn:1,sourceRevisionId:receipt.revisionId,
    sourceDigest:receipt.sourceDigest,receiptKey:input.receiptRef,producerVersion:'micro_producer_v2',
    status:'reserved',logicalAttempts:1,reservedAt:Date.now(),leaseExpiresAt:Date.now()+45000,result:null});
  await api.debugMicroStageFixture('schedule');
  const result=await api.retryMicroAnalysis(input);
  assert.ok(['pending','unknown'].includes(result.status));assert.equal(x.f.control.calls.length,0);
}));
test('expired unknown needs manual action and preserves unknown history',async()=>fixture(async({x,api,input})=>{
  const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
  await api.debugMicroStageFixture('seed',{schema:'libra.micro_work.v1',scopeKey:input.scope.scopeKey,
    worldlineId:receipt.worldlineId,sessionEpoch:0,turn:1,sourceRevisionId:receipt.revisionId,
    sourceDigest:receipt.sourceDigest,receiptKey:input.receiptRef,producerVersion:'micro_producer_v2',
    status:'reserved',logicalAttempts:1,reservedAt:Date.now()-90000,leaseExpiresAt:Date.now()-1,result:null});
  await api.debugMicroStageFixture('schedule');assert.equal(x.f.control.calls.length,0);
  x.f.control.onCall=()=>envelope(receipt);
  const result=await api.retryMicroAnalysis(input);
  assert.equal(x.f.control.calls.length,1);assert.ok(result.attemptId);
  const work=await api.debugMicroStageFixture('work');
  assert.equal(work.logicalAttempts,2);assert.equal(work.attemptHistory[0].status,'unknown');
  assert.equal(work.attemptHistory[0].physicalAttemptsUsed,2);
  assert.equal(work.attemptHistory[1].physicalAttemptsUsed,1);
}));
test('verified recovery completion and original event use one Micro entry',async()=>{
  const x=await serverFixture({mode:'plugin_only',transformSource});
  try {
    x.f.chat.message=x.f.chat.message.slice(0,2);x.f.chat.messages=x.f.chat.message;
    const api=x.f.r.api,input=await api.debugMicroStageFixture('recoveryInput');
    await api.debugMicroStageFixture('seedPendingPlan',await api.debugMicroStageFixture('binding'));
    assert.equal(x.f.control.calls.length,0);
    x.f.control.onCall=async()=>envelope((await api.debugReadActiveCompletedTurnReceipt(1)).receipt);
    const queued=await api.queueReceiptRecovery(input);
    assert.equal((await api.runReceiptRecoveryJob({jobId:queued.jobId})).status,'verified');
    await waitFor(()=>x.f.control.calls.length===1,5000);
    await api.debugMicroStageFixture('schedule');
    assert.equal(x.f.control.calls.length,1,'original path joins durable recovery analysis');
  } finally {await x.cleanup();}
});
test('superseding attempt while provider runs discards old result',async()=>fixture(async({x,api,input})=>{
  const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
  x.f.control.onCall=async()=>{
    const work=await api.debugMicroStageFixture('work');
    await api.debugMicroStageFixture('seed',{...work,attemptId:'newer_attempt'});
    return envelope(receipt);
  };
  const result=await api.resumeNeverStartedMicro(input);
  assert.equal(result.status,'stale_source');assert.equal(x.f.control.calls.length,1);
  const work=await api.debugMicroStageFixture('work');
  assert.equal(work.attemptId,'newer_attempt');assert.equal(work.status,'reserved');
  assert.equal(x.local.has(`libra:v1:scope:${input.scope.scopeKey}:micro-memory-head:${receipt.worldlineId}:e0:t1`),false);
}));
test('restore during provider discards old result',async()=>fixture(async({x,api,input})=>{
  const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
  x.f.control.onCall=async()=>{await api.debugMicroStageFixture('restore');return envelope(receipt);};
  const result=await api.resumeNeverStartedMicro(input);
  assert.equal(result.status,'stale_source');
  assert.equal(result.reason,'micro_restore_boundary_changed');
  assert.equal(x.f.control.calls.length,1);
}));
test('restoring receipt and planned-work snapshot after a model call cannot auto-call again',async()=>fixture(async({x,api,input})=>{
  const snapshot=new Map(x.local);
  const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
  x.f.control.onCall=()=>envelope(receipt);
  assert.equal((await api.debugMicroStageFixture('schedule')).status,'verified');
  const spent=x.f.control.calls.length;assert.equal(spent,1);
  x.local.clear();for(const [key,value] of snapshot)x.local.set(key,value);
  await api.debugMicroStageFixture('restore');
  assert.equal((await api.debugReadActiveCompletedTurnReceipt(1)).status,'verified');
  assert.equal((await api.getReceiptRecoveryStatus({scope:input.scope})).microJobs[0].status,'unknown');
  assert.equal((await api.debugMicroStageFixture('schedule')).status,'unknown');
  assert.equal(x.f.control.calls.length,spent);
}));
test('completed Micro published after a restore survives a normal runtime restart',async()=>{
  const x=await serverFixture({mode:'plugin_only',transformSource});
  try{
    x.f.chat.message=x.f.chat.message.slice(0,2);x.f.chat.messages=x.f.chat.message;
    let api=x.f.r.api;
    await api.debugMicroStageFixture('persist');
    await api.debugMicroStageFixture('restore');
    const input=await api.debugMicroStageFixture('input');
    const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
    x.f.control.onCall=()=>envelope(receipt);
    assert.equal((await api.retryMicroAnalysis(input)).status,'verified');
    const before=await api.debugReadActiveMicroMemory(1);
    assert.equal(before.status,'verified');
    assert.equal(before.head.restoreGeneration,1);
    const resumed=await x.restart();api=resumed.r.api;
    resumed.chat.message=resumed.chat.message.slice(0,2);resumed.chat.messages=resumed.chat.message;
    assert.equal((await api.debugReadActiveCompletedTurnReceipt(1)).status,'verified');
    assert.equal((await api.debugReadActiveMicroMemory(1)).status,'verified');
    assert.equal(resumed.control.calls.length,0,'completed result needs no model replay');
  }finally{await x.cleanup();}
});
test('attempt superseded at Micro head write is never adopted as active',async()=>fixture(async({x,api,input})=>{
  const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
  x.f.control.onCall=()=>envelope(receipt);
  const set=x.backend.setItem;let changed=false;
  x.backend.setItem=async(k,v)=>{
    if(!changed&&k.includes(':micro-memory-head:')){
      changed=true;
      const work=await api.debugMicroStageFixture('work');
      await api.debugMicroStageFixture('seed',{...work,attemptId:'newer_at_head_write'});
      await api.debugMicroStageFixture('restore');
    }
    return set(k,v);
  };
  const result=await api.resumeNeverStartedMicro(input);
  assert.equal(changed,true);
  assert.notEqual(result.status,'verified');
  assert.notEqual((await api.debugReadActiveMicroMemory(1)).status,'verified');
}));
test('missing work beside published fallback is unknown, not proof of no call',async()=>fixture(async({x,api,input})=>{
  x.f.control.modelFails=true;
  await api.debugMicroStageFixture('schedule');
  const before=x.f.control.calls.length;
  const workKey=[...x.local.keys()].find(k=>k.includes(':micro-work:'));
  assert.ok(workKey);x.local.delete(workKey);
  const status=await api.getReceiptRecoveryStatus({scope:input.scope});
  assert.equal(status.microJobs[0].status,'unknown');
  const result=await api.resumeNeverStartedMicro(input);
  assert.equal(result.status,'unknown');assert.equal(x.f.control.calls.length,before);
}));
test('legacy minimum-source-bound retry reservation cannot auto-invoke',async()=>fixture(async({x,api,input})=>{
  x.f.control.modelFails=true;
  await api.debugMicroStageFixture('schedule');
  const before=x.f.control.calls.length;
  const previous=await api.debugMicroStageFixture('work');
  assert.equal(previous.status,'result_ready');
  await api.debugMicroStageFixture('seed',{...previous,status:'reserved',phase:'retry_planned',
    logicalAttempts:previous.logicalAttempts+1,priorResults:[{
      result:previous.result,resultDigest:previous.resultDigest,logicalAttempts:previous.logicalAttempts}],
    result:null,resultDigest:'',leaseExpiresAt:Date.now()+45000});
  x.f.control.modelFails=false;
  await api.debugMicroStageFixture('schedule');
  assert.equal(x.f.control.calls.length,before,'legacy automatic retry cannot bypass manual boundary');
  assert.equal((await api.getReceiptRecoveryStatus({scope:input.scope})).microJobs[0].status,'unknown');
  const receipt=(await api.debugReadActiveCompletedTurnReceipt(1)).receipt;
  x.f.control.onCall=()=>envelope(receipt);
  const manual=await api.retryMicroAnalysis(input);
  assert.equal(manual.status,'verified');
  const repaired=await api.debugMicroStageFixture('work');
  assert.ok(repaired.attemptId && repaired.attemptId!==previous.attemptId);
  assert.ok(repaired.attemptHistory.length>=2,'legacy reservation and manual retry remain distinct');
}));
(async()=>{let failed=0;for(const {name,fn} of cases){try{await fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name,e);}}
  console.log(`RESULT ${cases.length-failed}/${cases.length} passed`);process.exitCode=failed?1:0;})().catch(e=>{console.error(e);process.exitCode=1;});
