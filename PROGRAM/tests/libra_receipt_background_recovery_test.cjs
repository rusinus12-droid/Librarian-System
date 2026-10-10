'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');

// Test-only context/producer access through the existing VM source seam.
// Recovery APIs run unmodified production code and real storage.
function transformSource(source) {
  const core = '      debugReadActiveCompletedTurnReceipt: async turnValue => {';
  assert.ok(source.includes(core), 'fixture core anchor');
  source = source.replace(core, `      debugReceiptRecoveryFixture: async (action, turn = 1) => {
        const context = await resolveContext(true), pair = buildPairs(context.chat, context.scope.scopeKey)[turn - 1];
        if (action === 'connection') return MemorySuiteStorageBridge.getConnectionSettings({scope:context.scope,force:true});
        if (action === 'persist') return persistCompletedTurnReceipt(context, pair, 'completed_pair_reconcile', {deferInventory:true});
        if (action === 'restore') { state.worldManagerRuntimeMetaGeneration = Number(state.worldManagerRuntimeMetaGeneration || 0) + 1; return; }
        if (action === 'partialProbe') {
          const identity=receiptRecoveryIdentity(context,pair),scope=context.scope;
          return provenOneSidedReceiptRecoveryCopy({scope,identity,boundary:{mode:'mirror'},
            receiptRef:key.completedTurnReceipt(scope,identity.worldlineId,0,identity.turn,identity.revisionId),
            headRef:key.completedTurnHead(scope,identity.worldlineId,0,identity.turn)},pair,context);
        }
        if (action === 'pending') return [...state.storageWriteFence.keys()];
        if (action === 'capture') return captureCommittedOutputEvent({char:context.character,chat:context.chat,characterIndex:0,chatIndex:0,messageIndex:1});
        const identity = receiptRecoveryIdentity(context, pair);
        return {scope:context.scope, boundary:await captureReceiptRecoveryBoundary(context, pair), missingTurns:[identity], reason:'capture_failed'};
      },\n` + core);
  const root = "    debugBuildPairs(chat = {}, cacheKey = '')";
  assert.ok(source.includes(root), 'fixture root anchor');
  return source.replace(root, '    async debugReceiptRecoveryFixture(action, turn) { return await LibraMemoryCore.debugReceiptRecoveryFixture(action, turn); },\n' + root);
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise,resolve}; };
const json = value => JSON.parse(JSON.stringify(value));
const cases = [];
function test(name, fn) { cases.push({name,fn}); }
async function withFixture(mode, fn, {allowMockModelCalls=false}={}) {
  const x = await serverFixture({mode,transformSource});
  try {
    const api = x.f.r.api;
    for (const name of ['queueReceiptRecovery','runReceiptRecoveryJob','getReceiptRecoveryStatus'])
      assert.equal(typeof api[name], 'function', `${name}: production feature absent`);
    const delays = [], originalTimer = x.f.r.context.setTimeout;
    x.f.r.context.setTimeout = (cb, delay, ...args) => {
      if (delay === 1000 || delay === 3000) { delays.push(delay); return originalTimer(cb,0,...args); }
      return originalTimer(cb,delay,...args);
    };
    const rawWrites = [], ledgerWrites = [], set = x.backend.setItem;
    x.backend.setItem = async (k,v) => {
      if (k.includes(':source-receipt:')) rawWrites.push({key:k,value:v});
      if (k.endsWith(':receipt-recovery:v1')) ledgerWrites.push({key:k,value:v});
      return await set(k,v);
    };
    await fn({x,api,delays,rawWrites,ledgerWrites});
    if(!allowMockModelCalls)assert.equal(x.f.control.calls.length,0,'no LLM calls');
    assert.equal(x.requests.filter(r=>!r.url.startsWith(x.url+'/')).length,0,'no external/embedding calls');
    const remoteLedgers = x.getRecords('libra.receipt_recovery.v1').map(row=>({value:JSON.stringify(row.value)}));
    for (const row of [...ledgerWrites,...remoteLedgers]) {
      const body = JSON.parse(row.value);
      assert.equal(body.schema,'libra.receipt_recovery.v1');
      assert.ok(!row.value.includes(x.f.chat.message[0]?.data || '__missing_fixture_text__'),'no source text in ledger');
      for (const job of body.jobs) {
        assert.ok(job.attempts <= 3);
        assert.equal('user' in job,false); assert.equal('assistant' in job,false);
      }
    }
  } finally { await x.cleanup(); }
}
async function run(api,input) {
  const queued = await api.queueReceiptRecovery(input);
  return {queued,result:await api.runReceiptRecoveryJob({jobId:queued.jobId})};
}
for (const mode of ['plugin_only','server_only','mirror']) test(`duplicate_events_join ${mode}`, async () => {
  await withFixture(mode,async({x,api,rawWrites})=>{
    const input = await api.debugReceiptRecoveryFixture('input');
    const [a,b] = await Promise.all([api.queueReceiptRecovery(input),api.queueReceiptRecovery(input)]);
    assert.equal(a.jobId,b.jobId);
    const [r,s] = await Promise.all([api.runReceiptRecoveryJob({jobId:a.jobId}),api.runReceiptRecoveryJob({jobId:b.jobId})]);
    assert.equal(r.status,'verified'); assert.equal(s.status,'verified');
    assert.equal((await api.debugReadActiveCompletedTurnReceipt(1)).status,'verified');
    const status = json(await api.getReceiptRecoveryStatus({scope:input.scope}));
    assert.equal(status.receiptJobs.length,1);
    assert.equal(status.microJobs.length,1,'verified receipt has its own Micro stage');
    assert.equal(status.microJobs[0].receiptRef,r.receiptRef);
    assert.equal(status.receiptJobs[0].attempts,1);
    assert.equal(rawWrites.length,mode==='server_only'?0:1,'one local receipt write');
    const remoteReceipts = x.getRecords('libra.completed_turn_receipt.v1');
    assert.equal(remoteReceipts.length,mode==='plugin_only'?0:1,'one server receipt');
    if(remoteReceipts.length)assert.equal(remoteReceipts[0].revision,1,'server receipt never replayed');
    const before = rawWrites.length;
    await api.getReceiptRecoveryStatus({scope:input.scope});
    assert.equal(rawWrites.length,before,'status never rewrites the receipt');
  },{allowMockModelCalls:true});
});
test('pending_write_late_readback',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input = await api.debugReceiptRecoveryFixture('input');
  const entered=deferred(), release=deferred(), set=x.backend.setItem;
  x.backend.setItem=async(k,v)=>{if(k.includes(':source-receipt:')){entered.resolve();await release.promise;}return set(k,v);};
  const original = api.debugReceiptRecoveryFixture('persist');await entered.promise;
  const q=await api.queueReceiptRecovery({...input,reason:'pending_write',attempts:1,writeOutcome:'unknown'});
  const joined=api.runReceiptRecoveryJob({jobId:q.jobId});await tick(); assert.equal(rawWrites.length,0);
  release.resolve(); await original;
  assert.equal((await joined).status,'verified');assert.equal(rawWrites.length,1,'join no replay');
  assert.equal((await api.getReceiptRecoveryStatus({scope:input.scope})).receiptJobs[0].attempts,1);
}));
test('worker timeout remains unknown until admitted write finishes',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input'),set=x.backend.setItem;
  const entered=deferred(),release=deferred(),timer=x.f.r.context.setTimeout;
  x.f.r.context.setTimeout=(cb,delay,...args)=>timer(cb,delay===5000?0:delay,...args);
  x.backend.setItem=async(k,v)=>{if(k.includes(':source-receipt:')){entered.resolve();await release.promise;}return set(k,v);};
  try {
    const queued=await api.queueReceiptRecovery(input),running=api.runReceiptRecoveryJob({jobId:queued.jobId});
    await entered.promise;
    const result=await Promise.race([running,new Promise((_,reject)=>setTimeout(()=>reject(new Error('worker did not return pending_write at its observation deadline')),100))]);
    assert.equal(result.status,'pending_write');assert.match(result.reason,/unknown/);
    assert.equal((await api.runReceiptRecoveryJob({jobId:queued.jobId})).status,'pending_write');
    assert.equal(rawWrites.length,0,'pending mutation has not been replayed');
    release.resolve();await tick();await tick();
    assert.equal((await api.runReceiptRecoveryJob({jobId:queued.jobId})).status,'verified');assert.equal(rawWrites.length,1);
  } finally {release.resolve();}
}));
test('three_attempt_backoff original inclusive',async()=>withFixture('plugin_only',async({x,api,rawWrites,delays})=>{
  const input=await api.debugReceiptRecoveryFixture('input'), set=x.backend.setItem;
  x.backend.setItem=async(k,v)=>{if(k.includes(':source-receipt:')){rawWrites.push({key:k,value:v});return false;}return set(k,v);};
  const {queued,result}=await run(api,{...input,attempts:1,writeOutcome:'failed'});
  assert.equal(result.status,'failed');assert.deepEqual(delays,[1000,3000]);assert.equal(rawWrites.length,2);
  await api.queueReceiptRecovery({...input,attempts:0,writeOutcome:'not_started'});
  assert.equal((await api.runReceiptRecoveryJob({jobId:queued.jobId})).status,'failed');
  assert.equal((await api.getReceiptRecoveryStatus({scope:input.scope})).receiptJobs[0].attempts,3);
  assert.equal(rawWrites.length,2,'duplicate does not reset exhausted cycle');
}));
test('unknown_never_reissues including restart',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input');
  const {queued,result}=await run(api,{...input,attempts:1,writeOutcome:'unknown'});
  assert.equal(result.status,'pending_write');assert.match(result.reason,/unknown/);assert.equal(rawWrites.length,0);
  await x.restart();const restored=x.f.r.api, status=await restored.getReceiptRecoveryStatus({scope:input.scope});
  assert.equal(status.receiptJobs[0].jobId,queued.jobId);
  assert.equal((await restored.runReceiptRecoveryJob({jobId:queued.jobId})).status,'pending_write');assert.equal(rawWrites.length,0);
}));
for(const failedKey of [':source-receipt:',':source-receipt-head:'])
  test(`mirror one-sided ${failedKey} repairs from verified surviving copy`,async()=>withFixture('mirror',async({x,api,rawWrites})=>{
    const input=await api.debugReceiptRecoveryFixture('input'),set=x.backend.setItem;let failed=false;
    x.backend.setItem=async(k,v)=>{if(!failed&&k.includes(failedKey)){failed=true;throw new Error('injected local copy failure');}return set(k,v);};
    await assert.rejects(api.debugReceiptRecoveryFixture('persist'));
    const before=rawWrites.length;
    const {result}=await run(api,{...input,attempts:1,writeOutcome:'unknown'});
    assert.equal(result.status,'verified');assert.equal((await api.debugReadActiveCompletedTurnReceipt(1)).status,'verified');
    if(failedKey.includes('head'))assert.equal(rawWrites.length,before,'verified raw copy not rewritten');
  }));
test('verified_receipt_head_only_repair',async()=>withFixture('mirror',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input');await api.debugReceiptRecoveryFixture('persist');
  const active=await api.debugReadActiveCompletedTurnReceipt(1), before=rawWrites.length;
  x.local.delete(active.headKey);await x.mutate(active.headKey,null,'remove');
  assert.equal((await run(api,input)).result.status,'verified');assert.equal(rawWrites.length,before,'no verified raw rewrite');
  assert.equal((await api.debugReadActiveCompletedTurnReceipt(1)).status,'verified');
}));
test('output failure registers background job without starting analysis',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input'),set=x.backend.setItem;let attempts=0;
  x.backend.setItem=async(k,v)=>{if(k.includes(':source-receipt:')&&++attempts===1){rawWrites.push({key:k,value:v});return false;}return set(k,v);};
  const captured=await api.debugReceiptRecoveryFixture('capture');assert.equal(captured.ok,true);assert.equal(captured.receiptStatus,'pending_reconciliation');
  let job;for(let i=0;i<100;i++){job=(await api.getReceiptRecoveryStatus({scope:input.scope})).receiptJobs[0];if(job?.status==='verified')break;await tick();}
  assert.ok(job,'failed producer must register a recovery job');assert.equal(job.status,'verified',JSON.stringify({reason:job.reason,got:job.boundary,wanted:(await api.debugReceiptRecoveryFixture('input')).boundary}));assert.equal(job.attempts,2);assert.equal(rawWrites.length,2);
}));
test('duplicate output does not reset exhausted recovery budget',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input'),set=x.backend.setItem;
  x.backend.setItem=async(k,v)=>{if(k.includes(':source-receipt:')){rawWrites.push({key:k,value:v});return false;}return set(k,v);};
  await api.debugReceiptRecoveryFixture('capture');
  let job;for(let i=0;i<100;i++){job=(await api.getReceiptRecoveryStatus({scope:input.scope})).receiptJobs[0];if(job?.status==='failed')break;await tick();}
  assert.ok(job,'failed producer must register a recovery job');assert.equal(job.attempts,3,job.reason);assert.equal(rawWrites.length,3);
  await api.debugReceiptRecoveryFixture('capture');await tick();assert.equal(rawWrites.length,3);
}));
test('immutable_conflict',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input');await api.debugReceiptRecoveryFixture('persist');
  const active=await api.debugReadActiveCompletedTurnReceipt(1), receipt=json(active.receipt);
  receipt.user.text+=' conflict';x.local.set(active.receiptKey,JSON.stringify(receipt));x.local.delete(active.headKey);
  const before=rawWrites.length,{result}=await run(api,input);
  assert.equal(result.status,'failed');assert.match(result.reason,/immutable_conflict/);assert.equal(rawWrites.length,before);
}));
test('restart_with_refs no duplicate receipt',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input');const {queued}=await run(api,input),before=rawWrites.length;
  await x.restart();const restored=x.f.r.api;
  assert.equal((await restored.runReceiptRecoveryJob({jobId:queued.jobId})).status,'verified');assert.equal(rawWrites.length,before);
}));
test('route and worldline boundaries deny old job',async()=>withFixture('plugin_only',async({api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input');
  const route=await run(api,{...input,boundary:{...input.boundary,route:input.boundary.route+'/moved'}});
  assert.equal(route.result.status,'paused');assert.equal(rawWrites.length,0);
  const other=await run(api,{...input,missingTurns:[{...input.missingTurns[0],worldlineId:'wl_unrelated'}]});
  assert.equal(other.result.status,'stale');assert.equal(rawWrites.length,0);
}));
test('restart_original_and_receipt_lost',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input');const {queued}=await run(api,{...input,attempts:1,writeOutcome:'unknown'});
  await x.restart();x.f.chat.message.splice(0);const restored=x.f.r.api;await restored.getReceiptRecoveryStatus({scope:input.scope});
  assert.equal((await restored.runReceiptRecoveryJob({jobId:queued.jobId})).status,'unrecoverable');assert.equal(rawWrites.length,0);
}));
test('journal_write_failure does not produce source',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input'),set=x.backend.setItem;
  x.backend.setItem=async(k,v)=>k.endsWith(':receipt-recovery:v1')?false:set(k,v);
  const {result}=await run(api,input);assert.equal(result.status,'failed');assert.match(result.reason,/journal/);assert.equal(rawWrites.length,0);
}));
test('captured_scope_and_live_permission_change',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input');x.f.chat.message[0].data+=' revision';
  const {result}=await run(api,input);assert.equal(result.status,'stale');assert.equal(rawWrites.length,0);
}));
test('scope change pauses without retargeting',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input');x.f.chat.id='another-chat';x.f.chat.chatId='another-chat';
  const {result}=await run(api,input);assert.equal(result.status,'paused');assert.equal(rawWrites.length,0);
}));
// The native tracker/controller was removed by the explicit-reanalysis contract.
// These are named current replacements; original tracker failures remain in evidence.
test('owner transition permit denied before receipt recovery I/O',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input');
  // Queue before the transition and do not schedule the background worker.
  const queued=await api.queueReceiptRecovery({...input,deferRun:true});
  const settings=await api.debugReceiptRecoveryFixture('connection');
  assert.equal(settings.mode,'plugin_only');
  assert.equal(settings.transition,null);
  const registryKey='__memory_suite_internal_scope_routes_v1__:libra';
  const original=x.local.get(registryKey);
  const registry=original == null ? {entries:{}} : JSON.parse(original);
  registry.entries=registry.entries || {};
  const scopeId=settings.scope.scopeId;
  assert.ok(scopeId,'use real bridge scope identity');
  registry.entries[scopeId]={...settings.scope,...registry.entries[scopeId],
    scopeId,mode:'plugin_only',origin:'transition_pending',pendingTargetMode:'server_only',
    updatedAt:Math.max(Date.now(),Number(registry.entries[scopeId]?.updatedAt || 0)+1)};
  const set=x.backend.setItem;
  let headWrites=0;
  x.backend.setItem=async(k,v)=>{if(k.includes(':source-receipt-head:'))headWrites++;return set(k,v);};
  try {
    x.local.set(registryKey,JSON.stringify(registry));
    const blocked=await api.debugReceiptRecoveryFixture('connection');
    assert.equal(blocked.mode,'plugin_only');
    assert.equal(blocked.transition?.scopeId,scopeId);
    assert.equal(blocked.transition?.fromMode,'plugin_only');
    assert.equal(blocked.transition?.toMode,'server_only');
    assert.equal(blocked.transition?.phase,'pending','real bridge must see the seeded owner state');
    const result=await api.runReceiptRecoveryJob({jobId:queued.jobId,suppressMicroResume:true});
    assert.equal(result.status,'paused');
    assert.equal(result.reason,'owner_permit_unavailable');
    assert.equal(rawWrites.length,0);
    assert.equal(headWrites,0);
  } finally {
    if(original == null)x.local.delete(registryKey);else x.local.set(registryKey,original);
    await api.debugReceiptRecoveryFixture('connection');
    x.backend.setItem=set;
  }
}));
test('legacy source-edit journal stays inert during current receipt recovery',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input');
  const legacyKey=`libra:v1:scope:${input.scope.scopeKey}:source-edit-consent:v1`;
  const legacy=JSON.stringify({schema:'memory-suite.source-edit-consent.v1',owner:'libra',scopeKey:input.scope.scopeKey,
    tasks:{'1':{key:'1',start:1,end:5,state:'awaiting_consent',revisionId:'revision_blocked'}},exceptions:{}});
  x.local.set(legacyKey,legacy);
  const get=x.backend.getItem,set=x.backend.setItem,remove=x.backend.removeItem;
  let trackerReads=0,trackerWrites=0,trackerRemovals=0;
  x.backend.getItem=async k=>{if(k===legacyKey)trackerReads++;return get(k);};
  x.backend.setItem=async(k,v)=>{if(k===legacyKey)trackerWrites++;return set(k,v);};
  x.backend.removeItem=async k=>{if(k===legacyKey)trackerRemovals++;return remove(k);};
  try {
    const queued=await api.queueReceiptRecovery({...input,deferRun:true});
    // Keep this compatibility test about receipt recovery. Separate existing
    // cases cover the downstream Micro scheduler; do not start it here.
    const result=await api.runReceiptRecoveryJob({jobId:queued.jobId,suppressMicroResume:true});
    assert.equal(result.status,'verified');
    const active=await api.debugReadActiveCompletedTurnReceipt(1);
    assert.equal(active.status,'verified');
    assert.equal(active.receipt.revisionId,input.missingTurns[0].revisionId);
    assert.equal(active.receipt.sourceDigest,input.missingTurns[0].sourceDigest);
    assert.equal(rawWrites.length,1);
    assert.equal(trackerReads,0);
    assert.equal(trackerWrites,0);
    assert.equal(trackerRemovals,0);
    assert.equal(x.local.get(legacyKey),legacy);
  } finally {
    x.backend.getItem=get;x.backend.setItem=set;x.backend.removeItem=remove;
  }
}));
test('corrupt recovery ledger cannot block a fresh normal output',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input');
  const key=`libra:v1:scope:${input.scope.scopeKey}:receipt-recovery:v1`,broken='{"schema":"damaged-recovery-ledger"}';
  x.local.set(key,broken);
  const capture=await api.debugReceiptRecoveryFixture('capture');
  assert.equal(capture.receiptStatus,'verified');assert.equal(rawWrites.length,1);
  assert.equal(x.local.get(key),broken,'producer must not overwrite damaged recovery journal');
  assert.equal((await api.debugReadActiveCompletedTurnReceipt(1)).status,'verified');
}, {allowMockModelCalls:true}));
test('corrupt ledger holds overlapping admitted receipt write',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input');
  const key=`libra:v1:scope:${input.scope.scopeKey}:receipt-recovery:v1`,broken='{"schema":"damaged-recovery-ledger"}';
  x.local.set(key,broken);
  const entered=deferred(),release=deferred(),set=x.backend.setItem;
  x.backend.setItem=async(k,v)=>{if(k.includes(':source-receipt:')){entered.resolve();await release.promise;}return set(k,v);};
  const admitted=api.debugReceiptRecoveryFixture('persist');
  try {
    await entered.promise;
    const capture=await Promise.race([api.debugReceiptRecoveryFixture('capture'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('normal output joined ambiguous write')),100))]);
    assert.equal(capture.receiptStatus,'pending_reconciliation');assert.equal(rawWrites.length,0);
    assert.equal(x.local.get(key),broken);
  } finally {release.resolve();await admitted;}
}));
test('restart with one-sided copy and unknown old operation never auto-reissues',async()=>withFixture('mirror',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input');
  const queued=await api.queueReceiptRecovery({...input,attempts:1,writeOutcome:'unknown'});
  assert.equal((await api.runReceiptRecoveryJob({jobId:queued.jobId})).status,'pending_write');
  await api.debugReceiptRecoveryFixture('persist');
  const active=await api.debugReadActiveCompletedTurnReceipt(1),raw=x.local.get(active.receiptKey);
  x.local.delete(active.receiptKey);x.local.delete(active.headKey);await x.mutate(active.headKey,null,'remove');
  const ledgerKey=`libra:v1:scope:${input.scope.scopeKey}:receipt-recovery:v1`,ledger=JSON.parse(x.local.get(ledgerKey));
  ledger.jobs[0].status='pending_write';ledger.jobs[0].reason='restart_write_unknown';ledger.jobs[0].writeOutcome='unknown';ledger.jobs[0].attempts=1;
  x.local.set(ledgerKey,JSON.stringify(ledger));await x.mutate(ledgerKey,ledger);
  await x.restart();
  // Startup may reconcile the copy before this test can represent the old
  // in-flight operation. Force and assert the exact partial state being tested.
  x.local.delete(active.receiptKey);
  assert.equal(x.local.has(active.receiptKey),false);
  assert.ok(x.storedRows().some(row=>row.key===active.receiptKey),'server copy survives restart');
  assert.equal(x.local.has(active.headKey),false);
  const restored=x.f.r.api,entered=deferred(),release=deferred(),set=x.backend.setItem;
  assert.equal(await restored.debugReceiptRecoveryFixture('partialProbe'),false,'a matching copy does not prove the old operation settled');
  const timer=x.f.r.context.setTimeout;
  x.f.r.context.setTimeout=(cb,delay,...args)=>timer(cb,delay===5000?0:delay,...args);
  let receiptWrites=0,headWrites=0;
  x.backend.setItem=async(k,v)=>{
    if(k===active.receiptKey){receiptWrites++;if(receiptWrites===1){entered.resolve();await release.promise;}}
    if(k===active.headKey)headWrites++;
    return set(k,v);
  };
  const oldPending=x.backend.setItem(active.receiptKey,raw);
  try {
    await entered.promise;
    const result=await restored.runReceiptRecoveryJob({jobId:queued.jobId});
    assert.equal(result.status,'pending_write');assert.equal(receiptWrites,1,'new VM cannot prove old physical mutation finished');
    assert.equal(headWrites,0);assert.equal(rawWrites.length,1,'only the original VM wrote through SDK');
  } finally {release.resolve();await oldPending;}
}));
test('restore generation changes after admitted raw write',async()=>withFixture('plugin_only',async({x,api,rawWrites})=>{
  const input=await api.debugReceiptRecoveryFixture('input'),set=x.backend.setItem;
  x.backend.setItem=async(k,v)=>{const result=await set(k,v);if(k.includes(':source-receipt:'))await api.debugReceiptRecoveryFixture('restore');return result;};
  const {result}=await run(api,input);assert.equal(result.status,'stale');assert.equal(rawWrites.length,1,'admitted write preserved');
  assert.equal([...x.local.keys()].filter(k=>k.includes(':source-receipt-head:')).length,0,'no stale head');
}));
(async()=>{let failed=0;for(const {name,fn} of cases){try{await fn();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name);console.error(error);}}console.log(`RESULT ${cases.length-failed}/${cases.length} passed`);process.exitCode=failed?1:0;})().catch(error=>{console.error(error);process.exitCode=1;});
