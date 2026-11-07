'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const transformSource=s=>s.replace('    const memoryGraphSourceFingerprint =',`
    globalThis.__pressure={storage,run:withBackgroundReadJob,active:activeBackgroundReadFrames,
      schedule:scheduleCurrentStateSnapshotRefresh,
      refreshAdmissions:refreshMicroStateAdmissionsAfterCanonical,
      scheduleCorpus:delay=>scheduleVolatileMemoryGraphCorpus(delay),
      noteWrite:key=>noteMemoryGraphSourceWrite(key),
      volatileState:()=>volatileMemoryGraphCorpus(),
      readMicroGraph:(scopeKey,resources)=>readMicroRepresentationGraph(scopeKey,resources),
      warm:()=>warmMicroRepresentationVectors(),
      auxiliary:value=>{auxiliaryReanalysisRunning=value;}};
    const memoryGraphSourceFingerprint =`).replace(
  'const refreshSnapshot = async (suppliedContext, options = {}) => {',
  'const refreshSnapshot = async (suppliedContext, options = {}) => { if(globalThis.__snapshotProbe)return globalThis.__snapshotProbe(suppliedContext,options);').replace(
  'const buildMemoryGraphCorpusInto = async (options, volatile, yieldCheck = null) => {',
  'const buildMemoryGraphCorpusInto = async (options, volatile, yieldCheck = null) => { if(globalThis.__corpusProbe)return globalThis.__corpusProbe();').replace(
  'const readMemoryGraphProjectionOnce = async (options = {}, collect = null, resources = null) => {',
  'const readMemoryGraphProjectionOnce = async (options = {}, collect = null, resources = null) => { if(globalThis.__projectionProbe)globalThis.__projectionProbe(options,collect);');

test('unpaid preparation retries with a new frame; persistent mutation and paid tasks still fail closed',async t=>{
 const f=await fixture({transformSource});t.after(()=>f.r.cleanup());
 const c=f.r.context.__pressure,scope={scopeKey:'read-pressure',characterId:'fixture',chatId:'fixture'},key='libra:v1:scope:read-pressure:source';
 f.r.values.set(key,'{"n":1}');let attempts=0;
 const value=await c.run(scope,async observed=>{
  const before=await c.storage.getVerifiedJson(key,observed);attempts++;
  if(attempts===1)f.r.values.set(key,'{"n":2}');
  return before.n;
 },{retryTornRead:true});
 assert.equal(value,2);assert.equal(attempts,2);assert.equal(c.active.size,0);
 attempts=0;
 await assert.rejects(c.run(scope,async observed=>{
  const v=await c.storage.getVerifiedJson(key,observed);attempts++;f.r.values.set(key,JSON.stringify({n:v.n+1}));
 },{retryTornRead:true}),/LIBRA_GRAPH_READER_BODY_CHANGED/);
 assert.equal(attempts,3);assert.equal(c.active.size,0);
 attempts=0;
 await assert.rejects(c.run(scope,async observed=>{
  const v=await c.storage.getVerifiedJson(key,observed);attempts++;f.r.values.set(key,JSON.stringify({n:v.n+1}));
 }),/LIBRA_GRAPH_READER_BODY_CHANGED/);
 assert.equal(attempts,1,'the default cannot repeat a provider/writer task');
 assert.equal(c.active.size,0);assert.equal(f.control.calls.length,0);
});

test('automatic snapshots coalesce while slow; auxiliary selection defers full projections',async t=>{
 const f=await fixture({transformSource});t.after(()=>f.r.cleanup());
 const c=f.r.context.__pressure,scope=(await f.r.api.listReanalysisRanges({kind:'micro'})).scopeKey;
 const request={scopeKey:scope,characterId:f.character.id,chatId:f.chat.id};
 let active=0,peak=0,calls=0,release;
 const gate=new Promise(resolve=>release=resolve);
 f.r.context.__snapshotProbe=async()=>{calls++;active++;peak=Math.max(peak,active);try{await gate;}finally{active--;}};
 c.schedule(request);await waitFor(()=>calls===1);
 for(let i=0;i<5;i++){c.schedule(request);await pause(125);}
 assert.equal(calls,1);assert.equal(peak,1);
 release();await waitFor(()=>calls===2);await pause(150);
 assert.equal(calls,2,'all pending notifications become one following projection');assert.equal(peak,1);
 c.auxiliary(true);for(let i=0;i<5;i++)c.schedule(request);await pause(150);
 assert.equal(calls,2,'a Micro selection does not start a full snapshot for every turn');
 c.auxiliary(false);c.schedule(request);await waitFor(()=>calls===3);
});

test('canonical admission refresh waits for its writer and merges requests instead of racing another batch',async t=>{
 const f=await fixture({transformSource});t.after(()=>f.r.cleanup());
 const c=f.r.context.__pressure,core=f.r.context.__fixtureNativeMemoryCore;
 const scopeKey=(await f.r.api.listReanalysisRanges({kind:'micro'})).scopeKey;
 const scope={scopeKey,characterId:f.character.id,chatId:f.chat.id};
 let release;const writer=new Promise(resolve=>release=resolve);core.state.queues.set(scopeKey,writer);
 const a=c.refreshAdmissions(scope,1,2),b=c.refreshAdmissions(scope,3,5);
 assert.equal(a,b,'one refresh job per scope');
 await pause(50);assert.equal(core.state.lastMicroStateAdmissionRefresh,undefined);
 core.state.queues.delete(scopeKey);release();await a;
 assert.equal(core.state.lastMicroStateAdmissionRefresh.startTurn,1);
 assert.equal(core.state.lastMicroStateAdmissionRefresh.throughTurn,5);
});

test('a partial canonical Head still schedules Micro admission for the other ready domains',async t=>{
 const f=await fixture({transformSource});t.after(()=>f.r.cleanup());
 const location=f.clone(f.control.artifact.facts.find(f=>f.tempFactId==='f5'));
 location.tempFactId='same-position-conflict';location.values.locationRef='hall';
 f.control.artifact.facts.push(location);f.control.artifact.stateBindings.push({factTempId:location.tempFactId});
 await f.run();assert.equal(f.getHead().status,'partial');assert.equal(f.getHead().domainStatus.world.status,'ready');
 const core=f.r.context.__fixtureNativeMemoryCore;
 await waitFor(()=>core.state.lastMicroStateAdmissionRefresh?.throughTurn===5);
 assert.equal(core.state.lastMicroStateAdmissionRefresh.status,undefined,'refresh completed rather than failing');
});

test('optional whole-corpus work waits until Micro selection and canonical work are idle',async t=>{
 const f=await fixture({transformSource});t.after(()=>f.r.cleanup());
 const c=f.r.context.__pressure,core=f.r.context.__fixtureNativeMemoryCore;let calls=0;
 f.r.context.__corpusProbe=async()=>{calls++;return {status:'skipped'};};
 c.auxiliary(true);c.scheduleCorpus(5);await pause(40);
 assert.equal(calls,0);assert.equal(c.warm(),null,'per-turn vector warming is deferred too');
 c.auxiliary(false);core.state.currentRun={runId:'held-writer'};await pause(40);assert.equal(calls,0);
 core.state.currentRun=null;await waitFor(()=>calls===1);
 await pause(30);assert.equal(calls,1);
});

test('Micro representation reader uses microOnly projection, retries transient READ_CONTEXT_EXPIRED, and derived caches do not drop volatile corpus',async t=>{
 const f=await fixture({transformSource});t.after(()=>f.r.cleanup());
 await f.run();
 const c=f.r.context.__pressure;
 let expiredOnce=false;
 const observedOptions=[];
 f.r.context.__projectionProbe=(options,collect)=>{
  observedOptions.push({microOnly:options?.microOnly===true,hasCollect:Boolean(collect)});
  if(!expiredOnce){expiredOnce=true;throw Object.assign(new Error('READ_CONTEXT_EXPIRED'),{code:'READ_CONTEXT_EXPIRED'});}
 };
 const overview=await f.r.api.getRecentWorkOverview();
 const microJob=overview.jobs.find(job=>job.id==='micro');
 assert.equal(expiredOnce,true);
 assert.notEqual(microJob.error,'READ_CONTEXT_EXPIRED');
 assert.ok(observedOptions.length>=2 && observedOptions.every(row=>row.microOnly===true && row.hasCollect===false));

 const scopeKey=(await f.r.api.listReanalysisRanges({kind:'micro'})).scopeKey;
 const vState=c.volatileState();
 const writesBefore=vState.sourceWrites||0;
 for(const suffix of ['evidence-link-index:v1','lore-link-index:v1','state-replay-cache:v1','state-replay-errors:v1','recall-catalog:v1','vector:m1:r1:p1']){
  c.noteWrite(`libra:v1:scope:${scopeKey}:${suffix}`);
 }
 assert.equal(vState.sourceWrites||0,writesBefore,'derived cache and vector writes do not invalidate volatile corpus');
 c.noteWrite(`libra:v1:scope:${scopeKey}:manifest`);
 assert.equal(vState.sourceWrites,writesBefore+1,'real source writes still invalidate volatile corpus');
});
