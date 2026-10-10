'use strict';
const assert=require('node:assert/strict');const {serverFixture,fiveMore}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {createRootBoundary}=require('./fixtures/source_edit_root_boundary.cjs');const {artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {classifyCall,countCalls}=require('./fixtures/libra_provider_call_kinds.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const assertCanonicalCalls=(f,expected)=>{assert.equal(countCalls(f.control).canonical,expected,'Canonical extraction count');assert.equal(countCalls(f.control).other,0,'no unrelated provider call');};
const onCanonicalCall=(f,handler)=>{f.control.onCall=async args=>classifyCall(args)==='canonical'?handler(args):{type:'success',result:JSON.stringify(f.control.artifact)};};
const results=[];async function test(name,fn,opts={}){if(process.env.LIBRA_SERVER_TEST_FILTER&&!name.includes(process.env.LIBRA_SERVER_TEST_FILTER))return;const s=await serverFixture(opts);try{await fn(s);results.push(name);console.log('PASS',name);}finally{await s.cleanup();}}
const stateBatch=b=>b.mutations.some(m=>m.key.includes(':continuity-state'));
const manifestBatch=b=>b.mutations.some(m=>m.key.endsWith(':manifest'));
const beforeView=s=>JSON.stringify(s.getHead());
// Authoritative head CONTENT only. The replay's own derived bookkeeping
// (`basis.replayFingerprint`, `unifiedReplay`) and `updatedAt` legitimately differ
// after a re-open (doc 03 ch.2: timestamps are the one allowed normalization), so a
// byte comparison would fail on the replay's own metadata instead of on state.
const authoritativeHead=raw=>{const v=typeof raw==='string'?JSON.parse(raw):raw;return JSON.stringify({status:v.status,throughTurn:v.throughTurn,worldlineId:v.worldlineId,characters:v.characters,relationships:v.relationships,world:v.world,narrative:v.narrative,domainStatus:v.domainStatus});};
(async()=>{
 await test('public five-turn and ten-turn paths really write server canonical/state and recall, no local duplicate',async s=>{
  const f=s.f,one=await f.run();assert.equal(one.completed,1,JSON.stringify(one));assert.equal(s.getMemory().artifactSchema,'libra.canonical_artifact.v4');assert.equal(s.getHead().throughTurn,5);assert.equal(s.getHead().status,'ready');
  assert.ok(s.batches.some(manifestBatch));assert.ok(s.batches.some(stateBatch));assert.ok(![...s.local.keys()].some(k=>k.includes(':continuity-state')));
  const callsBeforeRecall=f.control.calls.length;const recall=await f.r.api.previewUnifiedMemoryRecall('민아 은빛 열쇠 반환');assert.ok(recall.memories.length);assertCanonicalCalls(f,1);assert.equal(f.control.calls.length,callsBeforeRecall,'recall makes no physical provider call');
  fiveMore(f);const two=await f.run();assert.equal(two.completed,1,JSON.stringify(two));assert.equal(s.getHead().throughTurn,10);assert.equal(Object.keys(s.getManifest().memories).length,2);assertCanonicalCalls(f,2);
 });
 await test('current correction plus journal/metadata/Registry/Head form one transaction and pause/reactivate without LLM',async s=>{
  const f=s.f;await f.run();const callsBeforeCorrection=f.control.calls.length,original=JSON.stringify(s.getMemory().canonicalArtifact),world=s.getHead().world.find(r=>r.name==='도서관');
  const c=await f.r.api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'world'},patch:{world:[{id:world.id,set:{condition:'휴관 중'}}]}});assert.equal(c.ok,true,JSON.stringify(c));assert.equal(s.getHead().world.find(r=>r.id===world.id).state.condition,'휴관 중');
  const batch=s.batches.at(-1);assert.ok(batch.mutations.some(m=>m.key.includes('correction')));assert.ok(stateBatch(batch));assert.ok(batch.mutations.some(m=>m.key.endsWith(':entity-registry:v2')));
  assert.equal((await f.r.api.setWorldManagerCorrectionStatus(c.correctionId,'suspended')).ok,true);assert.equal(s.getHead().world.find(r=>r.id===world.id).state.condition,undefined);
  assert.equal((await f.r.api.setWorldManagerCorrectionStatus(c.correctionId,'active')).ok,true);assert.equal(s.getHead().world.find(r=>r.id===world.id).state.condition,'휴관 중');assert.equal(JSON.stringify(s.getMemory().canonicalArtifact),original);assertCanonicalCalls(f,1);assert.equal(f.control.calls.length,callsBeforeCorrection,'correction and status changes make no physical provider call');
 });
 await test('post-canonical SQLite Head write failure leaves no partial Registry and state retry uses original prepared operation',async s=>{
  const f=s.f;s.app.repositories.libra.database.exec("CREATE TEMP TRIGGER product_fail BEFORE INSERT ON kv WHEN NEW.key LIKE '%:continuity-state' BEGIN SELECT RAISE(ABORT,'product_head_failure'); END;");
  await f.run();assert.equal(s.getMemory().status,'committed');assert.equal(s.getHead(),undefined);assert.equal(s.getRecords('libra.entity_registry.v2').length,0);
  const tx=s.getRecords('libra.unified_state_tx.v1')[0]?.value;assert.ok(tx?.serverPrepared,'durable prepared retry required');const op=tx.serverPrepared.body.operationId;
  await f.r.api.retryPendingUnifiedVectors();assert.equal(s.getMemory().embedding.status,'disabled');
  s.app.repositories.libra.database.exec('DROP TRIGGER product_fail');const callsBeforeRetry=f.control.calls.length,retry=await f.r.api.retryPendingUnifiedState();assert.ok(s.getHead(),JSON.stringify(retry));assert.equal(s.getHead().throughTurn,5);assertCanonicalCalls(f,1);assert.equal(f.control.calls.length,callsBeforeRetry,'State retry makes no physical provider call');assert.ok(s.batches.filter(b=>b.operationId===op).length>=2);
 });
 await test('fresh plugin runtime resumes failed state group from durable server journal without reanalysis',async s=>{
  s.app.repositories.libra.database.exec("CREATE TEMP TRIGGER product_restart_fail BEFORE INSERT ON kv WHEN NEW.key LIKE '%:continuity-state' BEGIN SELECT RAISE(ABORT,'restart_head_failure'); END;");
  await s.f.run();assert.ok(s.getMemory());assert.equal(s.getHead(),undefined);s.app.repositories.libra.database.exec('DROP TRIGGER product_restart_fail');const f=await s.restart();const out=await f.r.api.retryPendingUnifiedState();assert.equal(s.getHead()?.throughTurn,5,JSON.stringify(out));assert.equal(f.control.calls.length,0);
 });
 await test('response loss after atomic activation is resolved by operation receipt, not a second commit',async s=>{
  let lost=0;s.hooks.afterBatch=async b=>{if(lost<2){lost++;throw Error('synthetic_network_response_loss_after_commit');}};const out=await s.f.run();assert.equal(out.completed,1,JSON.stringify(out));assert.equal(s.getHead().throughTurn,5);assert.equal(lost,2);assertCanonicalCalls(s.f,1);
 });
 await test('external Head correction during model wait survives and blocks old candidate',async s=>{
  await s.f.run();fiveMore(s.f);const headRow=s.getRecords('libra.continuity_state.v2')[0];let external;
  onCanonicalCall(s.f,async()=>{external={...headRow.value,externalMarker:'user_changed_during_provider_wait'};await s.mutate(headRow.key,external);return {type:'success',result:JSON.stringify(s.f.control.artifact)};});
  const out=await s.f.run();assert.equal(out.completed,0,JSON.stringify(out));assert.equal(s.getHead().externalMarker,external.externalMarker);assert.ok(!s.getManifest().memories['6']);
 });
 await test('same-value ABA during provider wait invalidates pre-model server revisions',async s=>{
  await s.f.run();fiveMore(s.f);const row=s.getRecords('libra.continuity_state.v2')[0];onCanonicalCall(s.f,async()=>{await s.mutate(row.key,{...row.value,testABA:true});await s.mutate(row.key,row.value);return {type:'success',result:JSON.stringify(s.f.control.artifact)};});
  const out=await s.f.run();assert.equal(out.completed,0,JSON.stringify(out));assert.ok(!s.getManifest().memories['6']);assert.equal(s.getHead().throughTurn,5);
 });
 await test('activation race cannot be bypassed by generic failure-handler manifest save',async s=>{
  let external=null;s.hooks.beforeBatch=async b=>{if(external||!manifestBatch(b))return;const target=b.mutations.find(m=>m.key.endsWith(':manifest'));const row=s.storedRows().find(r=>r.key===target.key);external={...row.value,seventhExternalMark:'preserve'};await s.mutate(target.key,external);};
  const out=await s.f.run();assert.equal(out.completed,0,JSON.stringify(out));assert.ok(external);assert.equal(s.getManifest().seventhExternalMark,'preserve');assert.ok(!s.getManifest().memories['1']);assert.equal(s.getHead(),undefined);
 });
 await test('failed correction batch never publishes its journal before Head and retry is local',async s=>{
  await s.f.run();const callsBeforeCorrection=s.f.control.calls.length,head=beforeView(s),world=s.getHead().world.find(r=>r.name==='도서관');const journals=JSON.stringify(s.getRecords('libra.state_correction_store.v1'));
  s.app.repositories.libra.database.exec("CREATE TEMP TRIGGER correction_fail BEFORE UPDATE ON kv WHEN NEW.key LIKE '%:continuity-state' BEGIN SELECT RAISE(ABORT,'correction_failure'); END;");
  await assert.rejects(()=>s.f.r.api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'world'},patch:{world:[{id:world.id,set:{condition:'교정값'}}]}}));assert.equal(beforeView(s),head);assert.equal(JSON.stringify(s.getRecords('libra.state_correction_store.v1')),journals);
  s.app.repositories.libra.database.exec('DROP TRIGGER correction_fail');const r=await s.f.r.api.rebuildWorldManagerState();assert.equal(r.ok,true,JSON.stringify(r));assert.equal(s.getHead().world.find(r=>r.id===world.id).state.condition,'교정값');assertCanonicalCalls(s.f,1);assert.equal(s.f.control.calls.length,callsBeforeCorrection,'failed correction and replay make no physical provider call');
 });
 const root=createRootBoundary();await test('beforeRequest automatically replaces source and server atomically replays while preserving old revision',async s=>{
  const f=s.f;await f.run();const oldKey=s.getManifest().memories['1'].key,old=s.storedRows().find(r=>r.key===oldKey).raw;
  const quote='서재에서 지호는 은빛 열쇠를 민아에게 반환하지 않았다. 반환 약속은 아직 남았다. 공연 허가자는 알려지지 않았다.';f.chat.message[9].data=quote;const a=artifact();for(const x of [...a.entities,...a.facts])for(const e of x.evidenceSpans)if(e.ref==='t5-a')e.quote=quote;a.facts.find(x=>x.tempFactId==='f11').values.holderRef='jiho';a.facts.find(x=>x.tempFactId==='f11').text='지호는 은빛 열쇠를 아직 반환하지 않았다.';a.facts.find(x=>x.tempFactId==='f12').values.thread.status='open';a.facts.find(x=>x.tempFactId==='f12').text='반환 약속은 아직 이행되지 않았다.';f.control.artifact=a;
  await f.r.sourceEditBoundary();assert.equal(await root.ready(),false,'automatic source repair shows no consent dialog');
  // Request deadlines may return while original-packet verification/replay is
  // still running. Check its actual terminal publication, without extending a
  // product deadline or treating a scheduled task as a committed replacement.
  await waitFor(()=>!['queued','running'].includes(f.r.api.getSourceEditSyncStatus().tasks[0]?.state),30000);
  assert.equal(f.r.api.getSourceEditSyncStatus().tasks[0].state,'applied');assert.equal(s.getMemory().revision,2);assert.equal(s.storedRows().find(r=>r.key===oldKey).raw,old);assertCanonicalCalls(f,2);const head=s.getHead();assert.equal(head.world.find(r=>r.name==='은빛 열쇠').state.holderRef,head.characters.find(r=>r.name==='지호').id);
 },{host:{getRootDocument:async()=>root.root}});
 await test('rollback is a supported view and handoff cannot bypass bounded server writer support',async s=>{
  await s.f.run();await s.f.r.api.retryPendingUnifiedVectors();const memory=JSON.stringify(s.getMemory()),head=beforeView(s),calls=s.f.control.calls.length;
  // Rollback is now a supported VIEW in server-backed modes (T01): it rewinds the visible
  // head but must leave the canonical memory bytes and the model-call count untouched.
  const rolled=await s.f.r.api.rollbackWorldManagerState({throughTurn:0});
  assert.equal(rolled.ok,true,JSON.stringify(rolled));
  assert.equal(rolled.head.throughTurn,0,'the rolled-back view is rewound');
  assert.equal(JSON.stringify(s.getMemory()),memory,'a view operation does not rewrite canonical memory');
  assert.equal(s.f.control.calls.length,calls,'a view operation costs no model call');
  // Re-open main and confirm the committed view is restored, still without a model call.
  // Only the replay's own derived bookkeeping (replayFingerprint, unifiedReplay) and the
  // write timestamp differ; every authoritative field must agree.
  const resumed=await s.f.r.api.setWorldManagerWorldline({});
  assert.equal(resumed.ok,true,JSON.stringify(resumed));
  assert.equal(authoritativeHead(beforeView(s)),authoritativeHead(head),
    're-opening main restores the committed view content');
  assert.equal(JSON.stringify(s.getMemory()),memory);assert.equal(s.f.control.calls.length,calls);
  // Scope deletion is covered by libra_owned_scope_delete_runtime_test; handoff remains bounded.
  await assert.rejects(()=>s.f.r.api.prepareSessionHandoff({transferId:'unsupported-server-handoff'}),/UNIFIED_BACKEND_NOT_SUPPORTED/);
  assert.equal(JSON.stringify(s.getMemory()),memory);assert.equal(s.f.control.calls.length,calls);
 });
 await test('mirror unified path commits server batches and verified local copies',async s=>{const out=await s.f.run();await s.f.r.api.retryPendingUnifiedVectors();assert.equal(out.completed,1,JSON.stringify(out));assert.ok(s.batches.some(manifestBatch));assert.ok(s.batches.some(stateBatch));assert.equal(s.getHead().throughTurn,5);for(const row of s.storedRows().filter(row=>row.key.endsWith(':manifest')||row.value?.schema==='libra.continuity_state.v2'))assert.equal(s.local.get(row.key),row.raw);},{mode:'mirror'});
 console.log(JSON.stringify({test:'libra_unified_server_writer_v1',passed:results.length,results,boundary:'actual production LIBRA public APIs + real HTTP/SQLite; synthetic RisuAI/LLM only'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
