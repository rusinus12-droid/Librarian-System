'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {test}=require('node:test'),{serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs'),{waitFor}=require('./fixtures/libra_vm_harness.cjs');
const sourcePath=process.env.LIBRA_TEST_PLUGIN||path.join(__dirname,'../plugins/LIBRA.js'),source=fs.readFileSync(sourcePath,'utf8');
const a=source.indexOf('  const createTextHasher = () => {'),z=source.indexOf('\n  };',a)+5,b=source.indexOf('    const digest = value => {'),q=source.indexOf('\n    };',b)+7;
assert.ok(a>0&&z>a&&b>0&&q>b);const ctx=vm.createContext({});vm.runInContext(source.slice(a,z)+'\n'+source.slice(b,q)+'\nthis.digest=digest;',ctx);
const digest=ctx.digest,sha=x=>crypto.createHash('sha256').update(x).digest('hex'),clone=x=>JSON.parse(JSON.stringify(x));
const seam=source=>source.replace('    const executeUnifiedStage = async (stageName,batch,previousStage=null,options={}) => {',
  '    const executeUnifiedStage = async (stageName,batch,previousStage=null,options={}) => {\n      await globalThis.__exactRefSetup?.();');
function findRealPacketRefCollision(packet,refs){
  const template=clone(packet);delete template.packetDigest;const base={...refs[4],storageKey:refs[4].storageKey.replace(':source-receipt:',':source-receipt-capture:')},seen=new Map();
  const segment=template.assistant.segments.find(row=>row.contributesText===false);assert.ok(segment,'actual source packet contains archived carrier');
  for(let i=0;i<250000;i++){
    const carrier='<lb-stage-marker>'+String(i).padStart(8,'0')+'</lb-stage-marker>';
    segment.rawValue=carrier;segment.rawPayloadDigest=digest({type:'string',value:carrier});segment.utf8ByteLength=Buffer.byteLength(carrier);segment.utf8Sha256=sha(carrier);
    const packetDigest=sha(JSON.stringify(template)),ref={...base,field:'rawSourceVariants.'+packetDigest,packetDigest};
    const candidateRefs=[...refs.slice(0,4),ref],signature=digest(candidateRefs),previous=seen.get(signature);
    if(previous&&previous.ref.packetDigest!==packetDigest)return {first:previous,second:{carrier,ref},signature};
    seen.set(signature,{carrier,ref});
  }
  throw Error('Bounded real packet collision search exhausted');
}
for(const phase of ['provider_result','candidate_write'])test(`new tag-only SHA packet refs with equal old digest preserve consumed provenance after ${phase}`,async()=>{
  let listener,collision,refsA,refsB,changed=false;
  const fx=await serverFixture({mode:'plugin_only',transformSource:seam,host:{addRisuChatListener:async(k,fn)=>{if(k==='output')listener=fn;return true;}}});
  try{
    fx.f.chat.message.splice(9,0,{role:'assistant',chatId:'exact-ref-carrier',data:'<lb-stage-marker>INITIAL</lb-stage-marker>'});
    const event=()=>({char:fx.f.character,chat:fx.f.chat,characterIndex:0,chatIndex:0,messageIndex:10});
    const capture=async item=>{
      fx.f.chat.message[9].data=item.carrier;listener(event());
      await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable===true
        &&fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawVariantId===item.ref.packetDigest,10000);
      const active=await fx.f.r.api.debugReadActiveRawPacket(5);assert.equal(active.status,'verified');
      assert.equal(JSON.stringify(active.rawPacketRef),JSON.stringify(item.ref),'collision uses real production refs, not substituted reader results');
      const {packetDigest,...body}=active.packet;assert.equal(sha(JSON.stringify(body)),packetDigest);return active;
    };
    fx.f.r.context.__exactRefSetup=async()=>{
      const refs=[];for(let turn=1;turn<=5;turn++)refs.push((await fx.f.r.api.debugReadActiveRawPacket(turn)).rawPacketRef);
      collision=findRealPacketRefCollision((await fx.f.r.api.debugReadActiveRawPacket(5)).packet,refs);
      await capture(collision.first);refsA=[...refs.slice(0,4),collision.first.ref];refsB=[...refs.slice(0,4),collision.second.ref];
      assert.notEqual(JSON.stringify(refsA),JSON.stringify(refsB));assert.equal(digest(refsA),digest(refsB));
    };
    const change=async()=>{assert.equal(changed,false);changed=true;await capture(collision.second);
      assert.equal(digest(refsA),digest(refsB));};
    fx.f.control.onCall=async args=>{
      const match=String(args[0].messages[1].content).match(/\[VERIFIED ORIGINAL PACKET REFS\]\n([^\n]+)/);assert.ok(match);
      assert.equal(JSON.stringify(JSON.parse(match[1])),JSON.stringify(refsA));
      if(phase==='provider_result')await change();return {type:'success',result:JSON.stringify(fx.f.control.artifact)};
    };
    if(phase==='candidate_write'){
      const set=fx.backend.setItem;fx.backend.setItem=async(k,v)=>{const result=await set(k,v);let record;try{record=JSON.parse(v);}catch{return result;}
        if(!changed&&record?.schema==='libra.canonical_memory.v1'&&record.status==='candidate')await change();return result;};
    }
    const result=await fx.f.run();if(!changed)console.log(JSON.stringify({setupFailure:result,lastCapture:fx.f.r.api.getCaptureBackendState().lastOutputCapture,hasCollision:!!collision}));
    assert.equal(changed,true,'different valid raw variant was admitted through registered capture');
    assert.equal(fx.f.control.calls.length,1,'one consumed fixture invocation; no automatic analysis retry');
    const manifests=[...fx.local].filter(([k])=>k.endsWith(':manifest')).map(([,v])=>JSON.parse(v));
    const activeCandidate=manifests.some(m=>Object.keys(m.memories||{}).length>0);
    console.log(JSON.stringify({phase,resultCompleted:result.completed,activeCandidate,oldDigest:digest(refsA),newDigest:digest(refsB),
      oldPacketDigest:refsA[4].packetDigest,newPacketDigest:refsB[4].packetDigest,actualFixtureCalls:fx.f.control.calls.length,realModelCalls:0}));
    assert.equal(result.completed,1,'a newer tag-only capture does not cancel unchanged analysis input');
    assert.equal(activeCandidate,true,'verified analysis commits while retaining its original consumed capture');
    const committed=manifests.find(m=>Object.keys(m.memories||{}).length>0).memories['1'];
    const memory=JSON.parse(fx.local.get(committed.key));
    assert.deepEqual(memory.rawPacketRefs,clone(refsA),'exact original SHA refs remain the analysis provenance, never the colliding new active refs');
    assert.notDeepEqual(memory.rawPacketRefs,clone(refsB),'colliding later active refs must not replace exact consumed provenance');
    assert.equal((await fx.f.r.api.debugReadActiveRawPacket(5)).rawPacketRef.packetDigest,refsB[4].packetDigest);
  }finally{await fx.cleanup();}
});
for(const failure of ['missing','unreadable','unreadable_reload'])test(`raw-rejected candidate cannot publish when durable manifest is ${failure}`,async()=>{
  const fx=await serverFixture({mode:'plugin_only',transformSource:source=>source.replace("          let durable=null,reloadError='';",
    "          await globalThis.__manifestReloadTestHook?.();\n          let durable=null,reloadError='';")});
  try{const set=fx.backend.setItem,get=fx.backend.getItem;let rejected=false,manifestWrites=0,manifestKey,prior,reloadStarted=false;
    fx.f.r.context.__manifestReloadTestHook=()=>{reloadStarted=true;};
    fx.backend.getItem=async k=>{if(rejected&&k===manifestKey&&(failure==='unreadable'||failure==='unreadable_reload'&&reloadStarted))throw Error('fixture_manifest_read_failure');return get(k);};
    fx.backend.setItem=async(k,v)=>{
      if(rejected&&k.endsWith(':manifest'))manifestWrites++;
      const result=await set(k,v);let memory;try{memory=JSON.parse(v);}catch{return result;}
      if(!rejected&&memory?.schema==='libra.canonical_memory.v1'&&memory.status==='candidate'){
        rejected=true;const ref=memory.rawPacketRefs[0],record=JSON.parse(fx.local.get(ref.storageKey));
        record.rawSourcePacket.assistant.segments[0].rawValue+='LATE_RAW_REJECTION';fx.local.set(ref.storageKey,JSON.stringify(record));
        manifestKey=[...fx.local.keys()].find(k=>k.endsWith(':manifest'));assert.ok(manifestKey);prior=fx.local.get(manifestKey);
        if(failure==='missing')fx.local.delete(manifestKey);
      }return result;
    };
    const result=await fx.f.run();assert.equal(rejected,true);assert.equal(result.completed,0);assert.equal(fx.f.control.calls.length,1);
    const active=[...fx.local].filter(([k])=>k.endsWith(':manifest')).some(([,v])=>Object.keys(JSON.parse(v).memories||{}).length>0);
    console.log(JSON.stringify({failure,completed:result.completed,active,manifestWrites,realModelCalls:0}));
    assert.equal(active,false,'unavailable durable state cannot authorize rejected candidate reuse');assert.equal(manifestWrites,0,'failure diagnostics never publish an unknown manifest');
    assert.equal(fx.local.get(manifestKey),failure==='missing'?undefined:prior);
    if(failure==='unreadable_reload')assert.equal(reloadStarted,true,'actual raw rejection reached the physical durable reload before injected read failure');
    const records=[...fx.local.values()].filter(v=>typeof v==='string').map(v=>{try{return JSON.parse(v);}catch{return null;}});
    assert.ok(records.some(v=>v?.schema==='libra.canonical_memory.v1'&&v.rawPacketRefs?.length===5),'rejected memory row and analysis provenance remain available without an active pointer');
    assert.ok(records.some(v=>v?.schema==='libra.memory_work.v1'&&v.status==='failed'&&v.lastError),'failed work diagnostics remain durable');
    assert.ok(records.some(v=>v?.schema==='libra.execution_run.v1'&&v.status==='failed'&&v.errors?.length),'failed invocation diagnostics remain durable');
    assert.ok(records.some(v=>v?.schema==='libra.canonical_job.v1'&&v.state==='failed'&&v.failures?.length),'failed public job diagnostics remain durable');
    if(failure==='missing'){
      await assert.rejects(()=>fx.f.r.api.listCanonicalBatchRanges(),/durable basis unavailable/);
      assert.equal(manifestWrites,0,'a requested read/retry cannot manufacture a durable basis');
      await set(manifestKey,'{}');
      await assert.rejects(()=>fx.f.r.api.listCanonicalBatchRanges(),/durable basis unavailable/);
      const foreign={...JSON.parse(prior),scopeKey:'foreign-untrusted-owner'};await set(manifestKey,JSON.stringify(foreign));
      await assert.rejects(()=>fx.f.r.api.listCanonicalBatchRanges(),/durable basis unavailable/);
      await set(manifestKey,prior);const recovered=await fx.f.r.api.listCanonicalBatchRanges();
      assert.equal(recovered.scopeKey,JSON.parse(prior).scopeKey,'only physically verified same-owner state restores the read basis');
      assert.equal(fx.local.get(manifestKey),prior);assert.equal(manifestWrites,0);assert.equal(fx.f.control.calls.length,1);
    }
  }finally{await fx.cleanup();}
});
