'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {fiveMore,serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const expose=s=>s.replace('    const exportCurrentScope = async () => {',`
    globalThis.__oom={settled:stateTrackingReplaySettled,seal:statePipelineReceiptDigest,digest,
      core:()=>({refreshSnapshot,resolveContext,recoverPendingStateTrackingJournal,snapshot:()=>state.snapshot})};
    const exportCurrentScope = async () => {`).replace(
    'const refreshSerial = ++state.snapshotRefreshSerial;',
    'const refreshSerial = ++state.snapshotRefreshSerial; if(globalThis.__snapshotGate)await globalThis.__snapshotGate();');
const gate=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};

test('completed local replay keeps quarantined facts but does not keep scheduling whole-chain recovery',async t=>{
 const f=await fixture({transformSource:expose});t.after(()=>f.r.cleanup());
 f.control.artifact.schema='libra.canonical_artifact.v5';
 const invalid=f.clone(f.control.artifact.facts.find(f=>f.tempFactId==='f5'));
 f.control.artifact.entities.push({tempId:'unbound-room',name:'원문에 없는 방',type:'world',kind:'location',evidenceSpans:invalid.evidenceSpans});
 invalid.tempFactId='quarantined-location';invalid.values.locationRef='unbound-room';
 f.control.artifact.facts.push(invalid);f.control.artifact.stateBindings.push({factTempId:invalid.tempFactId});
 const artifact=f.clone(f.control.artifact);
 await f.run();fiveMore(f);await f.run();f.control.artifact=artifact;
 const inventory=await f.r.api.listReanalysisRanges({kind:'canonical'});
 assert.equal((await f.r.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.start<=5)})).ok,true);
 const before=f.getHead();assert.equal(before.status,'partial');
 assert.ok(Object.values(before.domainStatus).every(v=>v.status==='ready'));
 assert.deepEqual(before.unifiedApplied.pending.map(p=>p.reason),['memory_record_quarantined']);
 const core=f.r.context.__oom.core(),context=await core.resolveContext(),calls=f.control.calls.length;
 for(let i=0;i<2;i++){
  const result=await core.recoverPendingStateTrackingJournal(context,{force:true});
  assert.equal(result.attempted,0);assert.equal(result.remaining,0);
 }
 assert.deepEqual(f.getHead().unifiedApplied.pending,before.unifiedApplied.pending,'excluded facts stay pending; completing the job is not approving them');
 assert.equal(f.control.calls.length,calls);
});

test('only a sealed completed replay with nonblocking holds can settle a partial receipt',async t=>{
 const f=await fixture({transformSource:expose});t.after(()=>f.r.cleanup());
 const c=f.r.context.__oom;
 const make=()=>{
  const head={domainStatus:Object.fromEntries(['characters','relationships','world','narrative'].map(k=>[k,{status:'ready'}])),unifiedApplied:{pending:[{domain:'world',reason:'memory_record_quarantined'}]}};
  const registry={entities:[]},receipt={schema:'libra.state_pipeline_receipt.v1',status:'partial',replay:true,headDigest:c.digest(head),registryDigest:c.digest(registry)};
  receipt.receiptDigest=c.seal(receipt);return {ok:true,localReplay:true,head,registry,receipt};
 };
 const seal=r=>{r.receipt.headDigest=c.digest(r.head);r.receipt.registryDigest=c.digest(r.registry);r.receipt.receiptDigest=c.seal(r.receipt);return r;};
 assert.equal(c.settled(make()),true);
 let r=make();r.head.unifiedApplied.pending[0].reason='thread_link_pending:thread_anchor_evidence_missing';assert.equal(c.settled(seal(r)),false);
 r=make();r.head.domainStatus.world.status='not_updated';assert.equal(c.settled(seal(r)),false);
 r=make();r.head.unifiedCoverage={legacyCount:1};assert.equal(c.settled(seal(r)),false);
 r=make();r.pendingBoundary={reason:'missing_source'};assert.equal(c.settled(r),false);
 r=make();r.localReplay=false;assert.equal(c.settled(r),false);
 r=make();delete r.receipt;assert.equal(c.settled(r),false);
 r=make();r.receipt.headDigest='changed';assert.equal(c.settled(r),false);
 r=make();r.receipt.registryDigest='changed';assert.equal(c.settled(r),false);
 r=make();r.receipt.receiptDigest='changed';assert.equal(c.settled(r),false);
});

test('direct snapshot callers serialize; queued identical calls merge without sharing mutable cloned results',async t=>{
 const f=await fixture({transformSource:expose});t.after(()=>f.r.cleanup());
 await f.run();const core=f.r.context.__oom.core(),context=await core.resolveContext(),hold=gate();t.after(()=>hold.release());
 let active=0,peak=0,calls=0;
 f.r.context.__snapshotGate=async()=>{calls++;active++;peak=Math.max(peak,active);try{await hold.promise;}finally{active--;}};
 const first=core.refreshSnapshot(context,{summaryOnly:true});await waitFor(()=>calls===1);
 const second=core.refreshSnapshot(context,{summaryOnly:true}),third=core.refreshSnapshot(context,{summaryOnly:true});
 await new Promise(r=>setTimeout(r,30));assert.equal(calls,1);assert.equal(peak,1);
 hold.release();const results=await Promise.all([first,second,third]);
 assert.equal(peak,1);assert.equal(calls,2,'one active projection plus one merged fresh follow-up');
 assert.notEqual(results[1],results[2]);results[1].error='changed by caller';assert.notEqual(results[2].error,results[1].error);
});

test('server chat switching paints only the selected summary while State verification is queued',async t=>{
 let selected=0, chats;
 const server=await serverFixture({transformSource:expose,host:{
  getCurrentChatIndex:async()=>selected,
  getChatFromIndex:async(_character,index)=>chats?.[index]
 }});
 const {f}=server;
 t.after(()=>server.cleanup());
 await f.run();
 chats=[f.chat,{id:'snapshot-chat-b',chatId:'snapshot-chat-b',name:'B',message:[],messages:[]}];
 f.character.chats=chats;
 const core=f.r.context.__oom.core();
 const hold=gate();
 t.after(()=>hold.release());
 let calls=0;
 f.r.context.__snapshotGate=async()=>{calls++;if(calls===1)await hold.promise;};
 const request=()=>{
  const summaries=[],timings={};
  const done=core.refreshSnapshot(undefined,{summaryOnly:true,skipNativeCopyAdoption:true,
    suppressGuiSchedule:true,onProvisional:snapshot=>summaries.push(snapshot),timings});
  return {summaries,timings,done};
 };
 try {
  const first=request();
  await waitFor(()=>calls===1);
  assert.ok(first.summaries[0].memories.length);
  selected=1;f.character.chatPage=1;
  const second=request();
  await waitFor(()=>second.summaries.length===1);
  assert.equal(core.snapshot().scope.chatId,'snapshot-chat-b');
  assert.equal(core.snapshot().memories.length,0);
  assert.equal(core.snapshot().continuityState,null);
  assert.equal(core.snapshot().currentStateView.authority.pending,true);
  selected=0;f.character.chatPage=0;
  const third=request();
  await waitFor(()=>third.summaries.length===1);
  assert.equal(core.snapshot().scope.chatId,f.chat.id);
  assert.ok(third.summaries[0].memories.length);
  assert.equal(calls,1);
  hold.release();
  const [a,b,c]=await Promise.all([first.done,second.done,third.done]);
  assert.equal(a.superseded,true);
  assert.equal(b.superseded,true);
  assert.equal(c.scope.chatId,f.chat.id);
  assert.equal(c.error,'');
  assert.equal(core.snapshot().scope.chatId,f.chat.id);
  assert.equal(calls,2,'the superseded queued verification was skipped');
  for(const key of ['scopeMs','manifestMs','provisionalMs','queueMs','verificationMs','stateProjectionMs']){
   assert.ok(Number.isFinite(third.timings[key]),key);
  }
 }finally{hold.release();}
});
