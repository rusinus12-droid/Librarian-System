'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,quotes,selected,seedRange}=require('./fixtures/hayaku_reanalysis_fixture.cjs');
const {waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const {envelope}=require('./fixtures/shared_reanalysis_owner_fixture.cjs');
test('packet detail navigates to a preselected source turn and requires explicit approval before analysis',async()=>{
 const f=await fixture();try{
  const ledger=await f.api.ledger.inspect({includeRecords:true}),record=ledger.records.find(row=>row.targetPairIndex===2&&row.recordState==='active');
  await f.show();const calls=f.r.llmCalls.length;await f.clickRecord(record);
  assert.equal(f.root.querySelector('[data-reanalysis-fold]').open,true);assert.deepEqual(selected(f),['2']);assert.equal(f.root.querySelector('[data-reanalysis-review]').hidden,false);
  assert.equal(f.root.querySelector('[data-hayaku-regenerate-record]'),null);assert.equal(f.root.querySelector('#hayakuRegenerateConfirmOverlay'),null);assert.equal(f.r.llmCalls.length,calls);
  f.root.querySelector('[data-reanalysis-run]').click();await waitFor(()=>f.root.querySelector('[data-reanalysis-confirm="apply"]'),'confirmation');assert.equal(f.r.llmCalls.length,calls);
  f.root.querySelector('[data-reanalysis-confirm="apply"]').click();await waitFor(()=>f.root.querySelector('[data-reanalysis-status]')?.textContent.includes('기억을 갱신했습니다'),'published replacement').catch(error=>{error.message+=': '+f.root.querySelector('[data-reanalysis-status]')?.textContent;throw error;});
  assert.deepEqual(selected(f),[]);assert.equal(f.root.querySelector('[data-reanalysis-run]').disabled,true);
  assert.equal(f.r.llmCalls.length,calls+1);const after=await f.api.ledger.inspect({includeRecords:true});assert.equal(after.records.find(row=>row.recordId===record.recordId).recordState,'tombstoned');
  assert.ok(after.records.some(row=>row.targetPairIndex===2&&row.recordState==='active'&&row.captureSource==='bridge_incremental_recovery'));
 }finally{await f.close();}
});
test('a legacy multi-turn packet opens its whole range and linked checkboxes cannot select a partial packet',async()=>{
 const f=await fixture();try{
  const record=await seedRange(f);await f.show();const calls=f.r.llmCalls.length;await f.clickRecord(record);assert.deepEqual(selected(f),['1','2']);assert.equal(f.root.querySelector('[data-reanalysis-review]').hidden,true);assert.equal(f.r.llmCalls.length,calls);
  let input=f.root.querySelector('[data-reanalysis-ranges] input[value="1"]');input.click();assert.deepEqual(selected(f),[]);
  f.root.querySelector('[data-reanalysis-ranges] input[value="2"]').click();assert.deepEqual(selected(f),['1','2']);
  const inventory=await f.api.listReanalysisRanges();const partial=await f.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(row=>row.key==='2')});assert.equal(partial.ok,false);assert.match(partial.reason,/COVERAGE_INCOMPLETE/);assert.equal(f.r.llmCalls.length,calls);
  const before=await f.api.ledger.inspect({includeRecords:true}),suffix=before.records.find(row=>row.targetPairIndex===3&&row.recordState==='active');
  const result=await f.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(row=>['1','2'].includes(row.key))});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.r.llmCalls.length,calls+2);
  const after=await f.api.ledger.inspect({includeRecords:true});assert.equal(after.records.find(row=>row.recordId===record.recordId).recordState,'tombstoned');assert.deepEqual(after.records.find(row=>row.recordId===suffix.recordId),suffix);
 }finally{await f.close();}
});
test('local cold-start records can be replaced while other cold-start turns remain covered after reload',async()=>{
 const f=await fixture({cold:true,turns:2});try{
  let index=0;f.r.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope(quotes[index++]))}));
  const cold=await f.api.recovery.coldStart({resume:true});assert.equal(cold.ok,true,JSON.stringify(cold));
  const before=await f.api.ledger.inspect({includeRecords:true}),record=before.records.find(row=>row.captureSource==='bridge_cold_start'&&f.api._test.storageRecordTurnRange(row).turnStart===1);
  await f.show();const calls=f.r.llmCalls.length;await f.clickRecord(record);assert.deepEqual(selected(f),['1']);assert.equal(f.r.llmCalls.length,calls);
  f.r.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope(quotes[0]))}));const inventory=await f.api.listReanalysisRanges();const result=await f.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(row=>row.key==='1')});assert.equal(result.ok,true,JSON.stringify(result));
  const after=await f.api.ledger.inspect({includeRecords:true});assert.equal(after.records.find(row=>row.recordId===record.recordId).recordState,'tombstoned');assert.ok(after.records.some(row=>row.captureSource==='bridge_cold_start'&&row.recordState==='historical'));
  const status=await f.api.recovery.status({includeDebts:true,refreshDebts:true});assert.ok(status.debt.coverage.coveredTurns.includes(2),JSON.stringify(status.debt.coverage));assert.equal(f.r.llmCalls.length,calls+1);
 }finally{await f.close();}
});
test('stale record, hash and scope shortcuts cannot substitute a different target',async()=>{
 const f=await fixture();try{
  const ledger=await f.api.ledger.inspect({includeRecords:true}),record=ledger.records.find(row=>row.recordState==='active');await f.show();const calls=f.r.llmCalls.length;
  for(const options of [{scopeKey:'other-scope',recordId:record.recordId},{recordId:'missing-record'},{recordId:record.recordId,recordHash:'changed-hash'}])assert.equal((await f.api.openSourceReanalysis(options)).ok,false);
  assert.equal(f.r.llmCalls.length,calls);assert.equal(f.root.querySelectorAll('[data-reanalysis-ranges] input:checked').length,0);
 }finally{await f.close();}
});
test('all old direct regeneration and failure-retry execution APIs are removed',async()=>{
 const f=await fixture();try{
  assert.equal(f.api.recovery.regenerateTurns,undefined);assert.equal(f.api.recovery.failedAnalysis.resolve,undefined);assert.equal(f.api.recovery.failedAnalysis.automationStatus,undefined);
  const ledger=await f.api.ledger.inspect({includeRecords:true}),before=f.r.host.pluginStorage.values.get(ledger.storageKey),calls=f.r.llmCalls.length;
  for(const options of [{replaceExisting:true},{replacementRecordIds:['old-record']}])assert.equal((await f.api.recovery.repairNow(options)).reason,'explicit_reanalysis_required');
  assert.equal((await f.api._test.runNativeTargetedRegeneration({targetTurns:[1]})).reason,'explicit_reanalysis_required');
  assert.equal(f.r.llmCalls.length,calls);assert.equal(f.r.host.pluginStorage.values.get(ledger.storageKey),before);
 }finally{await f.close();}
});
test('a stored packet revision changed during analysis is never replaced by the captured selection',async()=>{
 const f=await fixture();let release=()=>{};try{
  const inventory=await f.api.listReanalysisRanges(),selection={...inventory,ranges:inventory.ranges.filter(row=>row.key==='2')};
  const gate=new Promise(resolve=>release=resolve);f.r.setLlmResponder(async()=>{await gate;return {type:'success',result:JSON.stringify(envelope(quotes[1]))};});
  const pending=f.api.reanalyzeSelectedRanges(selection);await waitFor(()=>f.r.llmCalls.length===1,'model started');
  const scope=await f.api._test.currentChatScope(),ledger=await f.api._test.loadStorageLedger(scope),record=ledger.records.find(row=>row.recordState==='active'&&row.targetPairIndex===2),body=JSON.parse(record.raw);
  body.meta.summary_memory.summary='A separately edited packet revision.';
  const changed=f.api._test.normalizeStorageRecord({...record,raw:JSON.stringify(body),hash:''});assert.ok(changed);
  const foreign={...ledger,records:ledger.records.map(row=>row.recordId===record.recordId?changed:row)};assert.equal((await f.api._test.writeStorageLedgerDirect(scope,foreign,'fixture_concurrent_revision')).durable,true);
  release();const result=await pending;assert.equal(result.ok,false);assert.match(result.reason,/REPLACEMENT_CHANGED|IDENTITY_CHANGED/);
  const after=await f.api.ledger.inspect({includeRecords:true});assert.equal(after.records.find(row=>row.recordId===changed.recordId)?.hash,changed.hash);assert.equal(after.records.some(row=>row.captureSource==='bridge_incremental_recovery'),false);
 }finally{release();await f.close();}
});
test('an inherited or permanent historical packet cannot acquire a source-reanalysis shortcut',async()=>{
 const f=await fixture({cold:true,turns:1});try{
  f.r.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope(quotes[0]))}));assert.equal((await f.api.recovery.coldStart({resume:true})).ok,true);
  const scope=await f.api._test.currentChatScope(),ledger=await f.api._test.loadStorageLedger(scope),record=ledger.records.find(row=>row.captureSource==='bridge_cold_start'),calls=f.r.llmCalls.length;
  for(const patch of [{inheritedFromScopeKey:'other-chat-history'},{permanentSessionHistory:true}]){
   const protectedLedger={...ledger,records:ledger.records.map(row=>row.recordId===record.recordId?{...row,...patch}:row)};
   assert.equal((await f.api._test.writeStorageLedgerDirect(scope,protectedLedger,'fixture_protected_history')).durable,true);
   assert.equal((await f.api.listReanalysisRanges()).ranges.length,0);
   assert.equal((await f.api.openSourceReanalysis({scopeKey:scope.key,recordId:record.recordId,recordHash:record.hash})).ok,false);
  }
  assert.equal(f.r.llmCalls.length,calls);
 }finally{await f.close();}
});
test('the supported entry can open a previously hidden viewer and select its requested turn after hydration',async()=>{
 const f=await fixture();try{
  const inventory=await f.api.listReanalysisRanges();f.attachGui();const calls=f.r.llmCalls.length;
  const result=await f.api.openSourceReanalysis({scopeKey:inventory.scopeKey,startTurn:2,endTurn:2});assert.equal(result.ok,true,JSON.stringify(result));
  await waitFor(()=>selected(f).join(',')==='2','hidden viewer contextual selection');assert.equal(f.r.llmCalls.length,calls);
 }finally{await f.close();}
});
test('the source operation keeps other model-producing entries locked until its ledger publication settles',async()=>{
 const f=await fixture();let release=()=>{};try{
  const inventory=await f.api.listReanalysisRanges(),key=(await f.api.ledger.inspect({includeRecords:true})).storageKey,store=f.r.host.pluginStorage,set=store.setItem.bind(store);
  let held=false;const gate=new Promise(resolve=>release=resolve);
  store.setItem=async(k,v)=>{if(k===key&&!held&&JSON.parse(v).records.some(row=>row.captureSource==='bridge_incremental_recovery')){held=true;await gate;}return set(k,v);};
  const pending=f.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(row=>row.key==='2')});await waitFor(()=>held,'publication gate');const calls=f.r.llmCalls.length;
  assert.equal((await f.api.recovery.repairNow()).reason,'source_reanalysis_in_progress');
  assert.equal((await f.api.recovery.coldStart()).reason,'source_reanalysis_in_progress');
  assert.equal((await f.api.recovery.auxiliaryModel.testCall()).reason,'source_reanalysis_in_progress');
  assert.equal((await f.api.recovery.repairSelected({targetTurns:[1]})).reason,'native_recovery_busy');
  assert.equal(f.r.llmCalls.length,calls);release();assert.equal((await pending).ok,true);
 }finally{release();await f.close();}
});
