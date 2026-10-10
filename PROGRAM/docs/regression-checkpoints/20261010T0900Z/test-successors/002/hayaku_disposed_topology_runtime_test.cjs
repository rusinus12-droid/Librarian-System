'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AsyncLocalStorage}=require('node:async_hooks');
const targetContext=new AsyncLocalStorage();
const {createStore,createValidPacket,hiddenPacketMessage,createHayakuRuntime,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const messages=()=>Array.from({length:10},(_,i)=>i+1).flatMap(turn=>[{role:'user',chatId:'u'+turn,data:'Archive entry '+turn},{role:'assistant',chatId:'a'+turn,data:hiddenPacketMessage('Completed entry '+turn,createValidPacket({turn}))}]);
async function enteredWithin(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('target wait not entered: '+label)),5000);})]);}finally{clearTimeout(timer);}}
async function runtime(){const store=createStore();await store.setItem('hayaku.v2.settings.source-tracking.v1',JSON.stringify({mode:'off',epoch:0}));const h=await createHayakuRuntime({pluginSourceFile:process.env.HAYAKU_TEST_SOURCE||undefined,pluginStorage:store,messages:messages(),autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('FORBIDDEN_MODEL');}});await waitFor(()=>h.host.unloadHandlers.length>0,'complete install');h.hayaku._test.stopWorldlineTopologyObserver();return h;}
test('suspended topology ledger read is cancelled before further reconciliation on unload',async()=>{
  const h=await runtime();let release,enteredResolve;const entered=new Promise(r=>enteredResolve=r),gate=new Promise(r=>release=r);const store=h.pluginStorage,getItem=store.getItem.bind(store);let hold=true,disposed=false,lateRecordReads=0;
  try{
    const scope=await h.hayaku._test.currentChatScope(),snapshot=h.hayaku._test.authoritativeChatSnapshot(h.chat.message,scope);
    const supplied=h.hayaku._test.emptyStorageLedger(scope);Object.defineProperty(supplied,'records',{enumerable:true,get(){if(disposed)lateRecordReads++;return [];}});
    store.getItem=async key=>{if(hold&&String(key).startsWith('hayaku.v2.ledger.')){hold=false;enteredResolve();await gate;return supplied;}return getItem(key);};
    const pending=h.hayaku._test.reconcileObservedChatTopology(scope,snapshot);await enteredWithin(entered,'topology ledger');await h.dispose();disposed=true;release();
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
    const first=h.hayaku._test.reconcileObservedChatTopology(scope,snapshot);await enteredWithin(entered,'topology ledger');
    const queued=h.hayaku._test.reconcileObservedChatTopology(scope,snapshot);await h.dispose();release();
    const result=await queued;await first;
    assert.equal(result.reason,'runtime_unloaded');assert.equal(result.durable,false);assert.equal(result.changed,false);
  }finally{release?.();store.getItem=getItem;await h.dispose();}
});
test('a suspended explicit snapshot scope read does not traverse source pairs after unload',async()=>{
  const h=await runtime();let release,enteredResolve;const entered=new Promise(r=>enteredResolve=r),gate=new Promise(r=>release=r);const getChat=h.host.getChatFromIndex.bind(h.host);let hold=true,disposed=false,latePairReads=0,targetReads=0;const token={};
  try{
    const scope=await h.hayaku._test.currentChatScope(),snapshot=h.hayaku._test.authoritativeChatSnapshot(h.chat.message,scope),pairs=snapshot.conversationPairs;
    Object.defineProperty(snapshot,'conversationPairs',{enumerable:true,get(){if(disposed)latePairReads++;return pairs;}});
    h.host.getChatFromIndex=async(...args)=>{if(hold&&targetContext.getStore()===token){hold=false;targetReads++;enteredResolve();await gate;}return getChat(...args);};
    const pending=targetContext.run(token,()=>h.hayaku._test.hayakuSourceEditSnapshot(null,snapshot,{...h.hayaku._test.emptyStorageLedger(scope),enabled:true})).then(value=>({value}),error=>({error}));
    await enteredWithin(entered,'explicit snapshot currentChatScope');await h.dispose();disposed=true;release();const result=await pending;
    assert.equal(targetReads,1,'the held host read must belong to the explicit snapshot call');
    assert.match(String(result.error?.message),/SOURCE_EDIT_SCOPE_UNAVAILABLE/);
    assert.equal(latePairReads,0,'an unloaded explicit snapshot must not traverse supplied pairs');
    assert.equal(h.hayaku.lastDebug().messageRevisionCache.scopes,0);
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{release?.();h.host.getChatFromIndex=getChat;await h.dispose();}
});
test('a superseded runtime does not normalize a suspended topology read',async()=>{
  const h=await runtime();let release,enteredResolve;const entered=new Promise(r=>enteredResolve=r),gate=new Promise(r=>release=r);const store=h.pluginStorage,getItem=store.getItem.bind(store);const previousOwner=h.context.__HAYAKU_RUNTIME_OWNER_V1__;let hold=true,replaced=false,lateRecordReads=0;
  try{
    const scope=await h.hayaku._test.currentChatScope(),snapshot=h.hayaku._test.authoritativeChatSnapshot(h.chat.message,scope);
    const supplied=h.hayaku._test.emptyStorageLedger(scope);Object.defineProperty(supplied,'records',{enumerable:true,get(){if(replaced)lateRecordReads++;return [];}});
    store.getItem=async key=>{if(hold&&String(key).startsWith('hayaku.v2.ledger.')){hold=false;enteredResolve();await gate;return supplied;}return getItem(key);};
    const pending=h.hayaku._test.reconcileObservedChatTopology(scope,snapshot);await enteredWithin(entered,'topology ledger');
    h.context.__HAYAKU_RUNTIME_OWNER_V1__='replacement-runtime';replaced=true;release();const result=await pending;
    assert.equal(lateRecordReads,0,'the old owner must not process a fulfilled read after replacement');
    assert.equal(result.reason,'runtime_not_owner');assert.equal(result.durable,false);assert.equal(result.changed,false);
  }finally{release?.();store.getItem=getItem;h.context.__HAYAKU_RUNTIME_OWNER_V1__=previousOwner;await h.dispose();}
});
for(const rejected of [false,true])test(`an explicit snapshot ${rejected?'rejected':'fulfilled'} ledger read cannot resume after unload`,async()=>{
  const h=await runtime();let release,enteredResolve;const entered=new Promise(r=>enteredResolve=r),gate=new Promise(r=>release=r);const store=h.pluginStorage,getItem=store.getItem.bind(store);let hold=true,disposed=false,latePairReads=0,lateRecordReads=0,targetReads=0;const token={};
  try{
    const scope=await h.hayaku._test.currentChatScope(),snapshot=h.hayaku._test.authoritativeChatSnapshot(h.chat.message,scope),pairs=snapshot.conversationPairs;
    Object.defineProperty(snapshot,'conversationPairs',{enumerable:true,get(){if(disposed)latePairReads++;return pairs;}});
    const ledgerKey=(await h.hayaku._test.loadStorageLedger(scope)).storageKey;assert.equal(typeof ledgerKey,'string');assert.ok(ledgerKey.startsWith('hayaku.v2.ledger.'));
    const supplied=h.hayaku._test.emptyStorageLedger(scope);Object.defineProperty(supplied,'records',{enumerable:true,get(){if(disposed)lateRecordReads++;return [];}});
    store.getItem=async key=>{if(hold&&String(key)===ledgerKey&&targetContext.getStore()===token){hold=false;targetReads++;enteredResolve();await gate;if(rejected)throw Error('CONTROLLED_LEDGER_READ_REJECTED');return supplied;}return getItem(key);};
    const pending=targetContext.run(token,()=>h.hayaku._test.hayakuSourceEditSnapshot(scope,snapshot,null)).then(value=>({value}),error=>({error}));
    await enteredWithin(entered,'explicit snapshot loadStorageLedger');await h.dispose();disposed=true;release();const result=await pending;
    assert.equal(targetReads,1,'the held ledger read must belong to the explicit snapshot call');
    assert.match(String(result.error?.message),/runtime_unloaded/);
    assert.equal(latePairReads,0,'a fulfilled or rejected read must not bypass snapshot currentness');
    assert.equal(lateRecordReads,0,'the suspended ledger must not be normalized after unload');
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{release?.();store.getItem=getItem;await h.dispose();}
});
