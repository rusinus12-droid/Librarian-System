'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const {serverFixture}=require(path.join(root,'PROGRAM/tests/fixtures/libra_server_runtime_fixture.cjs'));
const {createLibraVmHarness,waitFor}=require(path.join(root,'PROGRAM/tests/fixtures/libra_vm_harness.cjs'));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
// Observe the exact server entry being borrowed, rather than a process-wide hit
// counter which an unrelated background read could also advance.
const expose=s=>s.replace('verifiedReadStats.coalesced++; return existing.operation;',
 'verifiedReadStats.coalesced++; (globalThis.__joinedFlightEvents ||= []).push({key:storageKey,entry:existing}); return existing.operation;')
 .replace('    const stateDerivedWorldlineSuffix =',`    globalThis.__flightReview={storage,stats:verifiedReadStats,flights:verifiedReadFlights,local:readVerifiedLocalRow,
      events:()=>globalThis.__joinedFlightEvents||[],
      age:()=>{for(const row of verifiedReadFlights.values())row.at-=VERIFIED_READ_CACHE_TTL_MS;},
      async fresh(key,scope){freshReadDepth++;try{return await storage.getVerifiedJson(key,scope);}finally{freshReadDepth--;}}};
    const stateDerivedWorldlineSuffix =`);
function holdResponse(s,enabled,keyMatches){
 const original=globalThis.fetch,gate=deferred();let observation=null;
 globalThis.fetch=async(url,init)=>{
  const response=await original(url,init);
  if(!observation&&enabled()&&String(url).startsWith(s.url)&&String(url).endsWith('/v1/kv/get-many')){
   const body=JSON.parse(init.body),key=body.keys.find(keyMatches);
   if(key){const payload=await response.clone().json();assert.ok(payload.result.values[key]);observation={key,row:payload.result.values[key]};await gate.promise;}
  }
  return response;
 };
 return {get observation(){return observation;},release:()=>gate.resolve(),restore(){gate.resolve();globalThis.fetch=original;}};
}
async function publishMicro(s,listener,{state=false}={}){
 const f=s.f,quote=state?'도서관 문이 열렸다.':'민아가 은빛 열쇠를 준호에게 잠시 건넸다.';
 f.chat.message.push({role:'user',chatId:'t6-u',data:'현재 상황을 확인한다.'},{role:'assistant',chatId:'t6-a',data:quote});f.chat.messages=f.chat.message;
 f.control.onCall=async args=>{const input=JSON.parse(args[0].messages[1].content);return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',...input.binding,
  claims:[{changeKind:'world',text:quote,actor:'',target:state?'도서관':'은빛 열쇠',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:state?'set':'none',
   ...(state?{stateIntent:{domain:'world',target:{entityName:'도서관'},field:'doorStatus',operation:'set',value:'열렸다'}}:{}),
   evidence:{role:'assistant',messageId:input.assistant.messageId,startOffset:0,endOffset:quote.length,exactQuote:quote}}]}})};};
 listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:f.chat.message.length-1});
}
test('native: a read joining after external mutation can share the prior observation, then fresh reads see the edit',async t=>{
 const key='libra:v1:scope:flight-review:source-receipt-head:w:e0:t1',values=new Map([[key,'{"n":1}']]),gate=deferred();let held=false,reads=0;
 const backend={async getItem(k){const raw=values.get(k)??null;if(k===key){reads++;if(!held){held=true;await gate.promise;}}return raw;},async setItem(k,v){values.set(k,v);return true;},async removeItem(k){values.delete(k);return true;},async keys(){return [...values.keys()];}};
 const r=await createLibraVmHarness({}, {pluginStorage:backend,safeLocalStorage:backend,getLocalPluginStorage:async()=>backend},{transformSource:expose});
 t.after(async()=>{gate.resolve();await r.cleanup();});const c=r.context.__flightReview,scope={_cachedMode:'plugin_only'};
 const first=c.storage.getVerifiedJson(key,scope);await waitFor(()=>held);values.set(key,'{"n":2}');
 const second=c.storage.getVerifiedJson(key,scope);await waitFor(()=>c.stats.coalesced>0);assert.equal(reads,1);gate.resolve();
 assert.equal((await first).n,1);assert.equal((await second).n,1);assert.equal((await c.fresh(key,scope)).n,2);
});
for(const mode of ['server_only','mirror'])test(mode+': a post-external-write flight join cannot publish a Micro from the old revision',async t=>{
 let listener;
 const s=await serverFixture({mode,host:{addRisuChatListener:async(_k,fn)=>{listener=fn;return true;}},transformSource:source=>expose(source)
  .replace('      const active = await activeMicroSource(receipt);\n      if (!active || active.receiptKey !== receiptKey)',
   '      globalThis.__publishFlightStage=true;\n      const active = await activeMicroSource(receipt);\n      if (!active || active.receiptKey !== receiptKey)')
  .replace('    const prepareMicroStageClaim =',`    globalThis.__flightReview.persist=persistMicroRevision;
    globalThis.__flightReview.digest=digest;globalThis.__flightReview.generation=()=>Number(state.microRestoreGeneration||0);
    const prepareMicroStageClaim =`)});
 let hold,pending;t.after(async()=>{hold?.restore();await pending?.catch(()=>{});await s.cleanup();});const f=s.f;assert.equal((await f.run()).completed,1);
 const c=f.r.context.__flightReview,scope={_cachedMode:mode};
 await publishMicro(s,listener);await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.turn===6,15000);await new Promise(r=>setTimeout(r,150));
 const work=s.getRecords('libra.micro_work.v1').find(r=>r.value.turn===6),receipt=s.getRecords('libra.completed_turn_receipt.v1').find(r=>r.value.turn===6);
 assert.equal(work.value.status,'result_ready');
 const beforeRows=s.storedRows().filter(r=>r.value?.turn===6&&(r.key.includes(':micro-memory:')||r.key.includes(':micro-memory-head:'))).map(r=>({key:r.key,raw:r.raw,revision:r.revision}));
 f.r.context.__publishFlightStage=false;
 hold=holdResponse(s,()=>f.r.context.__publishFlightStage===true,key=>key.includes(':source-receipt-head:')&&key.endsWith(':t6'));
 const publication=pending=c.persist(receipt.value,receipt.key,work.value.result,work.key,{attemptId:work.value.attemptId,workDigest:c.digest(work.value),restoreGeneration:c.generation()});
 await waitFor(()=>hold.observation,15000);const {key}=hold.observation;
 const heldFlight=[...c.flights].find(([k])=>k.endsWith('\u0000'+key)&&!k.includes('\u0000local\u0000'))?.[1];
 assert.ok(heldFlight,'hold occurs after source pin capture, inside the actual shared helper');
 const original=s.storedRows().find(r=>r.key===key);await s.mutate(key,{...original.value,externalAfterObservation:true});
 if(mode==='mirror')s.local.set(key,JSON.stringify({...original.value,externalAfterObservation:true}));
 const before=c.events().length,second=c.storage.getVerifiedJson(key,scope).then(value=>({value}),error=>({error}));
 await waitFor(()=>c.events().slice(before).some(event=>event.key===key&&event.entry===heldFlight));
 hold.release();const joined=await second;
 if(mode==='mirror')assert.match(joined.error?.message||'',/LIBRA_VERIFIED_STORAGE_VALUE_MISMATCH/,'fresh local bytes reject the older server observation');
 else assert.equal(joined.value.externalAfterObservation,undefined,'late join really borrowed the older observation');
 const result=await publication;assert.equal(result.status,'stale_source');assert.equal(result.reason,'micro_publication_basis_changed');
 assert.deepEqual(s.storedRows().filter(r=>beforeRows.some(b=>b.key===r.key)).map(r=>({key:r.key,raw:r.raw,revision:r.revision})),beforeRows,'original producer record and Head are not republished');
 assert.equal((await c.fresh(key,scope)).externalAfterObservation,true);
});
for(const mode of ['server_only','mirror'])test(mode+': State admission rejects the old Head borrowed across an external write',async t=>{
 let listener;const s=await serverFixture({mode,host:{addRisuChatListener:async(_k,fn)=>{listener=fn;return true;}},transformSource:expose});
 let hold,pending;t.after(async()=>{hold?.restore();await pending?.catch(()=>{});await s.cleanup();});const f=s.f;assert.equal((await f.run()).completed,1);
 await publishMicro(s,listener,{state:true});await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.turn===6,15000);
 const initial=await f.r.api.debugAdmitActiveMicroStateClaim(6,0);assert.equal(initial.status,'admitted',JSON.stringify(initial));await new Promise(r=>setTimeout(r,150));
 const c=f.r.context.__flightReview,scope={_cachedMode:mode},key=s.getRecords('libra.continuity_state.v2')[0].key;
 hold=holdResponse(s,()=>true,k=>k===key);
 const admission=pending=f.r.api.debugAdmitActiveMicroStateClaim(6,0);await waitFor(()=>hold.observation,15000);
 const heldFlight=[...c.flights].find(([k])=>k.endsWith('\u0000'+key)&&!k.includes('\u0000local\u0000'))?.[1];assert.ok(heldFlight);
 const original=s.getHead(),changed={...original,externalAfterObservation:true};await s.mutate(key,changed);if(mode==='mirror')s.local.set(key,JSON.stringify(changed));
 const before=c.events().length,second=c.storage.getVerifiedJson(key,scope).then(value=>({value}),error=>({error}));
 await waitFor(()=>c.events().slice(before).some(event=>event.key===key&&event.entry===heldFlight));
 hold.release();const joined=await second;
 if(mode==='mirror')assert.match(joined.error?.message||'',/LIBRA_VERIFIED_STORAGE_VALUE_MISMATCH/);else assert.equal(joined.value.externalAfterObservation,undefined);
 const result=await admission;assert.equal(result.status,'stale_basis');assert.equal(result.reason,'state_basis_changed_after_admission');
 assert.deepEqual(s.getHead(),changed,'State approval did not overwrite the externally changed Head');
 const checked=await f.r.api.debugReadCurrentMicroStateAdmission(6,0);
 if(checked.status==='admitted')assert.notEqual(checked.decision.basisDigest,initial.decision.basisDigest,'a later valid admission must bind the newly observed Head');
});
test('native saturation: expired different-key flights release admission and late cleanup preserves a new flight',async t=>{
 const gates=[],prefix='libra:v1:scope:flight-full:',fresh=prefix+'new-key',freshGate=deferred();let oldReads=0,freshReads=0;
 const backend={async getItem(key){if(key.startsWith(prefix)&&key!==fresh){oldReads++;const gate=deferred();gates.push(gate);await gate.promise;}if(key===fresh){freshReads++;await freshGate.promise;}return null;},async setItem(){return true;},async removeItem(){return true;},async keys(){return [];}};
 const r=await createLibraVmHarness({}, {pluginStorage:backend,safeLocalStorage:backend,getLocalPluginStorage:async()=>backend},{transformSource:expose});
 t.after(async()=>{freshGate.resolve();for(const gate of gates)gate.resolve();await r.cleanup();});const c=r.context.__flightReview;
 const pending=Array.from({length:256},(_,i)=>c.local(prefix+i,'test-binding',0));await waitFor(()=>oldReads===256);
 c.age();assert.equal(c.flights.size,256);
 const a=c.local(fresh,'test-binding',0),b=c.local(fresh,'test-binding',0);await waitFor(()=>freshReads>=1);
 assert.equal(freshReads,1,'new keys regain same-flight sharing after a full registry expires');
 assert.equal(c.flights.size,1);assert.equal(c.stats.flightExpirations,256);assert.equal(c.stats.flightFallbacks,0);
 for(const gate of gates)gate.resolve();await Promise.all(pending);
 assert.equal(c.flights.size,1,'late cleanup of old keys cannot remove the new pending flight');
 const third=c.local(fresh,'test-binding',0);assert.equal(freshReads,1);
 freshGate.resolve();await Promise.all([a,b,third]);assert.equal(c.flights.size,0);
});
