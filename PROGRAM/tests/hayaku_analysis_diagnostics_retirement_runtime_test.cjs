'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createColdStartGuiDocument}=require('./fixtures/hayaku_cold_start_gui_dom_fixture.cjs');
const msg=(role,id,data)=>({role,id,chatId:id,data});
const summary='Alice opened the cedar chest and found a blue ribbon.';
const messages=()=>[msg('user','u1','Enter.'),msg('assistant','a1',hiddenPacketMessage('Alice entered.',createValidPacket({turn:1}))),msg('user','u2','Open the chest.'),msg('assistant','a2',summary)];
const failureKeys=r=>[...r.pluginStorage.values.keys()].filter(k=>/^hayaku\.v2\.failed_analysis_/.test(k));
const good=()=>{
 const packet=createValidPacket({turn:2,subject:'Alice',summary});packet.entity.characters=[{name:'Alice'}];packet.planner.continuity_locks=[summary];
 const grounding=[];for(const axis of ['entity','world','narrative','planner'])for(const[k,v]of Object.entries(packet[axis]))if(Array.isArray(v))v.forEach((_,i)=>grounding.push({path:`${axis}.${k}[${i}]`,source:'target',evidence:[summary]}));
 grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[summary]});return{schema:'hayaku.native_repair_output.v1',packet,grounding};
};
(async()=>{
 const normal=await createHayakuRuntime({autoRepair:false,messages:messages(),llmResponder:async()=>({type:'success',result:'PRIVATE_FAILED_RAW_SENTINEL'})});
 try{
  const first=await normal.hayaku.recovery.repairNow();assert.equal(first.ok,false);assert.equal(normal.llmCalls.length,1);
  assert.deepEqual(failureKeys(normal),[],'default analysis failure writes no detailed diagnostic archive');
  const summaries=await normal.hayaku.recovery.failedAnalysis.summaries();assert.equal(summaries.length,1);assert.equal(summaries[0].turn,2);assert.equal(summaries[0].physicalCalls,1);
  assert(!JSON.stringify(summaries).includes('PRIVATE_FAILED_RAW_SENTINEL'));assert(!JSON.stringify(summaries).includes(summary));
  const scope=await normal.hayaku._test.currentChatScope();
  await normal.pluginStorage.setItem('hayaku.v2.failed_analysis_index.'+scope.key,'damaged legacy diagnostic index');
  const originalGet=normal.pluginStorage.getItem.bind(normal.pluginStorage);let reads=0;
  normal.pluginStorage.getItem=async key=>{if(String(key).includes('failed_analysis_')){reads++;throw Error('legacy_index_unavailable');}return originalGet(key);};
  const status=await normal.hayaku.recovery.status({includeDebts:true,refreshDebts:true});assert(status.debt.coverage.repairableTurns.includes(2));
  const exported=await normal.hayaku.activityLog.snapshot();assert.equal(exported.analysisDiagnostics.detailsIncluded,false);assert(!JSON.stringify(exported).includes('PRIVATE_FAILED_RAW_SENTINEL'));
  normal.setLlmResponder(async call=>{assert(!JSON.stringify(call.messages).includes('PRIVATE_FAILED_RAW_SENTINEL'));return{type:'success',result:JSON.stringify(good())};});
  const second=await normal.hayaku.recovery.repairSelected({targetTurns:[2],scopeKey:scope.key});assert.equal(second.ok,true,JSON.stringify(second));assert.equal(normal.llmCalls.length,2);assert.equal(reads,0);
  const ledger=await normal.hayaku.ledger.inspect({includeRecords:true});assert(ledger.records.some(row=>row.captureSource==='bridge_incremental_recovery'&&row.recordState==='active'));
  for(let i=0;i<60;i++)await normal.hayaku._test.saveFailedAnalysisArtifact({scopeKey:scope.key,chunk:{turn:2},failure:{code:'BOUNDED_FIXTURE',message:'failure-'+i}});
  assert.equal((await normal.hayaku.recovery.failedAnalysis.summaries()).length,50);assert.equal(reads,0);assert.equal(normal.llmCalls.length,2);
  console.log('PASS default summary-only diagnostics, unavailable legacy index, fresh-source recovery and durable ledger');
 }finally{await normal.dispose();}

 const candidate=good();for(const axis of ['entity','world','narrative','planner'])for(const[k,v]of Object.entries(candidate.packet[axis]))if(Array.isArray(v))candidate.packet[axis][k]=[];
 candidate.packet.entity.characters=[{name:'Alice'}];candidate.packet.meta.summary_memory={summary};candidate.grounding=[{path:'entity.characters[0]',source:'target',evidence:[summary]},{path:'meta.summary_memory.summary',source:'target',evidence:[summary]}];
 for(const debug of [false,true]){
  const r=await createHayakuRuntime({autoRepair:false,arguments:{hayaku_debug:String(debug)},messages:messages(),llmResponder:async()=>({type:'success',result:JSON.stringify({answer:candidate})})});
  try{
   const scope=await r.hayaku._test.currentChatScope();await r.pluginStorage.setItem('hayaku.v2.failed_analysis_index.'+scope.key,'unreadable legacy index');
   const out=await r.hayaku.recovery.repairNow();assert.equal(out.partialMemory?.saved,true,JSON.stringify(out));assert.equal(out.partialMemory.durable,true);
   const recalled=await r.hayaku._test.searchAcceptedPartialMemory(scope,'Alice');assert(JSON.stringify(recalled).includes('Alice'));assert.equal(r.llmCalls.length,1);
   // Independently admitted producer identities share this source and store. Parallel
   // capture completions must merge their records even while diagnostic storage fails.
   const makePartial=id=>({scopeKey:scope.key,source:{turn:2,text:'[Turn 2]\n[User attempt]\nOpen the chest.\n\n[Assistant outcome]\n'+summary},proposedCanonical:{...candidate.packet,meta:{...candidate.packet.meta,record_admission:firstAdmission(out)},entity:{...candidate.packet.entity,characters:[{name:'Alice',id}]}}});
   const partialKey='hayaku.v2.partial_memory.'+scope.key;await r.pluginStorage.removeItem(partialKey);
   const get=r.pluginStorage.getItem.bind(r.pluginStorage);
   r.pluginStorage.getItem=async key=>{const value=await get(key);if(key===partialKey)await new Promise(resolve=>setTimeout(resolve,5));return value;};
   const merged=await Promise.all(['producer-a','producer-b'].map(id=>r.hayaku._test.saveAcceptedPartialMemory(makePartial(id))));assert(merged.every(row=>row.durable));
   const records=JSON.parse(await get(partialKey)).records;assert.deepEqual(records[0].atoms.map(row=>row.value.id).sort(),['producer-a','producer-b']);
   console.log('PASS partial memory stays durable and searchable despite diagnostic failure, debug='+debug);
  }finally{await r.dispose();}
 }

 const details=await createHayakuRuntime({arguments:{hayaku_debug:'true'},autoRepair:false,messages:messages()});
 try{
  const scope=await details.hayaku._test.currentChatScope();
  const save=(n,chars=10)=>details.hayaku._test.saveFailedAnalysisArtifact({scopeKey:scope.key,createdAt:1000+n,kind:'incremental_recovery',flow:'retention_fixture',chunk:{turn:2},attempts:[{mode:'primary',rawResponse:'DETAIL_SENTINEL_'+n+'x'.repeat(chars)}],failure:{code:'FIXTURE',message:'fixture-'+n}});
  const first=await save(0);assert.equal(first.durable,true);const raw=await details.hayaku.recovery.failedAnalysis.read(first.failureId);assert.equal(raw.durable,true);assert(raw.payload.attempts[0].rawResponse.includes('DETAIL_SENTINEL_0'));
  const defaults=await details.hayaku.activityLog.snapshot();assert.equal(defaults.analysisDiagnostics.artifacts.length,0);assert(!JSON.stringify(defaults).includes('DETAIL_SENTINEL_0'));
  const full=await details.hayaku.activityLog.snapshot({includeAnalysisDetails:true});assert.equal(full.analysisDiagnostics.artifacts.length,1);assert(JSON.stringify(full.analysisDiagnostics).includes('DETAIL_SENTINEL_0'));assert.equal(details.llmCalls.length,0);
  // A historical untagged row is preserved when the new debug ring is pruned.
  const manifest=JSON.parse(await details.pluginStorage.getItem(raw.manifestKey));manifest.retention='';await details.pluginStorage.setItem(raw.manifestKey,JSON.stringify(manifest));
  const indexKey='hayaku.v2.failed_analysis_index.'+scope.key,index=JSON.parse(await details.pluginStorage.getItem(indexKey));index.entries[0].retention='';await details.pluginStorage.setItem(indexKey,JSON.stringify(index));
  for(let i=1;i<=12;i++)assert.equal((await save(i)).durable,true);
  let list=await details.hayaku.recovery.failedAnalysis.list();assert.equal(list.entries.filter(x=>x.retention==='debug_recent_v1').length,10);assert(list.entries.some(x=>x.failureId===first.failureId));
  for(let i=13;i<21;i++)assert.equal((await save(i,150000)).durable,true);
  list=await details.hayaku.recovery.failedAnalysis.list();const retained=list.entries.filter(x=>x.retention==='debug_recent_v1');assert(retained.length<=10);assert(retained.reduce((n,x)=>n+x.payloadChars,0)<=1000000);
  const before=failureKeys(details).sort();const oversized=await save(30,220000);assert.equal(oversized.durable,false);assert.equal(oversized.reason,'analysis_diagnostic_size_limit');assert.deepEqual(failureKeys(details).sort(),before);
  const storedBefore=new Map(details.pluginStorage.values);const remove=details.pluginStorage.removeItem.bind(details.pluginStorage);let interrupted=false;
  details.pluginStorage.removeItem=async key=>{const done=await remove(key);if(!interrupted&&String(key).startsWith('hayaku.v2.failed_analysis_manifest.')){interrupted=true;return false;}return done;};
  const capped=await save(31,180000);assert(interrupted);assert.equal(capped.durable,false);assert.equal(capped.reason,'analysis_diagnostic_retention_unconfirmed');
  assert.deepEqual(details.pluginStorage.values,storedBefore,'uncertain pruning rolls back and does not add another detail');
  console.log('PASS optional detail readback/export, bounded count/size, oversized omission and preserved legacy rows');
 }finally{await details.dispose();}

 const gui=createColdStartGuiDocument();const r=await createHayakuRuntime({autoRepair:false,messages:messages()});
 try{
  Object.assign(r.context,{document:gui.document,window:gui.dom.window,Event:gui.dom.window.Event,HTMLElement:gui.dom.window.HTMLElement,MutationObserver:gui.dom.window.MutationObserver,getComputedStyle:gui.dom.window.getComputedStyle.bind(gui.dom.window)});
  assert.equal(await r.hayaku.showUi(),true);const root=gui.document.getElementById('hayaku-ledger-viewer-root');
  await waitFor(()=>root?.querySelector('.app')&&!root.querySelector('.app').classList.contains('is-busy')&&/세계선 원장 · 기록 [\d,]+개/.test(root.querySelector('#hayakuViewerScopeMeta')?.textContent||''),'GUI ready');
  assert.equal(root.querySelector('[data-recovery-view="failed"]'),null);assert.equal(root.querySelector('[data-recovery-panel="failed"]'),null);
  for(const id of ['autoRepairHayakuFailedAnalysis','adoptHayakuFailedAnalysis','editHayakuFailedAnalysis','saveHayakuFailedAnalysisEdit'])assert.equal(root.querySelector('#'+id),null);
  await root.querySelector('[data-hayaku-viewer-goto="recovery"]').fire('click');assert(root.querySelector('[data-recovery-view="missing"]'));assert(root.querySelector('#runHayakuNativeRepair'));
  const control=root.querySelector('#hayakuIncludeAnalysisDetails');assert.equal(control.checked,false);assert(root.querySelector('#hayakuViewerPanelLogs').contains(control));
  assert(root.querySelector('#hayakuViewerPanelLogs').contains(root.querySelector('#loadHayakuArchivedFailures')));assert.deepEqual(gui.errors,[]);assert.equal(r.llmCalls.length,0);
  console.log('PASS production DOM retires failed-repair actions, keeps missing repair and makes archived diagnostics explicit');
 }finally{await r.dispose();gui.dom.window.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
function firstAdmission(result){return JSON.parse(JSON.stringify(result.recordAdmission));}
