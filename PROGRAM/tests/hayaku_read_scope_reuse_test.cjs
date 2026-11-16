'use strict';
// Resolving the open chat's scope reads the whole character (every chat) and the chat from the
// host, twice when the reading is verified. The storage bridge asks for the scope on every
// storage operation, so one turn made about a hundred such reads (Android out-of-memory
// reports). Storage reads now share one resolution for a moment; writes, removals and
// management still resolve afresh, and a new request or committed output drops the shared answer.
const test=require('node:test'),assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const summary='The Aurora vault stores a silver spindle.';
const messages=Array.from({length:3},(_,i)=>[
 {role:'user',chatId:'u'+i,data:'Inspect the Aurora vault.'},
 {role:'assistant',chatId:'a'+i,data:hiddenPacketMessage(summary,createValidPacket({turn:i+1,subject:'Archivist',summary}))}
]).flat();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

const start=async()=>{
 // Expose the provider and its shared state from inside the plugin's closure.
 const marker='      runtime: () => clone(hayakuRuntimeSnapshot(), {}),';
 const transformSource=source=>{assert.equal(source.split(marker).length,2,'expose marker');
  return source.replace(marker,marker+'\n      __readScope: {provider:memorySuiteHayakuCurrentScope,shared:memorySuiteHayakuReadScope,invalidate:invalidateMemorySuiteHayakuReadScope,windowMs:HAYAKU_READ_SCOPE_REUSE_MS},');};
 const runtime=await createHayakuRuntime({messages,autoRepair:false,transformSource});
 const reads={character:0};
 for(const name of ['getCharacter','getChar','getCharacterFromIndex'])if(typeof runtime.host[name]==='function'){
  const real=runtime.host[name].bind(runtime.host);runtime.host[name]=async(...args)=>{reads.character++;return real(...args);};
 }
 const handle=runtime.hayaku.__readScope;
 assert.ok(handle,'the read-scope handle is exposed');
 const provider=request=>handle.provider(request);
 const shared=()=>({at:handle.shared.at,hasValue:!!handle.shared.value,reused:handle.shared.reused,joined:handle.shared.joined,resolved:handle.shared.resolved,generation:handle.shared.generation});
 await pause(400);handle.invalidate();
 return {runtime,reads,provider,shared,windowMs:handle.windowMs};
};

test('a burst of read resolutions reads the host once; each write resolves afresh',async()=>{
 const {runtime,reads,provider,shared}=await start();
 try{
  let before=reads.character;
  const first=await provider({intent:'read'});
  assert.ok(first?.scopeId,'the open chat resolves');
  const one=reads.character-before;
  assert.ok(one>=1,'a resolution reads the host');
  before=reads.character;
  for(let i=0;i<10;i++)assert.equal((await provider({intent:'read'})).scopeId,first.scopeId);
  assert.equal(reads.character-before,0,'ten more reads inside the window add no host read');
  assert.ok(shared().reused>=10);

  // No intent, a write intent, or force: never the shared answer.
  for(const request of [{},{intent:'write'},{intent:'read',force:true}]){
   before=reads.character;
   assert.equal((await provider(request)).scopeId,first.scopeId);
   assert.equal(reads.character-before,one,'resolved afresh: '+JSON.stringify(request));
  }

  // Callers get their own copy: changing one answer cannot change the next.
  const mine=await provider({intent:'read'});mine.scopeId='tampered';mine.aliases.push('tampered');
  const next=await provider({intent:'read'});
  assert.equal(next.scopeId,first.scopeId);assert.ok(!next.aliases.includes('tampered'));
 }finally{await runtime.dispose();}
});

test('reads that arrive together share one host read, and the answer expires',async()=>{
 const {runtime,reads,provider,shared,windowMs}=await start();
 try{
  const before=reads.character,joinedBefore=shared().joined;
  const answers=await Promise.all(Array.from({length:8},()=>provider({intent:'read'})));
  assert.equal(new Set(answers.map(row=>row.scopeId)).size,1);
  const single=reads.character-before;
  assert.ok(shared().joined-joinedBefore>=7,'seven callers joined the first read');
  const window=windowMs;
  assert.ok(window>0&&window<=250,'the reuse window stays short: '+window);
  await pause(window+60);
  const again=reads.character;
  await provider({intent:'read'});
  assert.equal(reads.character-again,single,'after the window the host is read again');
 }finally{await runtime.dispose();}
});

test('a new request drops the shared answer, and a turn stays within its host-read budget',async()=>{
 const {runtime,reads,provider,shared}=await start();
 try{
  await provider({intent:'read'});
  assert.equal(shared().hasValue,true);
  const generation=shared().generation,before=reads.character;
  const output=await runtime.callBeforeRequest([{role:'user',content:'What is inside the Aurora vault?'}],'model');
  assert.ok(shared().generation>generation,'the request invalidated the shared answer');
  assert.ok(output.some(row=>row.memo==='hayaku-runtime-context-v3'&&String(row.content).includes('silver spindle')),'recall still works');
  const turn=reads.character-before;
  // Measured on this fixture: 119 full-character reads before the reuse, 19 after.
  assert.ok(turn<=30,'full-character reads in one request: '+turn);
 }finally{await runtime.dispose();}
});
