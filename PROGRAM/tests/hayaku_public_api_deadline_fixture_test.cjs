'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const {waitFor,createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
const block=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
test('publication within the deadline remains eligible after a delayed poll',async()=>{
  let ready=false,publishedAt=null;const started=Date.now();
  const waiting=waitFor(()=>ready,'timely API',50,()=>publishedAt);
  setTimeout(()=>{ready=true;publishedAt=Date.now();block(80);},1);
  assert.equal(await waiting,true);
  assert(publishedAt-started<50,'the API must be published within the deadline');
});
test('publication after the deadline remains a timeout after a delayed poll',async()=>{
  let ready=false,publishedAt=null;const started=Date.now();
  const waiting=waitFor(()=>ready,'late API',50,()=>publishedAt);
  setTimeout(()=>{block(80);ready=true;publishedAt=Date.now();},1);
  await assert.rejects(waiting,/Timed out waiting for late API/);
  assert(publishedAt-started>50,'this control must publish late');
});
test('missing publication remains a timeout',async()=>{
  await assert.rejects(waitFor(()=>false,'absent API',30,()=>null),/Timed out waiting for absent API/);
});
test('an API removed during the block is not returned from its old publication',async()=>{
  let ready=false,publishedAt=null;
  const waiting=waitFor(()=>ready,'removed API',50,()=>publishedAt);
  setTimeout(()=>{ready=true;publishedAt=Date.now();block(80);ready=false;},1);
  await assert.rejects(waiting,/Timed out waiting for removed API/);
});
test('the runtime fixture records actual HAYAKU publication with its unchanged 15s deadline',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hayaku-public-api-deadline-'));
  const file=path.join(dir,'timely-plugin.js');
  fs.writeFileSync(file,'setTimeout(()=>{globalThis.HAYAKU={ready:true};const until=Date.now()+15020;while(Date.now()<until){};},1);');
  const h=await createHayakuRuntime({pluginSourceFile:file});
  try{assert.equal(h.hayaku.ready,true);assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);}finally{await h.dispose();}
});
