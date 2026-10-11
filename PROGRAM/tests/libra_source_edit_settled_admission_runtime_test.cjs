'use strict';
// Current successor to automatic task settlement: explicitly commit a selected
// replacement, then mutate real authority at the retained request's final checks.
// Instrumentation adds awaited observation seams only; no production decisions,
// receipts, provider budget, deadlines, or body verification are replaced.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {replace,clone}=require('./fixtures/libra_selected_source_contract.cjs');
const QUERY='민아의 은빛 열쇠를 지금 누가 갖고 있어?',OLD='지호가 열쇠를 민아에게 반환했다.',NEW='지호는 은빛 열쇠를 아직 반환하지 않았다.';
const SOURCE='서재에서 지호는 은빛 열쇠를 민아에게 반환하지 않았다. 반환 약속은 아직 남았다. 공연 허가자는 알려지지 않았다.';
const evidence=process.env.LIBRA_ADMISSION_EVIDENCE||fs.mkdtempSync(path.join(os.tmpdir(),'libra-selected-admission-'));fs.mkdirSync(evidence,{recursive:true});
const cases=['same_task','source_changed','scope_changed','provider_changed','new_request','corrupt_body','missing_body','exception_changed','policy_changed','mode_changed','data_binding_changed','missing_receipt','body_changed_after_hydration','body_changed_after_final_readback','handoff_budget_spent','manifest_scope_after_authority','derived_metadata_overlap','derived_metadata_settled','policy_changed_during_body','mode_changed_during_body','settings_write_held'];
const transform=source=>{
 const edits=[
  ['        if(responseBoundary)await assertUnifiedResponseBoundary(responseBoundary);\n        // All routes, including Classic',"        await globalThis.risuai.selectedAdmissionSeam('after_hydration');\n        if(responseBoundary)await assertUnifiedResponseBoundary(responseBoundary);\n        // All routes, including Classic"],
  ["        assertConsumedDataIdentity(evidencePacket.consumed_data_token, 'packet', consumedPacketIdentityDigest(evidencePacket));", "        await globalThis.risuai.selectedAdmissionSeam('after_authority');\n        assertConsumedDataIdentity(evidencePacket.consumed_data_token, 'packet', consumedPacketIdentityDigest(evidencePacket));"],
  ["        const localRaw = needsLocal ? await MemorySuiteStorageBridge.ownerLegacyRead('plugin', storageKey) : null;", "        const localRaw = needsLocal ? await MemorySuiteStorageBridge.ownerLegacyRead('plugin', storageKey) : null;\n        await globalThis.risuai.selectedAdmissionSeam('actual_local_sample',{storageKey,localRaw});"],
  ['\n  const publicApi = Object.freeze({','\n  globalThis.__SELECTED_ADMISSION_STORAGE__=MemorySuiteStorageBridge;\n  const publicApi = Object.freeze({']
 ];
 for(const [before,after]of edits){assert.equal(source.split(before).length,2,'unique current observation seam');source=source.replace(before,after);}return source;
};
const block=messages=>messages.filter(row=>String(row.content||'').includes('[LIBRA CLASSIC RECALL')).map(row=>row.content).join('\n');
const summary=[];
(async()=>{
 let armed='',events=[],hit=false,activeRef,baselineBody,baselineManifest,manifestKey,snapshot,newerOutput,newerViewer,releaseRead,readSettled=false;
 const changedKeys=new Set(),originalListeners=[];
 const durable=async(key,value)=>{changedKeys.add(key);if(value===null){snapshot.local.delete(key);await snapshot.mutate(key,null,'remove');}else{snapshot.local.set(key,JSON.stringify(value));await snapshot.mutate(key,value);}};
 const options={mode:'mirror',transformSource:transform,host:{selectedAdmissionSeam:async(phase,detail={})=>{
  if(!armed)return;
  const late=['body_changed_after_final_readback','manifest_scope_after_authority'].includes(armed);
  if(phase==='actual_local_sample'){
   if(!hit||detail.storageKey!==activeRef.key||detail.localRaw==null)return;
   if(['policy_changed_during_body','mode_changed_during_body','settings_write_held'].includes(armed)){
    const name=armed;armed='';
    if(name==='mode_changed_during_body'){await snapshot.f.r.context.__SELECTED_ADMISSION_STORAGE__.setMode('server_only');events.push({phase:'mode_changed_during_physical_body'});}
    else {const f=snapshot.f,before=await f.r.api.getLibraMemorySettings();
     if(name==='settings_write_held'){const original=snapshot.backend.setItem;snapshot.backend.setItem=async(key,value)=>{snapshot.backend.setItem=original;events.push({phase:'actual_settings_write_held'});await new Promise(resolve=>{releaseRead=resolve;});readSettled=true;return original(key,value);};snapshot.heldWrite=f.r.api.saveLibraMemorySettings({...before,performancePreset:'custom',recallMaxMemories:before.recallMaxMemories===2?3:2});}
     else{await f.r.api.saveLibraMemorySettings({...before,performancePreset:'custom',recallMaxMemories:before.recallMaxMemories===2?3:2});events.push({phase:'policy_changed_during_physical_body'});}
    }
   }
   if(armed==='derived_metadata_overlap'){
    armed='';const next=clone(baselineBody);next.embedding={...next.embedding,probe:'independently-published-derived-metadata'};await durable(activeRef.key,next);
    const sampled=JSON.parse(detail.localRaw);assert.notDeepEqual(sampled.embedding,next.embedding);delete sampled.embedding;const logical=clone(next);delete logical.embedding;assert.deepEqual(sampled,logical,'mixed samples differ only in derived embedding metadata');events.push({phase:'mixed_actual_physical_samples',storageKey:detail.storageKey});
   }
   if(armed==='handoff_budget_spent'){
    armed='';events.push({phase:'actual_physical_getter_held'});await new Promise(resolve=>{releaseRead=resolve;});readSettled=true;events.push({phase:'losing_physical_getter_returned'});
   }
   return;
  }
  if(hit||phase!==(late?'after_authority':'after_hydration'))return;
  hit=true;events.push({phase,case:armed});const f=snapshot.f;
  if(armed==='source_changed')f.chat.message[9].data+=' New source edit after hydration.';
  if(armed==='scope_changed'){f.chat.id='foreign-chat';f.chat.chatId='foreign-chat';}
  if(armed==='exception_changed')f.chat.message.splice(0,2); // explicit source deletion replaces retired exception suppression
  if(armed==='provider_changed'){const other={...snapshot.backend,getItem:async()=>null};f.r.context.risuai.pluginStorage=other;f.r.context.risuai.getLocalPluginStorage=async()=>other;}
  if(armed==='new_request'){
   armed='';newerOutput=await f.control.hooks.beforeRequest([{role:'user',content:QUERY+' 새 요청'}],'model');newerViewer=JSON.stringify(f.r.api.getLastMemoryRecallViewer());assert.ok(block(newerOutput).includes(NEW),'newer request is a positive delivery control');
  }
  if(['corrupt_body','body_changed_after_hydration','body_changed_after_final_readback'].includes(armed))await durable(activeRef.key,{...clone(baselineBody),sourceDigest:'corrupt-after-hydration'});
  if(armed==='derived_metadata_settled')await durable(activeRef.key,{...clone(baselineBody),embedding:{...baselineBody.embedding,probe:'settled-derived-metadata'}});
  if(armed==='missing_body')await durable(activeRef.key,null);
  if(armed==='missing_receipt'){const changed=clone(baselineBody);delete changed.sourceEvidenceRef;await durable(activeRef.key,changed);}
  if(armed==='manifest_scope_after_authority')await durable(manifestKey,{...clone(baselineManifest),scopeKey:'foreign-scope'});
  if(armed==='policy_changed'){const before=await f.r.api.getLibraMemorySettings();await f.r.api.saveLibraMemorySettings({...before,performancePreset:'custom',recallMaxMemories:before.recallMaxMemories===2?3:2});const after=await f.r.api.getLibraMemorySettings();assert.notEqual(after.recallMaxMemories,before.recallMaxMemories,'real public recall policy changed');events.push({phase:'actual_policy_changed',before:before.recallMaxMemories,after:after.recallMaxMemories});}
  if(armed==='mode_changed'){const bridge=f.r.context.__SELECTED_ADMISSION_STORAGE__,before=await bridge.getScopeMode();assert.equal(before.mode,'mirror');await bridge.setMode('server_only');const after=await bridge.getScopeMode();assert.equal(after.mode,'server_only');events.push({phase:'actual_mode_changed',before:before.mode,after:after.mode});}
  if(armed==='data_binding_changed'){
   const listeners=snapshot.app.server.listeners('request');assert.equal(listeners.length,1);originalListeners.push(listeners[0]);snapshot.app.server.removeListener('request',listeners[0]);snapshot.app.server.on('request',(req,res)=>{const end=res.end;res.end=function(chunk,...args){try{const body=JSON.parse(String(chunk));if(body.dataInstanceId){body.dataInstanceId='f'.repeat(body.dataInstanceId.length);chunk=JSON.stringify(body);}}catch{}return end.call(this,chunk,...args);};return listeners[0](req,res);});
  }
 }}};
 snapshot=await serverFixture(options);
 try{
  const f=snapshot.f;await f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});
  assert.equal((await f.run()).completed,1);await f.r.api.retryPendingUnifiedVectors();const oldRef=clone(snapshot.getManifest().memories['1']),oldBytes=snapshot.storedRows().find(row=>row.key===oldRef.key).raw;
  f.chat.message[9].data=SOURCE;const next=artifact();for(const row of [...next.entities,...next.facts])for(const span of row.evidenceSpans)if(span.ref==='t5-a')span.quote=SOURCE;next.facts.find(row=>row.tempFactId==='f11').text=NEW;next.facts.find(row=>row.tempFactId==='f11').values.holderRef='jiho';next.facts.find(row=>row.tempFactId==='f12').values.thread.status='open';f.control.artifact=next;
  await replace(f);assert.equal(f.control.calls.length,2,'initial canonical and one selected replacement are the only paid calls');
  baselineManifest=clone(snapshot.getManifest());activeRef=clone(baselineManifest.memories['1']);baselineBody=clone(snapshot.getMemory());manifestKey=snapshot.storedRows().find(row=>row.key.endsWith(':manifest')).key;
  assert.ok(activeRef.revision>oldRef.revision);assert.equal(snapshot.local.get(activeRef.key),snapshot.storedRows().find(row=>row.key===activeRef.key).raw,'actual mirror copies agree');
  assert.ok(block(await f.control.hooks.beforeRequest([{role:'user',content:QUERY}],'model')).includes(NEW),'ungated current replacement injects');
  options.snapshot={chat:clone(f.chat)};const localBaseline=new Map(snapshot.local),storedBaseline=new Map(snapshot.storedRows().map(row=>[row.key,clone(row.value)]));
  const chosen=process.env.LIBRA_ADMISSION_CASES?process.env.LIBRA_ADMISSION_CASES.split(','):cases;
  for(const name of chosen){assert.ok(cases.includes(name));
   armed='';events=[];hit=false;newerOutput=null;newerViewer=null;readSettled=false;releaseRead=null;changedKeys.clear();
   await snapshot.restart();const current=snapshot.f;await current.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});
   assert.equal((await current.r.context.__SELECTED_ADMISSION_STORAGE__.getScopeMode()).mode,'mirror','each physical overlap starts from original mirror authority');
   const calls=current.control.calls.length;armed=name;const started=Date.now();let output;
   try{
    output=await current.control.hooks.beforeRequest([{role:'user',content:QUERY}],'model');
    const viewer=current.r.api.getLastMemoryRecallViewer(),text=block(output),result={name,hit,events,blocks:text?1:0,hasReplacement:text.includes(NEW),hasOld:text.includes(OLD),failure:viewer?.error||'',elapsedMs:Date.now()-started,calls:current.control.calls.length-calls};
    fs.writeFileSync(path.join(evidence,name+'.json'),JSON.stringify(result,null,2));summary.push(result);
    assert.equal(hit,true,name+': exact current delivery seam reached');assert.equal(result.calls,0,'admission adds no paid model work');assert.equal(result.hasOld,false,'prior revision never becomes replacement evidence');
    if(['same_task','derived_metadata_settled'].includes(name)){assert.equal(result.hasReplacement,true);assert.equal((await current.r.api.validateResponseContext(current.r.api.getLastResponseContext())).ok,true);}
    else{assert.equal(result.blocks,0,name+': changed, missing or unsettled authority suppresses every Classic block');}
    assert.equal(snapshot.storedRows().find(row=>row.key===oldRef.key).raw,oldBytes,'prior canonical bytes stay immutable');
    if(name==='new_request')assert.equal(JSON.stringify(current.r.api.getLastMemoryRecallViewer()),newerViewer,'older continuation cannot overwrite newer diagnostics');
    if(name==='data_binding_changed')assert.equal(current.r.context.__SELECTED_ADMISSION_STORAGE__.serverBinding().rejected,true,'real SDK rejects changed wire DATA identity');
    if(name==='derived_metadata_overlap')assert.ok(events.some(e=>e.phase==='mixed_actual_physical_samples'),'real local/server sample overlap reached');
    if(['handoff_budget_spent','settings_write_held'].includes(name)){
     assert.ok(events.some(e=>['actual_physical_getter_held','actual_settings_write_held'].includes(e.phase)));assert.ok(result.elapsedMs>=1400&&result.elapsedMs<8000,'existing 1.5s final revalidation bound is retained');
     const stableViewer=JSON.stringify(viewer),stableOutput=JSON.stringify(output);releaseRead();if(snapshot.heldWrite){await snapshot.heldWrite;snapshot.heldWrite=null;}for(let i=0;i<100&&!readSettled;i++)await new Promise(r=>setTimeout(r,10));assert.equal(readSettled,true);
     assert.equal(JSON.stringify(current.r.api.getLastMemoryRecallViewer()),stableViewer);assert.equal(JSON.stringify(output),stableOutput);assert.equal(current.control.calls.length,calls,'losing read cannot publish or spend');
    }
    console.log('PASS '+name);
   }finally{
    armed='';releaseRead?.();if(snapshot.heldWrite){await snapshot.heldWrite;snapshot.heldWrite=null;}
    if(originalListeners.length){snapshot.app.server.removeAllListeners('request');snapshot.app.server.on('request',originalListeners.pop());}
    const currentRows=new Map(snapshot.storedRows().map(row=>[row.key,row.value]));
    for(const key of new Set([...storedBaseline.keys(),...currentRows.keys()])){if(JSON.stringify(currentRows.get(key))!==JSON.stringify(storedBaseline.get(key)))await snapshot.mutate(key,storedBaseline.get(key)??null,storedBaseline.has(key)?'set':'remove');}
    snapshot.local.clear();for(const [key,value]of localBaseline)snapshot.local.set(key,value);
   }
  }
 }finally{armed='';releaseRead?.();fs.writeFileSync(path.join(evidence,'summary.json'),JSON.stringify({summary,evidence},null,2));await snapshot.cleanup();}
 const lazyProof=await require('./fixtures/libra_lazy_canonical_proof.cjs').verifyLazyCanonicalProof();
 const publication=await require('./fixtures/libra_selected_publication_owner.cjs').verifyPublicationOwner();
 const closure=await require('./fixtures/libra_selected_closure_readset.cjs').verifyClosureReadset();
 const archive=await require('./fixtures/libra_selected_archive_successor.cjs').verifyArchiveRecall();
 console.log(JSON.stringify({test:'libra_source_edit_settled_admission_runtime',passed:summary.length,archive,closure,publication,lazyProof,evidence}));
})().catch(e=>{console.error(e);process.exitCode=1;});
