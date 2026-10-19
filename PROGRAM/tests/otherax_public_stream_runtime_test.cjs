'use strict';
// Public APIs only: also runnable against the actual Min release artifacts.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {createHayakuRuntime,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
for(const owner of ['libra','hayaku'])test(`${owner}: public stream status, blocked duplicate and recovery after EOF`,async()=>{
  let controller,respond=()=>({type:'success',result:'OK'}),calls=0;
  const stream=new ReadableStream({start(value){controller=value;value.enqueue('UNVERIFIED_SENTINEL');}});
  const f=owner==='libra'?await fixture():await createHayakuRuntime({autoRepair:false,afterRequestAutoRepair:false,messages:[],
    pluginSourceFile:process.env.HAYAKU_TEST_PLUGIN,llmResponder:()=>{calls++;return respond();}});
  if(owner==='libra')f.control.onCall=async()=>{calls++;return respond();};
  const probe=()=>owner==='libra'?f.r.api.testRisuAuxiliaryCall():f.hayaku.recovery.auxiliaryModel.testCall();
  const status=()=>owner==='libra'?f.r.api.getRuntime().risuAuxiliary:f.hayaku.recovery.auxiliaryModel.status();
  let first;
  try{
    respond=()=>({type:'streaming',result:stream});first=probe();
    await waitFor(()=>status().unverifiedStreams===1,'public physical stream status');
    if(owner==='hayaku')assert.match(status().blockedReason,/RisuAI.*스트리밍.*종료/);
    const blocked=await probe();assert.equal(blocked.ok,false);assert.equal(blocked.submitted,false);assert.equal(calls,1);
    assert.equal(stream.locked,true,'the pending provider keeps its physical queue');
    controller.close();
    const rejected=await first;assert.equal(rejected.ok,false);assert.equal(rejected.submitted,true);
    assert.equal(rejected.responsePreview,'');assert.equal(stream.locked,false);assert.equal(status().unverifiedStreams,0);
    respond=()=>({type:'success',result:'OK'});
    const fresh=await probe();assert.equal(fresh.ok,true);assert.equal(calls,2);
    if(owner==='libra'){assert.equal(f.getMemory(),null);assert.equal(f.getHead(),null);}
    else assert.equal((await f.hayaku.ledger.inspect({includeRecords:true})).records.length,0);
  }finally{try{controller.close();}catch(_){}await first;if(owner==='libra')await f.r.cleanup();else await f.dispose();}
});
