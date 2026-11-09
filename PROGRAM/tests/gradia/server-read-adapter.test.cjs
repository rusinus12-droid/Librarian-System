'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {load}=require('./host.cjs');

const scope={scopeKey:'s',characterId:'c',chatId:'h'};
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
async function fixture({readSource='plugin_ipc',selectOwnerRecall}={}){
  const host=await load({
    captureInternals:true,
    transformSource:source=>source.replace(
      'clearStructuredSettings, fullDraftStagePrompt, Runtime };',
      'clearStructuredSettings, fullDraftStagePrompt, Runtime, createLibServerReadConsumer };'
    ),
    testGlobals:{crypto:crypto.webcrypto}
  });
  const client={schema:'memory-suite.memory-read-client.v1',pluginId:'serial_gradation_agents_for_rp',
    openReadSession:async()=>{throw Error('legacy server read must not be opened');}};
  const consumer=host.internals.createLibServerReadConsumer({
    getBinding:()=>({client,scope,readSource}),
    assertNativeScope:async()=>true,
    digest,
    selectOwnerRecall
  });
  return {host,consumer};
}

test('legacy unified-engine response reads are rejected before transport use',async()=>{
  const f=await fixture({readSource:'unified_engine',selectOwnerRecall:async()=>({content:'unexpected'})});
  await assert.rejects(()=>f.consumer.beginRead({requestId:'legacy'}),error=>error.code==='LIB_READ_SOURCE_UNSUPPORTED');
  assert.equal(f.host.getCalls(),0);
});

test('plugin IPC requires the owner-selection contract and never opens the legacy client',async()=>{
  const f=await fixture();
  await assert.rejects(()=>f.consumer.beginRead({requestId:'missing-owner-contract'}),error=>error.code==='LIB_READ_CONNECTION_UNAVAILABLE');
  assert.equal(f.host.getCalls(),0);
});

test('client schema cannot opt response reads into unified-engine transport',async()=>{
  const f=await fixture({readSource:'plugin_ipc',selectOwnerRecall:async owner=>owner==='libra'
    ?{content:'OWNER_SELECTED_MEMORY'}
    :{absent:true,code:'LIB_READ_OWNER_UNAVAILABLE'}});
  const session=await f.consumer.beginRead({requestId:'owner-selection'});
  assert.equal(session.readSource,'plugin_ipc');
  assert.equal((await session.getEvidence()).items[0].content,'OWNER_SELECTED_MEMORY');
  assert.equal(f.host.getCalls(),0);
});
