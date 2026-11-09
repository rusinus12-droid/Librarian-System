'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {load}=require('./host.cjs');

const scope={scopeKey:'slow-scope',characterId:'c',chatId:'h'};
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

async function fixture({delay=0,content='OWNER_MEMORY_AFTER_SLOW_QUERY'}={}){
  const host=await load({captureInternals:true,transformSource:source=>source.replace(
    'clearStructuredSettings, fullDraftStagePrompt, Runtime };',
    'clearStructuredSettings, fullDraftStagePrompt, Runtime, createLibServerReadConsumer };'
  ),testGlobals:{
    crypto:crypto.webcrypto,
    setTimeout:(fn,ms,...args)=>setTimeout(fn,ms>=10000?ms/1000:ms,...args)
  }});
  let calls=0;
  const client={schema:'memory-suite.memory-read-client.v1',pluginId:'serial_gradation_agents_for_rp',openReadSession:async()=>{
    throw Error('plugin IPC must not open a server read session');
  }};
  const consumer=host.internals.createLibServerReadConsumer({
    getBinding:()=>({client,scope,readSource:'plugin_ipc'}),
    assertNativeScope:async()=>true,
    digest:async value=>digest(value),
    selectOwnerRecall:async(owner,_scope,_query,signal)=>{
      calls++;
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(resolve,delay);
        signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(Object.assign(new Error('LIB_READ_CANCELED'),{code:'LIB_READ_CANCELED'}));},{once:true});
      });
      return owner==='libra'?{content}:{absent:true,code:'LIB_READ_OWNER_UNAVAILABLE'};
    }
  });
  return {host,consumer,calls:()=>calls};
}

for(const [delay,expected] of [[5,'ready'],[250,'timeout']])
  test(`owner IPC selection respects its bounded read budget: ${delay}s virtual query`,async()=>{
    const f=await fixture({delay});
    const pending=f.consumer.beginRead({requestId:'slow'});
    if(expected==='timeout') await assert.rejects(()=>pending,error=>error.code==='LIB_READ_TIMEOUT');
    else {
      const session=await pending;
      assert.equal(session.status,'ready');
      assert.equal((await session.getEvidence()).items[0].content,'OWNER_MEMORY_AFTER_SLOW_QUERY');
    }
    assert.equal(f.host.getCalls(),0);
    assert.equal(f.calls(),3);
  });

test('owner IPC response delivery is independent of the retired server capture path',async()=>{
  const f=await fixture({delay:0,content:'COMPLETE_OWNER_ITEM'});
  const session=await f.consumer.beginRead({requestId:'owner-ipc'});
  assert.equal((await session.getEvidence()).items[0].content,'COMPLETE_OWNER_ITEM');
  assert.equal(f.host.getCalls(),0);
});
