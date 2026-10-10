'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createMemorySuiteServer}=require('../server/server.cjs');
const {seedLegacyMirrorFixture}=require('./helpers/legacy_mirror_fixture.cjs');

const sdk=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteStorageClient.libra.source.js'),'utf8');
const createBridge=new Function(sdk+'\nreturn createMemorySuiteStorageBridge;')();
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const waitFor=(promise,label)=>{
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`timed out: ${label}`)),3000);})])
    .finally(()=>clearTimeout(timer));
};

async function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'libra-mirror-readback-order-'));
  const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false});
  const address=await app.listen(),url=`http://127.0.0.1:${address.port}`;
  const scope={scopeId:'mirror-readback-order-scope',scopeKey:'mirror-readback-order-scope',available:true,chatId:'mirror-readback-order-chat'};
  let held=null;
  const prior=globalThis.risuai;
  globalThis.risuai={
    getArgument:async name=>name==='memory_suite_server_url'?url:'mirror',
    setArgument:async()=>true,
    nativeFetch:async(request,init)=>{
      const response=await fetch(request,init),gate=held;
      if(gate&&String(init?.method||'GET').toUpperCase()==='GET'){
        const parsed=new URL(request);
        if(parsed.pathname==='/v1/kv/get'&&parsed.searchParams.get('key')===gate.key){
          gate.reads++;
          if(gate.reads===gate.readNumber){gate.entered.resolve();await gate.release.promise;}
        }
      }
      return response;
    }
  };
  const bridge=createBridge({namespace:'libra',pluginId:'libra',pluginVersion:'mirror-race-test',pluginPrefixes:['libra:'],managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false,currentScopeProvider:async()=>scope});
  const store={values:new Map(),async getItem(key){return this.values.get(String(key))??null;},async setItem(key,value){this.values.set(String(key),value);return true;},async removeItem(key){this.values.delete(String(key));return true;},async keys(){return[...this.values.keys()];}};
  const proxy=bridge.createPluginStorageProxy(store);
  await seedLegacyMirrorFixture(bridge,store,scope);
  assert.equal((await bridge.getScopeMode(scope)).mode,'mirror','persisted legacy upgrade fixture');
  const hold=(key,readNumber)=>{
    const entered=deferred(),release=deferred();held={key,readNumber,reads:0,entered,release};
    return{entered:entered.promise,release:()=>{held=null;release.resolve();}};
  };
  return{app,dir,bridge,store,proxy,hold,async close(){held?.release.resolve();await bridge.dispose();globalThis.risuai=prior;await app.close();fs.rmSync(dir,{recursive:true,force:true});}};
}

async function assertWriterWaitsForReadback(kind){
  const f=await fixture(),key=`libra:${kind}-mirror-readback`;
  try{
    await f.proxy.setItem(key,{revision:'base'});
    let first,gate;
    if(kind==='read'){
      gate=f.hold(key,1);
      first=f.proxy.getItem(key);
      await waitFor(gate.entered,`${kind} remote read`);
    }else{
      gate=f.hold(key,2);
      first=f.proxy.setItem(key,{revision:'older'});
      await waitFor(gate.entered,`${kind} set readback`);
    }
    let secondSettled=false;
    const second=kind==='remove'?f.proxy.removeItem(key):f.proxy.setItem(key,{revision:'newer'});
    void second.then(()=>{secondSettled=true;},()=>{secondSettled=true;});
    await new Promise(resolve=>setTimeout(resolve,60));
    const secondOvertookReadback=secondSettled;
    gate.release();
    await Promise.all([waitFor(first,`${kind} first operation`),waitFor(second,`${kind} second operation`)]);
    assert.equal(secondOvertookReadback,false,`${kind}: same-key server commit/removal must wait while the earlier server readback is still pending`);
    if(kind==='remove')assert.equal(f.store.values.has(key),false,'a remove must not be undone by an older delayed mirror copy');
    else{
      const remote=await f.bridge.serverGet('plugin',key);
      const local=f.store.values.get(key),localValue=typeof local==='string'?JSON.parse(local):local;
      assert.deepEqual(localValue,remote.value,`${kind}: local mirror must finish at the authoritative server value`);
      if(kind==='write')assert.deepEqual(remote.value,{revision:'newer'});
    }
  }finally{await f.close();}
}

async function assertDifferentKeyRemainsIndependent(){
  const f=await fixture(),heldKey='libra:held-mirror-readback',otherKey='libra:independent-mirror-key';
  try{
    await f.proxy.setItem(heldKey,{revision:'base'});
    await f.proxy.setItem(otherKey,{revision:'base'});
    const gate=f.hold(heldKey,1),read=f.proxy.getItem(heldKey);
    await waitFor(gate.entered,'held-key mirror read');
    await waitFor(f.proxy.setItem(otherKey,{revision:'independent'}),'different-key write');
    gate.release();
    await waitFor(read,'held-key mirror read completion');
    const local=f.store.values.get(otherKey),localValue=typeof local==='string'?JSON.parse(local):local;
    assert.deepEqual(localValue,(await f.bridge.serverGet('plugin',otherKey)).value,'per-key serialization does not block unrelated keys');
  }finally{await f.close();}
}

async function assertConditionalBatchWaitsForMirror(){
  const f=await fixture(),key='libra:conditional-batch-mirror-race';
  const prepare=async(value,expected)=>await f.bridge.prepareConditionalBatch({mutations:[{space:'plugin',key,kind:'set',value,expected}]});
  try{
    await f.proxy.setItem(key,{revision:'base'});
    const firstPrepared=await prepare({revision:'first'},{exists:true,value:{revision:'base'}});
    const gate=f.hold(key,2),first=f.bridge.commitConditionalBatch(firstPrepared);
    await waitFor(gate.entered,'first conditional-batch local mirror');
    const secondPrepared=await prepare({revision:'second'},{exists:true,value:{revision:'first'}});
    let secondSettled=false;
    const second=f.bridge.commitConditionalBatch(secondPrepared);
    void second.then(()=>{secondSettled=true;},()=>{secondSettled=true;});
    await new Promise(resolve=>setTimeout(resolve,60));
    const secondOvertookReadback=secondSettled;
    gate.release();
    await Promise.all([waitFor(first,'first conditional batch'),waitFor(second,'second conditional batch')]);
    assert.equal(secondOvertookReadback,false,'a second batch on the same key must wait for first batch local readback');
    const remote=await f.bridge.serverGet('plugin',key),local=f.store.values.get(key),localValue=typeof local==='string'?JSON.parse(local):local;
    assert.deepEqual(remote.value,{revision:'second'});
    assert.deepEqual(localValue,remote.value,'conditional-batch local copy must end at the newest authoritative revision');
  }finally{await f.close();}
}

(async()=>{
  await assertWriterWaitsForReadback('write');
  console.log('PASS mirror writes serialize commit, authoritative readback, and local copy');
  await assertWriterWaitsForReadback('read');
  console.log('PASS an older mirror read cannot overwrite a later same-key write');
  await assertWriterWaitsForReadback('remove');
  console.log('PASS mirror removal cannot be undone by an older delayed readback');
  await assertDifferentKeyRemainsIndependent();
  console.log('PASS per-key serialization leaves unrelated keys independent');
  await assertConditionalBatchWaitsForMirror();
  console.log('PASS conditional batch commit and local mirror share the same per-key tail');
  console.log(JSON.stringify({test:'libra_mirror_readback_order',passed:5,boundary:'production LIBRA storage bridge + local HTTP/SQLite; controlled readback delay'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
