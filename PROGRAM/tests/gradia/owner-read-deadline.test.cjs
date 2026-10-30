'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {load}=require('./host.cjs'),createBus=require('../fixtures/libra_gradia_read_bus.cjs'),createOwner=require('../../tools/libra_gradia_unified_read.cjs');
const scope={scopeKey:'slow-scope',characterId:'c',chatId:'h'},digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function hostFixture(t){
  const bus=createBus(),observed={};let serial=0;
  const host=await load({captureInternals:true,api:bus.api('serial_gradation_agents_for_rp'),testGlobals:{crypto:crypto.webcrypto,__ownerReadProbe:observed,
    // Preserve relative deadlines while advancing this read-only protocol test
    // 1000 times faster. Provider/model timers are not part of this fixture.
    setTimeout:(fn,ms,...args)=>setTimeout(fn,ms>=10000?ms/1000:ms,...args)},transformSource:source=>{
      source=source.replace('clearStructuredSettings, fullDraftStagePrompt, Runtime };','clearStructuredSettings, fullDraftStagePrompt, Runtime, createPrivateLibReadBridge, createLibServerReadConsumer };');
      const start=source.indexOf('const createPrivateLibReadBridge ='),at=source.indexOf('    const deny =',start);assert.ok(start>0&&at>start);
      return source.slice(0,at)+'    globalThis.__ownerReadProbe.client=unifiedProvider;\n'+source.slice(at);
    }});
  const bridge=host.internals.createPrivateLibReadBridge('http://127.0.0.1:31998',()=>{});t.after(()=>bridge.dispose());
  const makeOwner=async delay=>{
    const owner=createOwner({role:'owner',api:bus.api('libra'),fingerprint:digest,randomId:()=>String(++serial),boundary:async()=>({dataInstanceId:'A'.repeat(32),resetEpoch:0}),verify:async()=>true,release:()=>{},query:async(_input,authority)=>{
      authority.bindGraph({readerFrame:{},nodes:[],edges:[],bases:[]});await pause(delay);
      return {modelDispatchEligible:true,queryComplete:true,deliveryOutcome:'complete',windowRead:{limit:20},nextWindow:{},bundle:{generation:'slow-g1'},packet:{renderedText:'OWNER_MEMORY_AFTER_SLOW_QUERY',packetDigest:digest('packet')}};
    }});await owner.start();t.after(()=>owner.dispose());return owner;
  };
  const consumer=client=>host.internals.createLibServerReadConsumer({getBinding:()=>({client,scope,maxCorpusBytes:16384}),assertNativeScope:async()=>true,digest:async value=>digest(value)});
  return {host,observed,makeOwner,consumer};
}
for(const delay of [35,65])test(`production owner IPC capture respects its bounded read budget: ${delay}s virtual query`,async t=>{
  const f=await hostFixture(t);await f.makeOwner(delay);
  const ipc=f.observed.client;
  const client={schema:'memory-suite.libra-read-client.v1',pluginId:'serial_gradation_agents_for_rp',openReadSession:async()=>{
    const snapshot=await ipc.capture({scope,binding:{url:'http://127.0.0.1:31998',dataInstanceId:'A'.repeat(32),resetEpoch:0},queryText:'Where is the ledger?',maxCorpusBytes:16384});
    return {source:'unified_engine',snapshot,assertCurrent:async()=>true,assertCurrentSync:()=>true,close:()=>ipc.release(snapshot.readIdentity.ownerReceiptId)};
  }};
  const reader=f.consumer(client);t.after(()=>reader.invalidate('LIB_READ_CANCELED'));
  if(delay>50)await assert.rejects(()=>reader.beginRead({requestId:'slow'}),error=>error.code==='LIB_READ_TIMEOUT');
  else{const session=await reader.beginRead({requestId:'slow'});assert.equal((await session.getEvidence()).items[0].content,'OWNER_MEMORY_AFTER_SLOW_QUERY');}
  assert.equal(f.host.getCalls(),0);
});
test('outer production capture guard allows a 45s owner read, independent of the IPC guard',async t=>{
  const f=await hostFixture(t),content='COMPLETE_OWNER_ITEM';
  const client={schema:'memory-suite.libra-read-client.v1',pluginId:'serial_gradation_agents_for_rp',openReadSession:async()=>{
    await pause(45);return {source:'unified_engine',snapshot:{schema:'memory-suite.libra-read-session.v1',scope,readOnly:true,complete:true,items:[{id:'m',key:'k',content,source:{revision:1}}],evidenceRevision:'a'.repeat(64),corpusBytes:Buffer.byteLength(content),maxCorpusBytes:16384},assertCurrent:async()=>true,assertCurrentSync:()=>true};
  }};
  const reader=f.consumer(client);t.after(()=>reader.invalidate('LIB_READ_CANCELED'));const session=await reader.beginRead({requestId:'outer'});
  assert.equal((await session.getEvidence()).items[0].content,content);assert.equal(f.host.getCalls(),0);
});
