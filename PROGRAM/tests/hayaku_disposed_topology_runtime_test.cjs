'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createStore,createValidPacket,hiddenPacketMessage,createHayakuRuntime,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const messages=()=>Array.from({length:10},(_,i)=>i+1).flatMap(turn=>[{role:'user',chatId:'u'+turn,data:'Archive entry '+turn},{role:'assistant',chatId:'a'+turn,data:hiddenPacketMessage('Completed entry '+turn,createValidPacket({turn}))}]);
async function runtime(){const store=createStore();await store.setItem('hayaku.v2.settings.source-tracking.v1',JSON.stringify({mode:'off',epoch:0}));const h=await createHayakuRuntime({pluginSourceFile:process.env.HAYAKU_TEST_SOURCE||undefined,pluginStorage:store,messages:messages(),autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('FORBIDDEN_MODEL');}});await waitFor(()=>h.host.unloadHandlers.length>0,'complete install');h.hayaku._test.stopWorldlineTopologyObserver();return h;}
test('suspended topology ledger read is cancelled before further reconciliation on unload',async()=>{
  const h=await runtime();let release,enteredResolve;const entered=new Promise(r=>enteredResolve=r),gate=new Promise(r=>release=r);const store=h.pluginStorage,getItem=store.getItem.bind(store);let hold=true,disposed=false,lateRecordReads=0;
  try{
    const scope=await h.hayaku._test.currentChatScope(),snapshot=h.hayaku._test.authoritativeChatSnapshot(h.chat.message,scope);
    const supplied=h.hayaku._test.emptyStorageLedger(scope);Object.defineProperty(supplied,'records',{enumerable:true,get(){if(disposed)lateRecordReads++;return [];}});
    store.getItem=async key=>{if(hold&&String(key).startsWith('hayaku.v2.ledger.')){hold=false;enteredResolve();await gate;return supplied;}return getItem(key);};
    const pending=h.hayaku._test.reconcileObservedChatTopology(scope,snapshot);await entered;await h.dispose();disposed=true;release();
    const result=await pending;
    assert.equal(lateRecordReads,0,'an unloaded runtime must not parse or normalize the ledger returned by its suspended read');
    assert.equal(result.durable,false);assert.equal(result.changed,false);assert.equal(result.reason,'runtime_unloaded');
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{release?.();store.getItem=getItem;await h.dispose();}
});
test('topology work queued before unload is cancelled before entering its storage callback',async()=>{
  const h=await runtime();let release,enteredResolve;const entered=new Promise(r=>enteredResolve=r),gate=new Promise(r=>release=r);const store=h.pluginStorage,getItem=store.getItem.bind(store);let hold=true;
  try{
    const scope=await h.hayaku._test.currentChatScope(),snapshot=h.hayaku._test.authoritativeChatSnapshot(h.chat.message,scope);
    store.getItem=async key=>{if(hold&&String(key).startsWith('hayaku.v2.ledger.')){hold=false;enteredResolve();await gate;}return getItem(key);};
    const first=h.hayaku._test.reconcileObservedChatTopology(scope,snapshot);await entered;
    const queued=h.hayaku._test.reconcileObservedChatTopology(scope,snapshot);await h.dispose();release();
    const result=await queued;await first;
    assert.equal(result.reason,'runtime_unloaded');assert.equal(result.durable,false);assert.equal(result.changed,false);
  }finally{release?.();store.getItem=getItem;await h.dispose();}
});
test('a suspended observer scope read does not rebuild caches after unload',async()=>{
  const h=await runtime();let release,enteredResolve;const entered=new Promise(r=>enteredResolve=r),gate=new Promise(r=>release=r);const getChat=h.host.getChatFromIndex.bind(h.host);let hold=true;
  try{
    h.host.getChatFromIndex=async(...args)=>{if(hold){hold=false;enteredResolve();await gate;}return getChat(...args);};
    h.hayaku._test.scheduleWorldlineTopologyObserver();await entered;await h.dispose();
    assert.equal(h.hayaku.lastDebug().messageRevisionCache.scopes,0);
    release();await new Promise(r=>setTimeout(r,100));
    assert.equal(h.hayaku.lastDebug().messageRevisionCache.scopes,0,'a disposed observer must not repopulate transcript caches');
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{release?.();h.host.getChatFromIndex=getChat;await h.dispose();}
});
test('a superseded runtime does not normalize a suspended topology read',async()=>{
  const h=await runtime();let release,enteredResolve;const entered=new Promise(r=>enteredResolve=r),gate=new Promise(r=>release=r);const store=h.pluginStorage,getItem=store.getItem.bind(store);const previousOwner=h.context.__HAYAKU_RUNTIME_OWNER_V1__;let hold=true,replaced=false,lateRecordReads=0;
  try{
    const scope=await h.hayaku._test.currentChatScope(),snapshot=h.hayaku._test.authoritativeChatSnapshot(h.chat.message,scope);
    const supplied=h.hayaku._test.emptyStorageLedger(scope);Object.defineProperty(supplied,'records',{enumerable:true,get(){if(replaced)lateRecordReads++;return [];}});
    store.getItem=async key=>{if(hold&&String(key).startsWith('hayaku.v2.ledger.')){hold=false;enteredResolve();await gate;return supplied;}return getItem(key);};
    const pending=h.hayaku._test.reconcileObservedChatTopology(scope,snapshot);await entered;
    h.context.__HAYAKU_RUNTIME_OWNER_V1__='replacement-runtime';replaced=true;release();const result=await pending;
    assert.equal(lateRecordReads,0,'the old owner must not process a fulfilled read after replacement');
    assert.equal(result.reason,'runtime_not_owner');assert.equal(result.durable,false);assert.equal(result.changed,false);
  }finally{release?.();store.getItem=getItem;h.context.__HAYAKU_RUNTIME_OWNER_V1__=previousOwner;await h.dispose();}
});
test('a suspended source-edit journal read does not traverse source pairs after unload',async()=>{
  const h=await runtime();let release,enteredResolve;const entered=new Promise(r=>enteredResolve=r),gate=new Promise(r=>release=r);const store=h.pluginStorage,getItem=store.getItem.bind(store);let hold=true,disposed=false,latePairReads=0;
  try{
    const scope=await h.hayaku._test.currentChatScope(),snapshot=h.hayaku._test.authoritativeChatSnapshot(h.chat.message,scope),pairs=snapshot.conversationPairs;
    Object.defineProperty(snapshot,'conversationPairs',{enumerable:true,get(){if(disposed)latePairReads++;return pairs;}});
    store.getItem=async key=>{if(hold&&String(key).startsWith('hayaku.v2.source-edit.')){hold=false;enteredResolve();await gate;}return getItem(key);};
    const pending=h.hayaku._test.hayakuSourceEditSnapshot(scope,snapshot,{...h.hayaku._test.emptyStorageLedger(scope),enabled:true});
    await entered;await h.dispose();disposed=true;release();const result=await pending;
    assert.equal(latePairReads,0,'an unloaded source-edit snapshot must not traverse the pairs returned before its journal wait');
    assert.equal(result,null);assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{release?.();store.getItem=getItem;await h.dispose();}
});
test('a rejected source-edit evidence read does not resume its snapshot after unload',async()=>{
  const h=await runtime();let release,enteredResolve;const entered=new Promise(r=>enteredResolve=r),gate=new Promise(r=>release=r);const store=h.pluginStorage,getItem=store.getItem.bind(store);let hold=true,disposed=false,latePairReads=0;
  try{
    const scope=await h.hayaku._test.currentChatScope(),snapshot=h.hayaku._test.authoritativeChatSnapshot(h.chat.message,scope),pairs=snapshot.conversationPairs.slice(0,1);
    const ledger={enabled:true,records:pairs.map(p=>({targetPairIndex:p.pairIndex,userHash:p.userHash,assistantVisibleHash:'old-assistant',recordState:'active',hash:'old-packet'})),worldline:{nodes:[]}};
    await h.hayaku._test.getHayakuSourceEdits().loadScope(scope.key);
    Object.defineProperty(snapshot,'conversationPairs',{enumerable:true,get(){if(disposed)latePairReads++;return pairs;}});
    store.getItem=async key=>{if(hold&&String(key).startsWith('hayaku.v2.source-evidence.')){hold=false;enteredResolve();await gate;throw Error('CONTROLLED_EVIDENCE_READ_REJECTED');}return getItem(key);};
    const pending=h.hayaku._test.hayakuSourceEditSnapshot(scope,snapshot,ledger);await entered;await h.dispose();disposed=true;release();const result=await pending;
    assert.equal(latePairReads,0,'a rejected read must not bypass the snapshot currentness check');assert.equal(result,null);
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{release?.();store.getItem=getItem;await h.dispose();}
});
