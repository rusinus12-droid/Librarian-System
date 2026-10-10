'use strict';
// The public beforeRequest that sees a source edit must deliver the replacement
// canonical, not the still retained previous revision, in every storage mode.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const QUERY = '민아의 은빛 열쇠를 지금 누가 갖고 있어?';
const OLD_FACT = '지호가 열쇠를 민아에게 반환했다.';
const NEW_FACT = '지호는 은빛 열쇠를 아직 반환하지 않았다.';
const EDITED_SOURCE = '서재에서 지호는 은빛 열쇠를 민아에게 반환하지 않았다. 반환 약속은 아직 남았다. 공연 허가자는 알려지지 않았다.';
const parse = raw => raw === undefined ? null : JSON.parse(raw);
const manifestOf = (snapshot, mode) => mode === 'plugin_only'
  ? parse(snapshot.local.get([...snapshot.local.keys()].find(key => key.endsWith(':manifest'))))
  : snapshot.getManifest();
const rawOf = (snapshot, mode, key) => mode === 'plugin_only'
  ? snapshot.local.get(key)
  : snapshot.storedRows().find(row => row.key === key)?.raw;
const setDurable = async (snapshot, mode, key, value) => {
  if (mode !== 'server_only') snapshot.local.set(key, JSON.stringify(value));
  if (mode !== 'plugin_only') await snapshot.mutate(key, value);
};
const removeDurable = async (snapshot, mode, key) => {
  if (mode !== 'server_only') snapshot.local.delete(key);
  if (mode !== 'plugin_only') await snapshot.mutate(key, null, 'remove');
};
const injection = (messages, failureDiagnostic = null) => {
  const blocks = messages.filter(message => String(message?.content || '').includes('[LIBRA CLASSIC RECALL — CURRENT TURN ONLY]'));
  if (blocks.length !== 1 && failureDiagnostic) {
    process.stderr.write(`source_edit_recall_failure ${JSON.stringify(failureDiagnostic)}\n`);
  }
  assert.equal(blocks.length, 1, 'one Classic recall block reaches the model request');
  return String(blocks[0].content);
};
const editedArtifact = () => {
  const next = artifact();
  for (const row of [...next.entities, ...next.facts]) {
    for (const span of row.evidenceSpans || []) if (span.ref === 't5-a') span.quote = EDITED_SOURCE;
  }
  const possession = next.facts.find(row => row.tempFactId === 'f11');
  possession.values.holderRef = 'jiho';
  possession.text = NEW_FACT;
  const promise = next.facts.find(row => row.tempFactId === 'f12');
  promise.values.thread.status = 'open';
  promise.text = '반환 약속은 아직 이행되지 않았다.';
  return next;
};


const fs = require('node:fs');
const path = require('node:path');
const evidenceDir = process.env.LIBRA_ADMISSION_EVIDENCE || path.join(require('node:os').tmpdir(), 'libra-settled-admission-evidence');
fs.mkdirSync(evidenceDir,{recursive:true});
const waitFor = async (read,label,limit=15000) => {
  const started=Date.now();
  while(Date.now()-started<limit){const value=read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}
  throw Error('fixture readiness: '+label);
};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const transform = source => {
  const settlement="await assertCurrent();\n        task.state='applied';task.forceRebuild=false;";
  const receipt="() => readRecentDialogueForResponse({ context, pairs: responseView.pairs, manifest: requestManifest,\n            settings: runtimeSettings, route: injectionMode, boundary: responseBoundary,\n            deadlineAt: Date.now() + 1400, publishState: false })";
  const receiptDispatch="const recentDialogue = await runRecallStep(guard, 'before_receipt_dialogue',";
  assert.equal(source.split(settlement).length,2,'one real task settlement anchor');
  assert.equal(source.split(receipt).length,2,'one real receipt phase anchor');
  assert.equal(source.split(receiptDispatch).length,2,'one real receipt dispatch anchor');
  return source.replace("const beforeRequest = async (messages, type) => {","globalThis.__settledAdmissionEdits=getLibraSourceEdits();globalThis.__settledAdmissionStorage=MemorySuiteStorageBridge;\n    const beforeRequest = async (messages, type) => {")
    .replace("const readSettledSourceEditManifest=async(captured,boundary,guard)=>{","const readSettledSourceEditManifest=async(captured,boundary,guard)=>{globalThis.risuai.settledAdmissionFixture('refresh-attempt',{budgetMs:guard.budgetMs,startedAt:guard.startedAt,deadlineAt:guard.deadlineAt});")
    .replace("if (needsLocal && needsServer && digest(local) !== digest(remote)) throw new Error(`LIBRA_VERIFIED_STORAGE_VALUE_MISMATCH:${storageKey}`);",
      "if (needsLocal && needsServer && digest(local) !== digest(remote)) { globalThis.risuai.settledAdmissionFixture('verified-storage-sample-mismatch',{storageKey,localRaw,serverRaw:serverRow.value}); throw new Error(`LIBRA_VERIFIED_STORAGE_VALUE_MISMATCH:${storageKey}`); }")
    .replace("const localRaw = needsLocal ? await MemorySuiteStorageBridge.ownerLegacyRead('plugin', storageKey) : null;",
      "const localRaw = needsLocal ? await MemorySuiteStorageBridge.ownerLegacyRead('plugin', storageKey) : null;await globalThis.risuai.settledAdmissionFixture('actual-local-sample',{storageKey,localRaw});")
    .replace("const retryUnifiedEmbedding = async (context,manifest,ref,memory,force=false) => {",
      "const retryUnifiedEmbedding = async (context,manifest,ref,memory,force=false) => {globalThis.risuai.settledAdmissionFixture('derived-vector-start',{key:ref.key,embedding:memory.embedding});")
    .replace("const latest=await check(),next={...clone(memory),embedding};",
      "const latest=await check(),next={...clone(memory),embedding};globalThis.risuai.settledAdmissionFixture('derived-vector-before-body-save',{key:ref.key,embedding});")
    .replace("const next={...working,embedding},nextManifest=clone(latest),currentRef=nextManifest.memories[String(memory.turnRange.start)];",
      "const next={...working,embedding},nextManifest=clone(latest),currentRef=nextManifest.memories[String(memory.turnRange.start)];await globalThis.risuai.settledAdmissionFixture('derived-vector-before-body-save',{key:ref.key,embedding,readSet});")
    .replace("Object.assign(ref,clone(latest.memories[String(memory.turnRange.start)]));manifest.memories[String(memory.turnRange.start)]=clone(ref);manifest.stats=clone(latest.stats);\n        return clone(next);",
      "Object.assign(ref,clone(latest.memories[String(memory.turnRange.start)]));manifest.memories[String(memory.turnRange.start)]=clone(ref);manifest.stats=clone(latest.stats);globalThis.risuai.settledAdmissionFixture('derived-vector-settled',{key:ref.key,embedding:next.embedding});\n        return clone(next);")
    .replace("const assertConsumedDataCurrent = async (token, options = {}) => {\n      const entry = consumedDataReadSets.get(string(token));",
      "const assertConsumedDataCurrent = async (token, options = {}) => {\n      const entry = consumedDataReadSets.get(string(token));globalThis.risuai.settledAdmissionFixture('consumed-data-readset',{token,entry});")
    .replace("const recalled=await recall(context,query,guard);","const recalled=await recall(context,query,guard);await globalThis.risuai.settledAdmissionFixture('refresh-hydrated');")
    .replace("await assertSettledSourceEditReadback(context,admitted.readback,guard);","await assertSettledSourceEditReadback(context,admitted.readback,guard);await globalThis.risuai.settledAdmissionFixture('after-final-body-proof');")
    .replace("const current=await assertSettledSourceEditRequest(settledSourceEditRequest,responseBoundary,guard);","const current=await getLiveApi(['settledAdmissionFinalAuthority']).settledAdmissionFinalAuthority(()=>assertSettledSourceEditRequest(settledSourceEditRequest,responseBoundary,guard));")
    .replace("warn('LIBRA settled source-edit request remains suppressed',error);","globalThis.risuai.settledAdmissionFixture('refresh-refused',String(error?.message||error));warn('LIBRA settled source-edit request remains suppressed',error);")
    .replace(settlement,"await assertCurrent();\n        await globalThis.risuai.settledAdmissionFixture('task-held');\n        task.state='applied';task.forceRebuild=false;")
    .replace(receiptDispatch,"await getLiveApi(['settledAdmissionReceipt']).settledAdmissionReceipt();\n        "+receiptDispatch);
};
const caseNames=['same_task','source_changed','scope_changed','provider_changed','new_request','corrupt_body','missing_body','exception_changed','policy_changed','mode_changed','data_binding_changed','missing_receipt','body_changed_after_hydration','body_changed_after_final_readback','handoff_budget_spent','manifest_scope_after_authority','derived_metadata_overlap'];
async function boundaryCase(name){
  const settlement=deferred(),read=deferred(),finalRead=deferred();
  const vectorSave=deferred(),vectorFinish=deferred();
  const vectorOverlap=name==='derived_metadata_overlap'||process.env.LIBRA_ADMISSION_VECTOR_OVERLAP==='1';
  let vectorSaveHeld=false,vectorSampleHeld=false,vectorSettled=false;
  const events=[],physicalEvidence=[];let armed=false,held=false,receiptStarted=false,originalStarted=0,taskHeld=false;
  const capturePhysical = phase => {
    const rows=snapshot.storedRows();
    const manifestKey=[...snapshot.local.keys()].find(key=>key.endsWith(':manifest'));
    const localManifest=manifestKey?parse(snapshot.local.get(manifestKey)):null;
    const serverManifest=snapshot.getManifest();
    const bodyKeys=[...new Set([localManifest?.memories?.['1']?.key,serverManifest?.memories?.['1']?.key].filter(Boolean))];
    physicalEvidence.push({phase,at:Date.now(),task:JSON.parse(JSON.stringify(f.r.api.getSourceEditSyncStatus().tasks.find(t=>t.start===1)||null)),
      manifestKey,localManifest,serverManifest,bodies:bodyKeys.map(key=>({key,localRaw:snapshot.local.get(key),serverRaw:rows.find(row=>row.key===key)?.raw}))});
  };
  let finalReadHeld=false,finalReadSettled=false,finalGetterArmed=false;
  const options={mode:'mirror',transformSource:transform,host:{settledAdmissionReceipt:async operation=>{
    if(armed&&!held){receiptStarted=true;held=true;events.push({phase:'real-receipt-read-dispatch-held',at:Date.now()});await read.promise;}
    return operation?.();
  },settledAdmissionFinalAuthority:async operation=>{
    if(armed&&name==='handoff_budget_spent')finalGetterArmed=true;
    try{
      const value=await operation();
      if(armed&&name==='manifest_scope_after_authority'){
        const manifestKey=[...snapshot.local.keys()].find(key=>key.endsWith(':manifest'));
        assert.ok(manifestKey);
        await setDurable(snapshot,'mirror',manifestKey,{...snapshot.getManifest(),scopeKey:'known-other-physical-scope'});
        assert.equal(snapshot.getManifest().scopeKey,'known-other-physical-scope');
        assert.equal(JSON.parse(snapshot.local.get(manifestKey)).scopeKey,'known-other-physical-scope');
        events.push({phase:'actual-mirror-manifest-scope-mutated-after-final-authority',at:Date.now(),bothCopiesAgree:true});
        capturePhysical('after-final-authority-manifest-mutation');
      }
      return value;
    }finally{finalReadSettled=true;events.push({phase:'final-authority-settled',at:Date.now()});}
  },settledAdmissionFixture:(phase,detail)=>{
    if(!armed)return;
    if(phase==='actual-local-sample'){
      if(vectorOverlap&&taskAtRead&&detail.storageKey===ref.key&&!vectorSampleHeld&&!vectorSettled){
        vectorSampleHeld=true;events.push({phase:'actual-local-sample-held-across-derived-publication',at:Date.now(),detail});
        vectorSave.resolve();return vectorFinish.promise;
      }
      return;
    }
    events.push({phase,at:Date.now(),...(detail?{detail}:{})});
    if(['refresh-attempt','refresh-hydrated','after-final-body-proof','refresh-refused','verified-storage-sample-mismatch','derived-vector-before-body-save'].includes(phase))capturePhysical(phase);
    if(phase==='task-held'){taskHeld=true;return settlement.promise;}
    if(phase==='derived-vector-before-body-save'&&vectorOverlap){vectorSaveHeld=true;return vectorSave.promise;}
    if(phase==='derived-vector-settled'){vectorSettled=true;vectorFinish.resolve();}
    if(phase==='refresh-hydrated'&&name==='body_changed_after_hydration'){
      return setDurable(snapshot,'mirror',ref.key,{...snapshot.getMemory(),sourceDigest:'late-corrupt'}).then(()=>{
        assert.equal(snapshot.getMemory().sourceDigest,'late-corrupt');
        assert.equal(parse(snapshot.local.get(ref.key)).sourceDigest,'late-corrupt');
        events.push({phase:'actual-body-mutated-after-hydration',at:Date.now(),bothCopiesAgree:true});capturePhysical('actual-body-mutated-after-hydration');
      });
    }
    if(phase==='after-final-body-proof'&&name==='body_changed_after_final_readback'){
      return setDurable(snapshot,'mirror',ref.key,{...snapshot.getMemory(),sourceDigest:'corrupt-after-proof'}).then(()=>{
        assert.equal(snapshot.getMemory().sourceDigest,'corrupt-after-proof');
        assert.equal(parse(snapshot.local.get(ref.key)).sourceDigest,'corrupt-after-proof');
        events.push({phase:'actual-body-mutated-after-final-proof',at:Date.now(),bothCopiesAgree:true});capturePhysical('actual-body-mutated-after-final-proof');
      });
    }
  }}};
  const snapshot=await serverFixture(options);const f=snapshot.f;
  const originalSetItem=snapshot.backend.setItem;
  snapshot.backend.setItem=async(key,value)=>{
    const result=await originalSetItem(key,value);
    if(armed&&(key.endsWith(':manifest')||key.includes(':memory:'))){
      events.push({phase:'actual-device-write-completed',at:Date.now(),key,value});
    }
    return result;
  };
  snapshot.hooks.beforeBatch=body=>{
    if(armed){events.push({phase:'actual-server-batch-dispatch',at:Date.now(),body});capturePhysical('actual-server-batch-dispatch');}
  };
  snapshot.hooks.afterBatch=body=>{
    if(armed){events.push({phase:'actual-server-batch-returned',at:Date.now(),body});capturePhysical('actual-server-batch-returned');}
  };
  if(name==='handoff_budget_spent'){
    const api=f.r.context.risuai,originalGetter=api.getLocalPluginStorage;
    api.getLocalPluginStorage=async(...args)=>{
      if(armed&&finalGetterArmed&&!finalReadHeld){
        finalReadHeld=true;events.push({phase:'actual-device-getter-held',at:Date.now()});await finalRead.promise;
      }
      return originalGetter.apply(api,args);
    };
  }
  let request,after,ref,taskAtRead,oldBytes,oldRef;
  try{
    await f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});
    assert.equal((await f.run()).completed,1,'initial canonical commits');
    const initialLogicalBody={...snapshot.getMemory()};delete initialLogicalBody.embedding;
    capturePhysical('initial-canonical-before-derived-drain');
    const initialDrain=await f.r.api.retryPendingUnifiedVectors();
    capturePhysical('initial-canonical-after-derived-drain');
    const initialDrainedBody={...snapshot.getMemory()};delete initialDrainedBody.embedding;
    assert.deepEqual(initialDrainedBody,initialLogicalBody,'initial owner drain preserves complete logical canonical body');
    oldRef=snapshot.getManifest().memories['1'];oldBytes=rawOf(snapshot,'mirror',oldRef.key);
    assert.equal(snapshot.local.get(oldRef.key),oldBytes,'initial byte baseline is taken after both real mirror copies settle');
    injection(await f.control.hooks.beforeRequest([{role:'user',content:QUERY}],'model'));
    const modelCallsBefore=f.control.calls.length;
    f.chat.message[9].data=EDITED_SOURCE;f.control.artifact=editedArtifact();armed=true;
    originalStarted=Date.now();
    request=f.control.hooks.beforeRequest([{role:'user',content:QUERY}],'model');
    await waitFor(()=>taskHeld,'real task settlement');
    await waitFor(()=>held,'same request real receipt read dispatch');
    assert.ok(Date.now()-originalStarted>=10000,'real existing ten-second preparation window expired');
    assert.equal(f.r.api.getSourceEditSyncStatus().tasks.find(t=>t.start===1)?.state,'running','task genuinely still running at captured pending projection');
    settlement.resolve();
    await waitFor(()=>f.r.api.getSourceEditSyncStatus().tasks.find(t=>t.start===1)?.state==='applied','real applied receipt');
    // APPLIED certifies the canonical replacement, while its ordinary queued
    // vector metadata write may still be in flight. Drain the real owner queue
    // before this fixture perturbs final authority; never fabricate a receipt
    // or repair a copy directly, and retain every production deadline.
    const beforeDerivedBody={...snapshot.getMemory()};delete beforeDerivedBody.embedding;
    capturePhysical('before-public-derived-owner-drain');
    if(name!=='derived_metadata_overlap'){
      vectorSave.resolve();
      const derivedDrain=await f.r.api.retryPendingUnifiedVectors();
      events.push({phase:'public-derived-owner-drain-returned',at:Date.now(),detail:derivedDrain});
    }
    capturePhysical('after-public-derived-owner-drain');
    const afterDerivedBody={...snapshot.getMemory()};delete afterDerivedBody.embedding;
    assert.deepEqual(afterDerivedBody,beforeDerivedBody,'owner drain changes only derived embedding metadata');
    taskAtRead=JSON.parse(JSON.stringify(f.r.api.getSourceEditSyncStatus().tasks.find(t=>t.start===1)));
    ref=snapshot.getManifest().memories['1'];
    assert.equal(taskAtRead.result.ok,true);assert.equal(taskAtRead.result.revision,ref.revision);
    assert.ok(ref.revision>oldRef.revision);
    const physical=snapshot.getMemory();
    assert.equal(physical.memoryId,ref.memoryId);assert.equal(physical.revision,ref.revision);
    assert.equal(physical.sourceDigest,ref.sourceDigest);assert.equal(physical.artifactDigest,ref.artifactDigest);
    assert.equal(snapshot.local.get(ref.key),rawOf(snapshot,'mirror',ref.key),'both actual mirror bodies agree before perturbation');
    if(name==='source_changed')f.chat.message[9].data+=' Additional concurrent source edit.';
    if(name==='scope_changed'){f.chat.id='different-chat';f.chat.chatId='different-chat';}
    if(name==='provider_changed')f.r.context.risuai.pluginStorage={...snapshot.backend,getItem:async()=>null};
    if(name==='policy_changed')await f.r.api.saveLibraMemorySettings({...await f.r.api.getLibraMemorySettings(),recallMaxMemories:2});
    if(name==='exception_changed')await f.r.context.__settledAdmissionEdits.setException(snapshot.getManifest().scopeKey,'1',taskAtRead.revisionId,true);
    if(name==='mode_changed')await f.r.context.__settledAdmissionStorage.setMode('server_only');
    if(name==='missing_receipt')f.r.context.__settledAdmissionEdits.taskFor(snapshot.getManifest().scopeKey,'1').result=null;
    if(name==='data_binding_changed'){
      // Keep the actual SQLite values and provider unchanged, but return a
      // different DATA identity on the real loopback wire. The certified SDK
      // must refuse it rather than read from a freshly adopted authority.
      const listeners=snapshot.app.server.listeners('request');assert.equal(listeners.length,1);
      snapshot.app.server.removeListener('request',listeners[0]);
      snapshot.app.server.on('request',(req,res)=>{
        const end=res.end;
        res.end=function(chunk,...args){
          try{const body=JSON.parse(String(chunk));if(body.dataInstanceId){body.dataInstanceId='f'.repeat(body.dataInstanceId.length);chunk=JSON.stringify(body);}}catch{}
          return end.call(this,chunk,...args);
        };
        return listeners[0](req,res);
      });
    }
    if(name==='new_request'){
      const next=f.control.hooks.beforeRequest([{role:'user',content:QUERY}],'model');
      await next;
    }
    if(name==='corrupt_body')await setDurable(snapshot,'mirror',ref.key,{...physical,sourceDigest:'corrupt'});
    if(name==='missing_body')await removeDurable(snapshot,'mirror',ref.key);
    assert.equal(events.some(event=>event.phase==='refresh-attempt'),false,'held dispatch cannot time out and start readmission before the controlled authority mutation');
    events.push({phase:'release-real-receipt-read-dispatch',at:Date.now()});read.resolve();
    after=await request;
    const blocks=after.filter(m=>String(m.content||'').includes('[LIBRA CLASSIC RECALL'));
    const text=blocks.map(m=>String(m.content)).join('\n');
    const result={name,elapsedMs:Date.now()-originalStarted,events,vectorOverlap,vectorSaveHeld,vectorSampleHeld,vectorSettled,taskRevisionId:taskAtRead.revisionId,taskReceiptRevision:taskAtRead.result.revision,refRevision:ref.revision,
      appliedBeforeRelease:true,blocks:blocks.length,hasReplacement:text.includes(NEW_FACT),hasOld:text.includes(OLD_FACT),
      oldBytesPreserved:rawOf(snapshot,'mirror',oldRef.key)===oldBytes,modelCalls:f.control.calls.length-modelCallsBefore,
      dataBindingRejected:f.r.context.__settledAdmissionStorage.serverBinding().rejected,
      failureReason:f.r.api.getLastMemoryRecallViewer()?.error||'',
      runtime:f.r.api.getRuntime().lastRecallRuntime||null};
    fs.writeFileSync(path.join(evidenceDir,name+'.json'),JSON.stringify(result,null,2));
    capturePhysical('request-returned');
    fs.writeFileSync(path.join(evidenceDir,name+'-physical-readset-proof.json'),JSON.stringify({name,events,physicalEvidence},null,2));
    if(name==='manifest_scope_after_authority'){
      assert.ok(events.some(e=>e.phase==='actual-mirror-manifest-scope-mutated-after-final-authority'),'fixture reached exact final authority/physical sample boundary');
      assert.match(result.failureReason,/SOURCE_EDIT_MANIFEST_SCOPE_CHANGED/,'exact last-sample semantic scope assertion refused the wrong durable manifest');
    }
    if(name==='body_changed_after_hydration')assert.ok(events.some(event=>event.phase==='actual-body-mutated-after-hydration'),'actual hydration-boundary body mutation was reached in both durable copies');
    if(name==='body_changed_after_final_readback')assert.ok(events.some(event=>event.phase==='actual-body-mutated-after-final-proof'),'actual final-proof body mutation was reached in both durable copies');
    if(name==='derived_metadata_overlap'){
      assert.equal(vectorSaveHeld,true,'actual derived writer waited outside its storage lane');
      assert.equal(vectorSampleHeld,true,'actual local body sample predates the derived publication');
      assert.equal(vectorSettled,true,'real derived transaction and mirror publication completed');
      const mismatch=events.find(event=>event.phase==='verified-storage-sample-mismatch');
      assert.equal(mismatch?.detail.storageKey,ref.key,'the exact real local/server body samples disagree');
      const localBody=parse(mismatch.detail.localRaw),serverBody=parse(mismatch.detail.serverRaw);
      assert.notDeepEqual(localBody.embedding,serverBody.embedding,'the actual independently derived embedding metadata changed');
      delete localBody.embedding;delete serverBody.embedding;
      assert.deepEqual(localBody,serverBody,'complete logical canonical content stayed identical across samples');
      assert.equal(snapshot.local.get(ref.key),rawOf(snapshot,'mirror',ref.key),'both real copies agree after publication; rejection is caused by the mixed sampled revisions');
      assert.ok(events.some(event=>event.phase==='refresh-refused'&&event.detail==='LIBRA_VERIFIED_STORAGE_VALUE_MISMATCH:'+ref.key),'production verified storage refused the exact mixed samples');
    }
    assert.equal(result.oldBytesPreserved,true,'prior canonical bytes remain immutable');
    assert.equal(result.hasOld,false,'previous revision never returns as current evidence');
    assert.equal(result.modelCalls,1,'only the original source-edit Librarian runs; refresh adds no helper/model call');
    const attempts=events.filter(e=>e.phase==='refresh-attempt');
    assert.ok(attempts.length<=1,'at most one request-local refresh');
    if(attempts.length){assert.equal(attempts[0].detail.budgetMs,30000);assert.equal(attempts[0].detail.deadlineAt-attempts[0].detail.startedAt,30000);}
    if(name==='same_task'){
      assert.equal(blocks.length,1,'same first post-edit request receives one Classic block after its exact task really applies');
      assert.equal(result.hasReplacement,true,'first request receives physically read back replacement');
    }else{
      assert.equal(blocks.length,0,name+': refused authority suppresses every Classic block');
      assert.equal(result.hasReplacement,false,name+': changed or missing authority cannot admit replacement');
    }
    if(name==='data_binding_changed')assert.equal(result.dataBindingRejected,true,'certified SDK actually rejected the changed wire DATA identity');
    if(name==='handoff_budget_spent'){
      assert.equal(finalReadHeld,true,'the actual captured device getter was held inside final authority verification');
      assert.ok(result.elapsedMs>=39000&&result.elapsedMs<45000,'unchanged ten-second preparation plus original thirty-second recall guard bounds held read');
      const viewer=JSON.stringify(f.r.api.getLastMemoryRecallViewer()),recallResult=JSON.stringify(f.r.api.getLastMemoryRecall());
      const originalMessages=JSON.stringify(after),calls=f.control.calls.length;
      finalRead.resolve();await waitFor(()=>finalReadSettled,'losing actual authority/getter continuation settled');
      assert.equal(JSON.stringify(f.r.api.getLastMemoryRecallViewer()),viewer,'losing continuation cannot publish a newer recall viewer');
      assert.equal(JSON.stringify(f.r.api.getLastMemoryRecall()),recallResult,'losing continuation cannot publish recall evidence');
      assert.equal(JSON.stringify(after),originalMessages,'losing continuation cannot inject after request return');
      assert.equal(f.control.calls.length,calls,'timeout adds no later model/helper call');
      fs.writeFileSync(path.join(evidenceDir,name+'-losing-continuation.json'),JSON.stringify({finalReadHeld,finalReadSettled,blocks:blocks.length,viewerUnchanged:true,recallUnchanged:true,messagesUnchanged:true,modelCallsUnchanged:true,events},null,2));
    }
  }finally{settlement.resolve();read.resolve();finalRead.resolve();vectorSave.resolve();vectorFinish.resolve();if(request)await request.catch(()=>{});
    fs.writeFileSync(path.join(evidenceDir,name+'-fixture-state.json'),JSON.stringify({events,taskHeld,held,receiptStarted,status:f.r.api.getSourceEditSyncStatus()},null,2));
    await snapshot.cleanup();}
}
(async()=>{
 const chosen=process.env.LIBRA_ADMISSION_CASES?process.env.LIBRA_ADMISSION_CASES.split(','):caseNames;
 for(const name of chosen){assert.ok(caseNames.includes(name));await boundaryCase(name);process.stdout.write('PASS '+name+'\n');}
})().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
