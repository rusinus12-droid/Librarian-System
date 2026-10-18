'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHayakuRuntime,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const {fixture:createLibraFixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const observed=promise=>promise.then(value=>({value}),error=>({error}));

function controlledStream(){
  let controller,readers=0;
  const stream=new ReadableStream({start(value){controller=value;value.enqueue('UNVERIFIED_STREAM_SENTINEL');}});
  const acquire=stream.getReader.bind(stream);
  stream.getReader=()=>{readers++;return acquire();};
  return {stream,get readers(){return readers;},close(){try{controller.close();}catch(_){}},
    error(reason){controller.error(reason??new Error('STREAM_FAILED'));}};
}

async function fixture(owner){
  let responder=async()=>({type:'success',result:'{"fresh":true}'});
  if(owner==='hayaku'){
    const r=await createHayakuRuntime({autoRepair:false,afterRequestAutoRepair:false,messages:[],pluginSourceFile:process.env.HAYAKU_TEST_PLUGIN,
      transformSource:source=>source.replace('const runNativeOtherAx = async','const runNativeOtherAx = globalThis.__streamGateway = async'),
      llmResponder:options=>responder(options)});
    return {calls:r.llmCalls,respond:fn=>{responder=fn;},
      call:options=>r.context.__streamGateway([{role:'user',content:'Do not store this diagnostic.'}],{taskKind:'connection_probe',deadlineAt:Date.now()+5000,...options}),
      probe:()=>r.hayaku.recovery.auxiliaryModel.testCall(),
      async assertNoCanon(){assert.equal((await r.hayaku.ledger.inspect({includeRecords:true})).records.length,0);},dispose:r.dispose};
  }
  const f=await createLibraFixture({transformSource:source=>source.replace('const callLLMWithPreset = async','const callLLMWithPreset = globalThis.__streamGateway = async')});
  const calls=[];
  f.control.onCall=async args=>{calls.push(args[0]);return responder(args[0]);};
  const settings={presets:{host:{provider:'risuai_aux',model:'',timeout_ms:5000}},defaultPresetName:'host',stagePresetNames:{librarian:'host'},risuAuxAllowPlugins:true};
  return {calls,respond:fn=>{responder=fn;},
    call:options=>f.r.context.__streamGateway(settings,'librarian','Do not store this diagnostic.','Return a short response.',{taskKind:'connection_probe',deadlineAt:Date.now()+5000,...options}),
    probe:()=>f.r.api.testRisuAuxiliaryCall(),
    async assertNoCanon(){assert.equal(f.getMemory(),null);assert.equal(f.getHead(),null);},dispose:()=>f.r.cleanup()};
}

for(const owner of ['libra','hayaku']){
  for(const shape of ['root','wrapped','mixed text','failed response','duplicate alias'])test(`${owner} ${shape} stream is drained once and rejected before the next wire call`,async()=>{
    const f=await fixture(owner),s=controlledStream();let first,second;
    try{
      const response=shape==='root'?s.stream:shape==='mixed text'?{type:'success',content:'{"mustNotAdopt":true}',result:s.stream}
        :shape==='failed response'?{type:'fail',result:s.stream}:shape==='duplicate alias'?{type:'streaming',content:s.stream,result:s.stream}
          :{type:'streaming',result:s.stream};
      f.respond(async()=>f.calls.length===1?response:{type:'success',result:'{"fresh":true}'});
      first=observed(f.call());
      await waitFor(()=>f.calls.length===1,'first physical call');
      second=observed(f.call());await pause(25);
      assert.equal(f.calls.length,1,'the next request cannot start before stream EOF');
      assert.equal(s.readers,1,'root and aliases use one reader');
      s.close();
      const rejected=await first;assert.equal(rejected.error?.code,'UNVERIFIED_STREAM_ROUTE');
      const fresh=await second;assert.equal(fresh.error,undefined);assert.equal(fresh.value.content,'{"fresh":true}');
      assert.equal(f.calls.length,2,'only the separate queued request may add a call');
      assert.equal(s.stream.locked,false);
      for(const call of f.calls){assert.equal(call.mode,'otherAx');assert.equal(call.allowPlugins,true);assert.equal(Object.hasOwn(call,'staticModel'),false);}
      await f.assertNoCanon();
    }finally{s.close();await Promise.all([first,second]);await f.dispose();}
  });

  for(const failure of ['none','error','primitive'])test(`${owner} multiple distinct streams retain the queue until every stream settles (${failure})`,async()=>{
    const f=await fixture(owner),a=controlledStream(),b=controlledStream();let first,second;
    try{
      f.respond(async()=>f.calls.length===1?{type:'streaming',content:a.stream,result:b.stream}:{type:'success',result:'{"fresh":true}'});
      first=observed(f.call());await waitFor(()=>a.readers===1&&b.readers===1,'all stream readers');
      second=observed(f.call());if(failure==='none')a.close();else a.error(failure==='primitive'?'STREAM_FAILED':undefined);
      await pause(25);assert.equal(f.calls.length,1,'one completed or errored stream cannot release another active stream');
      b.close();
      const rejected=await first;assert.ok(rejected.error);
      if(failure==='error')assert.match(rejected.error.message,/STREAM_FAILED/);else assert.equal(rejected.error.code,'UNVERIFIED_STREAM_ROUTE');
      assert.equal((await second).value.content,'{"fresh":true}');
      assert.equal(f.calls.length,2);assert.equal(a.stream.locked,false);assert.equal(b.stream.locked,false);
      await f.assertNoCanon();
    }finally{a.close();b.close();await Promise.all([first,second]);await f.dispose();}
  });

  for(const reason of ['cancel','deadline'])test(`${owner} logical ${reason} leaves the physical queue held while a wrapped stream is open`,async()=>{
    const f=await fixture(owner),s=controlledStream(),abort=new AbortController();let first,second;
    try{
      f.respond(async()=>f.calls.length===1?{type:'streaming',result:s.stream}:{type:'success',result:'{"fresh":true}'});
      first=observed(f.call({signal:abort.signal,deadlineAt:Date.now()+(reason==='deadline'?100:5000)}));
      await waitFor(()=>s.readers===1,'physical stream acquisition');
      if(reason==='cancel')abort.abort();
      const abandoned=await first;assert.equal(abandoned.error?.code,reason==='cancel'?'OUTCOME_UNKNOWN_CANCELLED':'OUTCOME_UNKNOWN_TIMEOUT');
      second=observed(f.call());await pause(25);assert.equal(f.calls.length,1);
      s.close();assert.equal((await second).value.content,'{"fresh":true}');
      assert.equal(f.calls.length,2);assert.equal(s.stream.locked,false);await f.assertNoCanon();
    }finally{s.close();await Promise.all([first,second]);await f.dispose();}
  });

  test(`${owner} public probe reports a submitted unverified stream without committing memory`,async()=>{
    const f=await fixture(owner),s=controlledStream();let pending;
    try{
      f.respond(async()=>({type:'streaming',result:s.stream}));
      pending=f.probe();await waitFor(()=>s.readers===1,'public probe stream');s.close();
      const result=await pending;assert.equal(result.ok,false);assert.equal(result.submitted,true);assert.equal(result.responsePreview,'');
      assert.match(owner==='hayaku'?result.error?.message:result.error,/stream.*not verified/i);
      if(owner==='hayaku')assert.equal(result.error?.code,'UNVERIFIED_STREAM_ROUTE');
      assert.equal(f.calls.length,1);assert.equal(s.stream.locked,false);await f.assertNoCanon();
    }finally{s.close();await pending;await f.dispose();}
  });
}
