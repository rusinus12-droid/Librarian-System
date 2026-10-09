'use strict';
// Actual registered LIBRA output -> verified SQLite raw -> fixture Micro
// analysis -> durable Micro/head projection. Fixture delay is not model time.
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const GOLD='Mara put one brass key in the west alcove. Evidence brass-key-731.';
const SHA=x=>crypto.createHash('sha256').update(x).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function sourceMessages(n,counter){
  const rows=[];
  for(let turn=1;turn<=n;turn++)for(const role of ['user','assistant']){
    let body=`${role} archive turn ${turn}: The north archive contains ledger item ${turn}.`;
    const row={role,chatId:`scale-t${turn}-${role[0]}`};
    Object.defineProperty(row,'data',{enumerable:true,get(){counter.reads++;counter.chars+=body.length;return body;},set(v){body=String(v);}});rows.push(row);
  }
  return rows;
}
async function sample(turns,repetition){
  let listener;
  const fx=await serverFixture({mode:'server_only',host:{addRisuChatListener:async(kind,fn)=>{if(kind==='output')listener=fn;return true;}}});
  try{
    const f=fx.f,counter={reads:0,chars:0},io={reads:0,writes:0,writeBytes:0,writesBySchema:{},maxValueBytes:0};
    f.chat.message=sourceMessages(turns,counter);f.chat.messages=f.chat.message;
    const user='Where should this one brass key be put?';
    f.chat.message.push({role:'user',chatId:`scale-added-${turns}-u`,data:user},
      {role:'assistant',chatId:`scale-added-${turns}-a`,data:GOLD});
    let analysisStart=0,analysisFinish=0;
    f.control.onCall=async args=>{
      analysisStart=performance.now();const input=JSON.parse(args[0].messages[1].content);
      assert.equal(input.binding.turn,turns+1);assert.equal(input.assistant.text,GOLD);
      const physical=fx.getRecords('libra.completed_turn_receipt.v1').find(row=>row.key===input.rawPacketRef?.storageKey)?.value;
      assert.ok(physical?.rawSourcePacket,'fixture consumes the production physical raw reference before analysis');
      assert.equal(input.rawPacketRef.packetDigest,physical.rawSourcePacket.packetDigest);
      const {packetDigest,...body}=physical.rawSourcePacket;assert.equal(SHA(JSON.stringify(body)),packetDigest);
      assert.equal(physical.rawSourcePacket.user.segments[0].rawValue,user);
      assert.equal(physical.rawSourcePacket.assistant.segments[0].rawValue,GOLD);
      await sleep(20);analysisFinish=performance.now();
      return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},
        micro:{schema:'libra.micro_memory.v1',...input.binding,claims:[{changeKind:'event',text:GOLD,actor:'',target:'',
          temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'none',
          evidence:{role:'assistant',messageId:input.assistant.messageId,startOffset:0,endOffset:GOLD.length,exactQuote:GOLD}}]}})};
    };
    fx.hooks.beforeServerRequest=async(url,init)=>{
      if(init?.method==='POST'&&url.endsWith('/v1/kv/set')){
        const body=JSON.parse(init.body);io.writes++;io.writeBytes+=Buffer.byteLength(init.body);
        let value;try{value=JSON.parse(body.value);}catch{value=body.value;}
        const schema=value?.schema||'untyped';io.writesBySchema[schema]=(io.writesBySchema[schema]||0)+1;
        io.maxValueBytes=Math.max(io.maxValueBytes,Buffer.byteLength(JSON.stringify(value)));
      }else if(!init?.method||init.method==='GET')io.reads++;
    };
    const before=f.r.api.getPairRevisionCacheDiagnostics().stats;
    counter.reads=0;counter.chars=0;
    const started=performance.now();listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:f.chat.message.length-1});
    const callbackReturnMs=performance.now()-started;
    await waitFor(()=>f.r.api.getCaptureBackendState().lastOutputCapture?.turn===turns+1&&f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus==='verified',60000);
    const rawAckMs=performance.now()-started,capture=f.r.api.getCaptureBackendState().lastOutputCapture;
    assert.equal(capture.rawDurable,true,'durable ACK includes the physical original packet, not just sanitized text');
    const atAck={sourceReads:counter.reads,sourceChars:counter.chars,io:JSON.parse(JSON.stringify(io)),backlog:f.r.api.getCaptureBackendState().microQueuedJobs??null};
    await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.turn===turns+1,90000);
    const memoryReadyMs=performance.now()-started,publication=f.r.api.getCaptureBackendState().lastMicroPublication;
    assert.equal(publication.status,'verified','actual final source-bound publication must pass');
    const atReady={sourceReads:counter.reads,sourceChars:counter.chars,io:JSON.parse(JSON.stringify(io)),backlog:f.r.api.getCaptureBackendState().microQueuedJobs??null};
    const after=f.r.api.getPairRevisionCacheDiagnostics().stats;
    const raw=fx.getRecords('libra.completed_turn_receipt.v1').find(row=>row.value.turn===turns+1)?.value;
    const memory=await f.r.api.debugReadActiveMicroMemory(turns+1);
    assert.equal(raw.user.text,user);assert.equal(raw.assistant.text,GOLD);
    assert.equal(raw.rawSourcePacket.user.segments[0].utf8Sha256,SHA(user));
    assert.equal(raw.rawSourcePacket.assistant.segments[0].utf8Sha256,SHA(GOLD));
    assert.equal(raw.completionProvenance,'validated_completed_pair');
    assert.equal(memory.status,'verified');assert.equal(memory.record.sourceDigest,raw.sourceDigest);
    assert.equal(memory.record.sourceRevisionId,raw.revisionId);assert.equal(memory.record.claims[0].evidence.exactQuote,GOLD);
    assert.equal(memory.record.claims[0].evidence.messageId,raw.assistant.chatId);
    assert.equal(memory.record.claims[0].evidence.endOffset,GOLD.length);
    assert.equal(memory.head.recallProjection.sourceRevisionId,raw.revisionId);
    assert.equal(memory.head.recallProjection.analysisRevisionId,memory.record.analysisRevisionId);
    assert.match(memory.head.recallProjection.searchText,/brass-key-731/);
    assert.equal(f.control.calls.length,1,'one fixed fixture analysis for the new one-turn memory');
    assert.equal(fx.requests.filter(r=>!r.url.startsWith(fx.url+'/')).length,0,'no real model or embedding route');
    const result={turns,repetition,newTurn:turns+1,callbackReturnMs,rawAckMs,
      receiptQueueWaitMs:capture.receiptMetrics?.queueWaitMs??null,
      memoryQueueWaitMs:publication.queueMetrics?.queueWaitMs??null,
      analysisStartMs:analysisStart-started,fixtureAnalysisMs:analysisFinish-analysisStart,memoryReadyMs,
      lexicalProjectionReadyMs:memoryReadyMs,embeddingReady:'NOT_MEASURED',atAck,atReady,
      pairCacheDelta:Object.fromEntries(['hits','misses','invalidations','pairBuilds','pairReuses'].map(k=>[k,(after[k]||0)-(before[k]||0)])),
      raw:{userUtf8Sha256:SHA(user),assistantUtf8Sha256:SHA(GOLD),revisionId:raw.revisionId,sourceDigest:raw.sourceDigest,
        provenance:raw.completionProvenance,turn:raw.turn,worldlineId:raw.worldlineId,
        packetDigest:raw.rawSourcePacket.packetDigest,rawPacketRef:raw.rawPacketRef,rawDurable:capture.rawDurable},
      exactQuote:true,staleExposed:0,fixtureCalls:f.control.calls.length,realModelCalls:0,
      fullRawValidationRetained:true,corpusHasHistoricalRawOnly:true};
    console.log(JSON.stringify({sample:result}));return result;
  }finally{await fx.cleanup();}
}
function stats(values){const v=[...values].sort((a,b)=>a-b),p=q=>v[Math.min(v.length-1,Math.ceil(q*v.length)-1)];return {n:v.length,p50:p(.5),p95:p(.95),max:v.at(-1),min:v[0]};}
(async()=>{
  if(process.env.LIBRA_CAPTURE_BENCH_OUTPUT&&require('node:path').basename(process.env.LIBRA_CAPTURE_BENCH_OUTPUT)===process.env.RECOVERY_TEST_LABEL+'.json')
    throw Error('Use a distinct -results.json benchmark artifact path; runner metadata owns label.json');
  const scales=(process.env.LIBRA_CAPTURE_SCALES||'10,100,1000,2000').split(',').map(Number),repetitions=Number(process.env.LIBRA_CAPTURE_REPETITIONS||3),samples=[];
  for(const n of scales)for(let r=1;r<=repetitions;r++)samples.push(await sample(n,r));
  const report={schema:'libra.capture.scale.measurement.v1',at:new Date().toISOString(),
    sourceSha256:SHA(fs.readFileSync(process.env.LIBRA_TEST_PLUGIN||require('node:path').join(__dirname,'../plugins/LIBRA.js'))),
    scope:'one added memory into current raw history; actual local SQLite; fresh VM/server per repetition',
    caveats:['historical corpus contains raw source rows, not pre-created memories','20 ms fixture delay is not measured model wait','callback return excludes asynchronous durable ack','raw validation still reads full current history','lexical projection is durable Micro head projection, not vector readiness','I/O counts product HTTP storage requests/payloads, not OS disk latency'],
    realModelCalls:0,embeddingDimension:'NOT_MEASURED',samples,
    summary:scales.map(turns=>({turns,callbackReturnMs:stats(samples.filter(x=>x.turns===turns).map(x=>x.callbackReturnMs)),
      rawAckMs:stats(samples.filter(x=>x.turns===turns).map(x=>x.rawAckMs)),
      memoryReadyMs:stats(samples.filter(x=>x.turns===turns).map(x=>x.memoryReadyMs))}))};
  if(process.env.LIBRA_CAPTURE_BENCH_OUTPUT)fs.writeFileSync(process.env.LIBRA_CAPTURE_BENCH_OUTPUT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({report}));
})().catch(error=>{console.error(error);process.exitCode=1;});
