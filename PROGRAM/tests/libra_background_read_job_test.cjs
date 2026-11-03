'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const expose=s=>s.replace('    const stateDerivedWorldlineSuffix =',`    globalThis.__jobs={storage,run:withBackgroundReadJob,frames:memoryGraphReadFrames,
  active:activeBackgroundReadFrames,clear:invalidateAllVerifiedReads,fresh:n=>{freshReadDepth=n;}};
    const stateDerivedWorldlineSuffix =`);
const scope={scopeKey:'seventh-server-scope',characterId:'fixture',chatId:'fixture'};
const keys=['micro-memory-head:main:e0:t99','lens:head','memory:fixture:r1','continuity-state'].map(k=>'libra:v1:scope:'+scope.scopeKey+':'+k);
for(const mode of ['server_only','mirror'])test(`${mode}: job borrows all source families provisionally and validates once before returning or writing`,async t=>{
 const s=await serverFixture({mode,transformSource:expose});t.after(()=>s.cleanup());const c=s.f.r.context.__jobs;
 const change=async(k,v,kind='set')=>{await s.mutate(k,v,kind);if(mode==='mirror'){if(kind==='remove')s.local.delete(k);else s.local.set(k,JSON.stringify(v));}};
 const base={...scope,_cachedMode:mode};
 for(const k of keys)await change(k,{n:1});
 for(const k of keys)assert.equal((await c.storage.getVerifiedJson(k,base)).n,1);
 const before=s.requests.length;
 await c.run(base,async job=>{
  for(let i=0;i<10;i++)for(const k of keys){const v=await c.storage.getVerifiedJson(k,job);assert.equal(v.n,1);v.n=999;}
  assert.equal(s.requests.length,before,'no per-hit transport inside a bound job');
 });
 const validation=s.requests.slice(before).filter(r=>r.url.endsWith('/v1/kv/get-many'));
 assert.equal(validation.length,1,'one closing physical revision batch for forty reads');
 const target=keys[0]+':target';
 for(const k of keys){
  await assert.rejects(c.run(base,async job=>{
   assert.equal((await c.storage.getVerifiedJson(k,job)).n,1);
   await change(k,{n:2});
   assert.equal((await c.storage.getVerifiedJson(k,job)).n,1,'job holds its original observation');
   await c.storage.setVerifiedJson(target,{stale:true},job);
  }),/LIBRA_GRAPH_READER_BODY_CHANGED/);
  assert.equal(s.storedRows().some(row=>row.key===target),false,'stale candidate never writes');
  assert.equal(await c.run(base,async job=>(await c.storage.getVerifiedJson(k,job)).n),2);
  await change(k,{n:1});c.clear();await c.storage.getVerifiedJson(k,base);
  // A byte-identical server ABA must also reject the captured witness.
  await assert.rejects(c.run(base,async job=>{
   await c.storage.getVerifiedJson(k,job);await change(k,{n:3});await change(k,{n:1});
  }),/LIBRA_GRAPH_READER_BODY_CHANGED/);
 }
 const missing=keys[0]+':added';c.clear();assert.equal(await c.storage.getVerifiedJson(missing,base),null);
 await assert.rejects(c.run(base,async job=>{assert.equal(await c.storage.getVerifiedJson(missing,job),null);await change(missing,{n:4});}),/LIBRA_GRAPH_READER_BODY_CHANGED/);
 assert.equal(await c.run(base,async job=>(await c.storage.getVerifiedJson(missing,job)).n),4);
 // Own writes advance only their key after verified readback; remaining original
 // dependencies must still be checked at the next write boundary.
 c.clear();await assert.rejects(c.run(base,async job=>{
  await c.storage.getVerifiedJson(keys[0],job);
  await c.storage.setVerifiedJson(target,{n:1},job);
  assert.equal((await c.storage.getVerifiedJson(target,job)).n,1);
  await change(keys[0],{n:8});
  await c.storage.setVerifiedJson(target,{n:2},job);
 }),/LIBRA_GRAPH_READER_BODY_CHANGED/);
 assert.equal(s.storedRows().find(row=>row.key===target).value.n,1);
 c.clear();await c.storage.getVerifiedJson(keys[0],base);
 await assert.rejects(c.run(base,async job=>{
  await c.storage.getVerifiedJson(keys[0],job);
  await c.storage.setVerifiedJson(keys[0],{n:9},base);
 }),/LIBRA_GRAPH_READER_BODY_CHANGED/,'another writer revokes the viewer; the viewer cannot veto the writer or escape stale');
 assert.equal((await c.storage.getVerifiedJson(keys[0],base)).n,9);
 assert.equal(c.active.size,0,'every job releases its frame');
});
test('native: exact bytes, additions, settings witness and concurrent fresh readers cannot bypass a job boundary',async t=>{
 const r=await createLibraVmHarness({}, {},{transformSource:expose});t.after(()=>r.cleanup());const c=r.context.__jobs,base={...scope,_cachedMode:'plugin_only'},k=keys[0];
 r.values.set(k,'{"n":1}');await c.storage.getVerifiedJson(k,base);
 const count=()=>r.storageReads.filter(key=>key===k).length,before=count();c.fresh(1);
 await c.run(base,async job=>{for(let i=0;i<20;i++)assert.equal((await c.storage.getVerifiedJson(k,job)).n,1);assert.equal(count(),before);});
 c.fresh(0);assert.equal(count(),before+1,'a separate fresh reader never turns twenty job hits into twenty reads');
 await assert.rejects(c.run(base,async job=>{await c.storage.getVerifiedJson(k,job);r.values.set(k,'{"n":2}');}),/LIBRA_GRAPH_READER_BODY_CHANGED/);
 assert.equal(await c.run(base,async job=>(await c.storage.getVerifiedJson(k,job)).n),2);
 const settings='libra:v1:runtime-settings';r.values.set(settings,'{"lens":"old"}');
 await assert.rejects(c.run(base,async job=>{c.frames.get(job).observeExtra(settings,r.values.get(settings));r.values.set(settings,'{"lens":"new"}');}),/LIBRA_BACKGROUND_SETTINGS_CHANGED/);
 assert.equal(c.active.size,0);
});
for(const mode of ['server_only','mirror'])test(`${mode}: repeating a real classified Micro reuses verified inventory without rewriting its revisions`,async t=>{
 const {fixture}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
 const x=await fixture({mode});t.after(()=>x.cleanup());
 const inventories=()=>x.server.storedRows().filter(r=>/libra\.person_span_inventory(?:_head)?\.v1/.test(r.value?.schema||''));
 const before=JSON.stringify(inventories()),calls=x.f.control.calls.length;
 assert.ok(inventories().length>=2);
 const repeated=await x.f.r.api.debugProduceMicroForTurn(6);
 assert.equal(repeated.status,'verified');assert.equal(repeated.duplicate,true);
 assert.equal(x.f.control.calls.length,calls,'no repeated provider request');
 assert.equal(JSON.stringify(inventories()),before,'both inventory bodies and physical revisions are unchanged');
});
for(const mode of ['server_only','mirror'])test(`${mode}: writer frame survives own write to reuse unmutated receipts while concurrent viewer is revoked and receipt mutation rejects stale candidate`,async t=>{
 const s=await serverFixture({mode,transformSource:expose});t.after(()=>s.cleanup());const c=s.f.r.context.__jobs;
 const base={...scope,_cachedMode:mode};
 const receiptKey='libra:v1:scope:'+scope.scopeKey+':source-receipt:wl:e0:t1:r1';
 const targetKey='libra:v1:scope:'+scope.scopeKey+':target:write';
 await s.mutate(receiptKey,{n:1});
 if(mode==='mirror')s.local.set(receiptKey,JSON.stringify({n:1}));
 assert.equal((await c.storage.getVerifiedJson(receiptKey,base)).n,1);

 await c.run(base,async writerJob=>{
  assert.equal((await c.storage.getVerifiedJson(receiptKey,writerJob)).n,1);
  const writerFrame=c.frames.get(writerJob);
  assert.equal(writerFrame.disabled,false,'writer frame initially active');

  await c.run(base,async viewerJob=>{
   const viewerFrame=c.frames.get(viewerJob);
   assert.equal((await c.storage.getVerifiedJson(receiptKey,viewerJob)).n,1);
   assert.equal(viewerFrame.disabled,false,'viewer frame initially active');

   await c.storage.setVerifiedJson(targetKey,{n:99},writerJob);

   assert.equal(writerFrame.disabled,false,'writer frame survives own write');
   assert.equal(viewerFrame.disabled,true,'concurrent viewer frame is revoked');

   const reqsBefore=s.requests.length;
   const v=await c.storage.getVerifiedJson(receiptKey,writerJob);
   assert.equal(v.n,1);
   assert.equal(s.requests.length,reqsBefore,'unmutated receipt reuses observation across own write');
  }).catch(err=>{
   assert.match(err.message,/LIBRA_GRAPH_READER_BODY_CHANGED/);
  });
 });

 c.clear();await c.storage.getVerifiedJson(receiptKey,base);
 await assert.rejects(c.run(base,async writerJob=>{
  await c.storage.getVerifiedJson(receiptKey,writerJob);
  await s.mutate(receiptKey,{n:2});
  if(mode==='mirror')s.local.set(receiptKey,JSON.stringify({n:2}));
  await c.storage.setVerifiedJson(targetKey,{stale:true},writerJob);
 }),/LIBRA_GRAPH_READER_BODY_CHANGED/,'mutated receipt rejects candidate write');
});

