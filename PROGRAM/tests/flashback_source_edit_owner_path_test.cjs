'use strict';
// Current owner contract: explicit selected raw reanalysis, source projection,
// model readiness exclusion, stable identities and truthful hook diagnostics.
const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {syntheticFetch,configure,readyForRecall}=require('./helpers/unload_recall_contract_fixture.cjs');
const original=fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8');
const source=original.replace('_test: { maintenanceResultText,','_test: { buildSourceEditTab, maintenanceResultText,');
const FACT='The needle holds at the red mark and the spare valve hangs on the north wall hook.';
const chat=()=>({id:'source-owner-chat',chatId:'source-owner-chat',message:[{role:'user',chatId:'u1',data:'Inspect the gauge.'},{role:'assistant',chatId:'a1',data:FACT}]});
test('source tab provides selected raw reanalysis and shared projection controls',async()=>{
 const f=await createFixture({source,chat:chat()});try{
  const html=f.api._test.buildSourceEditTab();
  assert.match(html,/fbReanalysisRefresh/);assert.match(html,/fbReanalysisRanges/);assert.match(html,/fbReanalysisRun/);assert.match(html,/fbSourceTrackingSettings/);
  assert.equal((await f.api.previewSourceEdits([])).allowed,false,'no unselected full-source action');
  assert.equal((await f.api.applySourceEdits({allowed:true,actionKind:'explicit_reanalysis'})).status,'blocked','caller flags are not a valid ticket');
 }finally{await f.dispose()}
});
test('source inventory reports stable completed U+A identities and current projected digests',async()=>{
 const f=await createFixture({chat:chat()});try{
  await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
  const scope=await f.api.resolveCurrentScope(),snap=await f.api._test.flashbackSourceEditSnapshot();
  const state=f.api._test.liveChatStateFromNormalized(f.api._test.normalizeStoredChatMessages(f.currentChat,scope.scopeKey));
  assert.deepEqual(Array.from(snap.completedTurnIds),[f.api._test.flashbackPairIdentity(scope.scopeKey,state.pairs[0]).logicalTurnId]);
  assert.equal(snap.units.length,1);assert.ok(snap.units[0].sourceDigest);
  const inventory=await f.api.listReanalysisRanges();assert.equal(inventory.ranges[0].identity,snap.units[0].identity);
 }finally{await f.dispose()}
});
test('raw-only capture is excluded and completed model evidence reaches the actual hook',async()=>{
 const f=await createFixture({chat:chat()});try{
  f.host.nativeFetch=(url,init)=>syntheticFetch(url,init);
  await configure(f,'configured');await f.api.ingestLiveChatColdStart({scope:'current',canonical:true,deferEmbedding:true});
  const req=[{role:'user',chatId:'u9',content:'What did the gauge show, and where is the spare valve?'}];
  const raw=await f.api._selectionTest.beforeRequest(req,'model');
  assert.equal(JSON.stringify(raw).includes(FACT),false,'unready raw source is never evidence');
  const scope=await f.api.resolveCurrentScope();const before=(await f.api._test.loadScopeRecords(scope.scopeKey)).records;
  assert.equal(before.length,1);assert.equal(before[0].vector.length,0);
  await readyForRecall(f,'configured',FACT);
  const returned=await f.api._selectionTest.beforeRequest(req,'model');assert.equal(JSON.stringify(returned).includes(FACT),true);
  const recall=(await f.api.debugState()).lastRecall;assert.equal(recall.delivery.stage,'returned_to_hook');
  const pipeline=recall.delivery.pipeline;
  assert.ok(pipeline.storageRecords>0&&pipeline.candidates>0&&pipeline.selectedRecords>0&&pipeline.budgetedFragments>0&&pipeline.returnedBlockChars>0);
  assert.equal(pipeline.returnedMessages,returned.length);
 }finally{await f.dispose()}
});
test('recall UI reports hook return and storage-to-budget counts',async()=>{
 const f=await createFixture();try{
  const panel=f.api._test.renderLastRecallPanel({scopeKey:'scope',at:Date.now(),selected:[],storedRecords:8,candidates:5,preparedCandidates:3,evidenceBudgetPlan:{tier:'standard',actualChars:120},delivery:{stage:'returned_to_hook',delivered:2,pipeline:{storageRecords:8,candidates:5,selectedRecords:3,budgetedFragments:2,returnedMessages:4}}},'scope');
  assert.match(panel,/후크 반환/);assert.match(panel,/저장 8[^<]*후보 5[^<]*선택 3[^<]*예산 2[^<]*후크 반환 4개 메시지/);assert.doesNotMatch(panel,/실제 전달/);
 }finally{await f.dispose()}
});
test('diff renderer escapes source HTML and highlights only an exact observed span',async()=>{
 const f=await createFixture();try{
  const diff=f.api._test.flashbackSourceDiff('Alice signed.','Alice did not sign. <img src=x onerror="attack()">');
  assert.match(diff.after,/<mark/);assert.match(diff.after,/&lt;img/);assert.doesNotMatch(diff.after,/<img/);assert.ok(diff.added>0&&diff.removed>0);
 }finally{await f.dispose()}
});
test('projection-rule change changes projected digest without rewriting raw host source',async()=>{
 const c=chat();c.message[1].data='The code is <private>Saffron Harbor</private>.';
 const f=await createFixture({chat:c});try{
  await f.api.setSourceEditRules({version:1,ignoredTags:['private'],unwrapTags:[],sourceTags:[],controls:[]});
  await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
  const raw=JSON.stringify(f.currentChat.message),before=await f.api._test.flashbackSourceEditSnapshot();
  await f.api.setSourceEditRules({version:1,ignoredTags:[],unwrapTags:[],sourceTags:[],controls:[]});
  const after=await f.api._test.flashbackSourceEditSnapshot();
  assert.equal(JSON.stringify(f.currentChat.message),raw);assert.equal(after.units[0].identity,before.units[0].identity);assert.notEqual(after.units[0].sourceDigest,before.units[0].sourceDigest);
 }finally{await f.dispose()}
});
test('ignored, unwrapped and selected tags govern current source projection',async()=>{
 for(const item of [
  {rules:{ignoredTags:['ignored']},initial:'The code is <ignored>draft one</ignored> stable.',edits:[['The code is <ignored>draft two</ignored> stable.',false]]},
  {rules:{unwrapTags:['box']},initial:'The code is <box>draft one</box> stable.',edits:[['The code is <box>draft two</box> stable.',true]]},
  {rules:{sourceTags:['original']},initial:'<original>The code is draft one.</original> Translation one.',edits:[['<original>The code is draft one.</original> Translation two.',false],['<original>The code is draft two.</original> Translation two.',true]]}
 ]){
  const c=chat();c.message[1].data=item.initial;const f=await createFixture({chat:c});try{
   await f.api.setSourceEditRules({version:1,ignoredTags:[],unwrapTags:[],sourceTags:[],controls:[],...item.rules});
   await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});const baseline=await f.api._test.flashbackSourceEditSnapshot();
   for(const [edited,changed]of item.edits){f.currentChat.message[1].data=edited;const observed=await f.api._test.flashbackSourceEditSnapshot();assert.equal(observed.units[0].sourceDigest!==baseline.units[0].sourceDigest,changed)}
  }finally{await f.dispose()}
 }
});
