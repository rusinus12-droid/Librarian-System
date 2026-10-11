'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createModelFixture:createFixture,modelSettings}=require('./fixtures/recall_model_runtime_fixture.cjs');
(async()=>{
 const summary='Alice placed the brass key inside the royal archive.';
 const f=await createFixture({arguments:{hook_recall_timeout_ms:'10000'}});
 const h=await createHayakuRuntime({autoRepair:false,arguments:{memory_suite_server_mode:'plugin_only'},messages:[
  {role:'user',id:'u1',chatId:'u1',data:'Where does Alice put the key?'},
  {role:'assistant',id:'a1',chatId:'a1',data:hiddenPacketMessage(summary,createValidPacket({turn:1,subject:'Alice',scene:'royal archive',summary}))}
 ]});
 try{
  f.currentChat.message=[{role:'user',chatId:'u1',data:'Where does Alice put the key?'},{role:'assistant',chatId:'a1',data:summary}];f.currentChat.messages=f.currentChat.message;
  const settings={...await f.api.loadSettings(),...modelSettings,embeddingEnabled:true,autoEpisodeIndex:false};
  await f.api.saveSettings(settings);await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
  const scope=await f.api.resolveCurrentScope();
  const storedBefore=JSON.stringify((await f.api._test.loadScopeRecords(scope.scopeKey)).records);
  const messages=[{role:'system',content:'Continue the story.'},{role:'user',content:'Where is the brass key Alice placed?'}];
  const output=await f.api._selectionTest.beforeRequest(messages,'model');
  const state=await f.api.debugState();
  assert.ok(JSON.stringify(output).includes('royal archive'),'Flashback hook returns actual stored evidence: '+JSON.stringify(state.lastRecall));
  assert.equal(state.lastRecall.delivery.stage,'returned_to_hook');
  assert.equal(state.lastRecall.delivery.delivered,state.lastRecall.selected.length);
  assert.equal(JSON.stringify((await f.api._test.loadScopeRecords(scope.scopeKey)).records),storedBefore,'Recall leaves canonical records unchanged');
  const preview=await f.api.recallRecords('Where is the brass key Alice placed?',{...settings,topK:1});
  assert.ok(preview.records.length<=1);
  assert.equal((await f.api.debugState()).lastRecall.delivery.delivered,state.lastRecall.delivery.delivered,'API preview does not publish hook feedback');
  // Hold a real manifest read in the normal preparation, then transfer authority
  // to emergency selection. Its late completion must be rejected at the fence.
  let releaseRead,enteredRead;const entered=new Promise(resolve=>enteredRead=resolve);
  const originalGet=f.pluginStorage.getItem.bind(f.pluginStorage);let hold=true;
  f.pluginStorage.getItem=async key=>{if(hold&&String(key).includes('manifest')){hold=false;enteredRead();await new Promise(resolve=>releaseRead=resolve);}return originalGet(key);};
  const token=f.api._selectionTest.beginFlashbackRecallRequest(scope.scopeKey),branch=token.branch;
  const pending=f.api._selectionTest.prepareFlashbackRecall('Where is the brass key?',settings,scope,{requestToken:token,requestBranch:branch});
  const observed=pending.then(value=>({value}),error=>({error}));
  await Promise.race([entered,new Promise((_,reject)=>setTimeout(()=>reject(Error('Manifest interception did not run')),1500))]);
  token.branch++;
  releaseRead();f.pluginStorage.getItem=originalGet;
  const successor=await f.api._selectionTest.prepareFlashbackRecall('Where is the brass key?',settings,scope);
  const plan=f.api._selectionTest.selectFlashbackEvidencePlan(successor,settings,1500);
  assert.ok(plan.text.length<=1500&&plan.items.length<=settings.topK,'Current model selection retains its physical budget');
  assert.equal(f.api._test.emergencySparseRecall,undefined,'unconfigured sparse fallback is retired');
  const late=await observed;
  assert.equal(late.error?.code,'FLASHBACK_RECALL_EXPIRED','Real late preparation cannot become a result after branch transfer');
  const returned=await f.api._selectionTest.beforeRequest(messages,'model');
  assert.ok(JSON.stringify(returned).includes('royal archive'),'current successor actually returns stored model-ready evidence');
  assert.equal((await f.api.debugState()).lastRecall.delivery.stage,'returned_to_hook');
  const hs=await h.hayaku._test.currentChatScope();
  await h.hayaku._test.reconcileObservedChatTopology(hs,h.hayaku._test.authoritativeChatSnapshot(hs.chatMessages,hs),'selection-hook-fixture');
  const hout=await h.hayaku._test.handleBeforeRequest(messages,'model');
  const hd=h.hayaku.lastDebug();
  assert.ok(JSON.stringify(hout).includes('royal archive'),'HAYAKU hook returns memory: '+JSON.stringify(hd.lastBeforeRequest));
  assert.equal(hd.lastBeforeRequest.recallDelivery.stage,'returned_to_hook');
  assert.ok(hd.lastBeforeRequest.recallDelivery.injectedRows>0);
  assert.equal(h.llmCalls.length,0,'Recall must not start analysis/model generation');
  assert.ok(hout.some(message=>message.role==='user'&&message.content===messages[1].content),'The user request remains intact');
  console.log('recall_selection_hook_runtime_test: PASS');
 }finally{await h.dispose();await f.dispose();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
