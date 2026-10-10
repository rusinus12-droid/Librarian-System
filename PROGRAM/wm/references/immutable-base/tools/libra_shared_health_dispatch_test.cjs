'use strict';
// Focused emitted Full/Min DOM integration. Test-only lexical wrapping observes the
// real SDK factory, dispatcher methods and owner adapters; no product test hooks.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const Module=require('node:module');
const artifact=path.resolve(process.env.LIBRA_GUI_TEST_DIST||path.join(__dirname,'../dist/LIBRA World Manager Full.js'));
const source=fs.readFileSync(artifact,'utf8');
const testSourceSha256=crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
function installTrace(){
 const trace={instances:[],calls:[],adapters:[]};
 trace.wrapFactory=factory=>options=>{
  const index=trace.instances.length,config={...options};
  for(const [name,kind]of [['derivedCache','refresh_derived_cache'],['reanalysis','explicit_reanalysis']]){
   if(!options[name])continue;config[name]={...options[name]};
   for(const method of ['preview','apply','clear'])if(typeof options[name][method]==='function'){
    config[name][method]=function(...args){
     const call={instance:index,kind,method};trace.adapters.push(call);
     const value=options[name][method].apply(options[name],args);
     if(value&&typeof value.then==='function')value.then(result=>{call.result=result;},error=>{call.error=String(error);});else call.result=value;
     return value;
    };
   }
  }
  const raw=factory(config),record={index,raw,dispatcher:null};trace.instances.push(record);
  const dispatcher={};
  for(const method of ['inspect','preview','apply','clear'])dispatcher[method]=function(...args){
   const call={instance:index,method,kind:method==='preview'?args[0]:args[0]?.actionKind,args};trace.calls.push(call);if(trace.onCall)trace.onCall(call);
   const value=raw[method](...args);
   if(value&&typeof value.then==='function')value.then(result=>{call.result=result;},error=>{call.error=String(error);});else call.result=value;
   return value;
  };
  record.dispatcher=Object.freeze(dispatcher);return record.dispatcher;
 };
 globalThis.__WM_DISPATCH_TRACE__=trace;
}
const instrumented='('+installTrace.toString().replace(/\n/g,' ')+')();\n'+source.replace(/MemorySuiteHealthRecovery\.createOrchestrator/g,'globalThis.__WM_DISPATCH_TRACE__.wrapFactory(MemorySuiteHealthRecovery.createOrchestrator)');
// Load, but do not execute, the existing ordinary native-capture/card fixture.
const fixturePath=path.join(__dirname,'libra_turn_card_reanalysis_test.cjs');
let fixtureSource=fs.readFileSync(fixturePath,'utf8');
const sourceLine="const productionCode=fs.readFileSync(productionArtifact,'utf8');";
assert(fixtureSource.includes(sourceLine),'existing emitted card fixture source contract');
fixtureSource=fixtureSource.replace(sourceLine,'const productionCode=module.__artifactSource;');
const fixtureModule=new Module(fixturePath,module);fixtureModule.filename=fixturePath;fixtureModule.paths=Module._nodeModulePaths(__dirname);fixtureModule.__artifactSource=instrumented;fixtureModule._compile(fixtureSource,fixturePath);
const {ordinaryFixture,waitFor}=fixtureModule.exports;
const checks=[];
async function test(name,fn){
 if(process.env.LIBRA_SHARED_DISPATCH_FILTER&&!new RegExp(process.env.LIBRA_SHARED_DISPATCH_FILTER).test(name))return;
 let f;process.stderr.write('[shared-dispatch] START '+name+'\n');
 try{f=await ordinaryFixture();f.trace=f.w.__WM_DISPATCH_TRACE__;await fn(f);checks.push({name,ok:true,evidence:{dispatcherInstances:f.trace.instances.length,dispatcherCalls:f.trace.calls.map(x=>({instance:x.instance,method:x.method,kind:x.kind,status:x.result?.status||x.result?.state,allowed:x.result?.allowed})),ownerApplies:f.trace.adapters.filter(x=>x.method==='apply').map(x=>({instance:x.instance,kind:x.kind,status:x.result?.status||x.result?.state})),providerCalls:f.provider.calls,canonicalWrites:f.canonicalWrites().length,hostWrites:f.calls.hostWrites.length}});process.stderr.write('[shared-dispatch] PASS '+name+'\n');}
 catch(error){checks.push({name,ok:false,error:error.stack,diagnostics:f?{instances:f.trace?.instances.length,calls:f.trace?.calls.map(x=>({instance:x.instance,method:x.method,kind:x.kind,result:x.result})),providerCalls:f.provider.calls,canonicalWrites:f.canonicalWrites().length,hostWrites:f.calls.hostWrites.length}:undefined});process.exitCode=1;process.stderr.write('[shared-dispatch] FAIL '+name+': '+error.message+'\n');}
 finally{f?.close();}
}
function shared(f){assert.equal(f.trace.instances.length,1,'one runtime-private shared SDK dispatcher must be constructed for health and card actions');return f.trace.instances[0].dispatcher;}
async function main(){
 await test('health and card controls route through the same emitted SDK dispatcher',async f=>{
  shared(f);const raw=f.store.get(f.key),initialModels=f.provider.calls;
  await f.click('#btn-health-scan');await f.click('#btn-health-repair-preview');
  assert.equal(f.provider.calls,initialModels,'inspect and cache preview invoke zero extra models');
  assert.equal(f.store.get(f.key),raw);assert.equal(f.canonicalWrites().length,0);assert.equal(f.calls.hostWrites.length,0);assert.equal(f.calls.writes.length,0,'inspect and preview perform zero storage mutations');
  assert.equal(f.trace.adapters.filter(x=>x.method==='apply').length,0,'inspect and preview invoke zero repair adapters');
  assert(f.trace.calls.some(x=>x.method==='inspect'),'health Scan routes through shared inspect');
  assert(f.trace.calls.some(x=>x.method==='preview'&&x.kind==='refresh_derived_cache'),'cache preview routes through shared dispatcher');
  await f.click('#btn-health-repair-apply');assert.equal(f.provider.calls,initialModels,'cache apply invokes zero models');assert.equal(f.store.get(f.key),raw);
  let beforeExplicitApply=null;f.trace.onCall=call=>{if(call.method==='apply'&&call.kind==='explicit_reanalysis')beforeExplicitApply={models:f.provider.calls,writes:f.canonicalWrites().length};};
  f.editSource();await f.click('.act-reanalyze-turn');
  assert.deepEqual(beforeExplicitApply,{models:initialModels,writes:0},'explicit preview remains model-free and read-only until apply');
  for(const kind of ['refresh_derived_cache','explicit_reanalysis']){
   assert(f.trace.calls.some(x=>x.method==='apply'&&x.kind===kind),'shared apply receives '+kind);
   assert(f.trace.adapters.some(x=>x.method==='apply'&&x.kind===kind),'real owner adapter executes '+kind);
  }
  assert.equal(new Set(f.trace.calls.map(x=>x.instance)).size,1,'both action kinds use the exact same instance');
  assert.equal(f.provider.calls,2);assert.equal(f.canonicalWrites().length,1);assert.equal(f.calls.hostWrites.length,0);
  assert.equal(f.status()?.dataset.state,'committed');
 });

 await test('unknown and forged public tickets cannot reach either owner adapter',async f=>{
  const dispatcher=shared(f);await f.click('#btn-health-repair-preview');
  const ticket=f.trace.calls.findLast(x=>x.method==='preview'&&x.kind==='refresh_derived_cache').result;
  assert.equal(ticket.allowed,true);const before=f.trace.adapters.filter(x=>x.method==='apply').length;
  for(const candidate of [null,{}, {...ticket},Object.create(ticket),{allowed:true,actionKind:'explicit_reanalysis'}]){
   const result=await dispatcher.apply(candidate);assert.equal(result.status,'blocked');
  }
  assert.equal(f.trace.adapters.filter(x=>x.method==='apply').length,before);
  assert.equal(f.provider.calls,1);assert.equal(f.canonicalWrites().length,0);assert.equal(f.calls.hostWrites.length,0);
 });
 await test('duplicate card clicks and rerender consume one explicit action and verified save',async f=>{
  shared(f);const release=f.holdProvider();f.editSource();const button=f.button();button.click();button.click();
  try{await waitFor(()=>f.provider.calls===2,'explicit routed model starts');
   f.overlay.querySelector('[data-mem-view="kind"]').click();assert(f.button().disabled,'rerendered button remains disabled');f.button().click();
  }finally{release();await f.flush();}
  assert.equal(f.trace.adapters.filter(x=>x.method==='apply'&&x.kind==='explicit_reanalysis').length,1);
  assert.equal(f.provider.calls,2);assert.equal(f.canonicalWrites().length,1);assert.equal(f.calls.hostWrites.length,0);assert.equal(f.status()?.dataset.state,'committed');
 });
 await test('shared busy latch blocks cache controls while explicit model work is pending',async f=>{
  const dispatcher=shared(f);await f.click('#btn-health-repair-preview');
  const cacheTicket=f.trace.calls.findLast(x=>x.method==='preview'&&x.kind==='refresh_derived_cache').result;
  assert(cacheTicket.allowed);const release=f.holdProvider();f.editSource();f.button().click();
  try{
   await waitFor(()=>f.provider.calls===2,'explicit model reaches pending transport');
   const count=f.trace.calls.filter(x=>x.method==='apply'&&x.kind==='refresh_derived_cache').length;
   f.overlay.querySelector('#btn-health-repair-apply').click();
   await waitFor(()=>f.trace.calls.filter(x=>x.method==='apply'&&x.kind==='refresh_derived_cache').length>count&&f.trace.calls.findLast(x=>x.method==='apply'&&x.kind==='refresh_derived_cache').result,'busy cache control returns an observed dispatcher result');
   const blocked=f.trace.calls.findLast(x=>x.method==='apply'&&x.kind==='refresh_derived_cache').result;assert.equal(blocked.status,'blocked');
   assert.equal(f.trace.adapters.filter(x=>x.method==='apply'&&x.kind==='refresh_derived_cache').length,0,'cache owner apply never runs while model adapter owns the latch');
   const denied=await dispatcher.preview('refresh_derived_cache',{});assert.equal(denied.allowed,false);assert.equal(denied.reason,'operation_in_progress');
   assert.equal(f.canonicalWrites().length,0);assert.equal(f.calls.hostWrites.length,0);
  }finally{release();await f.flush();}
  assert.equal(f.provider.calls,2);assert.equal(f.canonicalWrites().length,1);assert.equal(f.status()?.dataset.state,'committed');
 });
 await test('repeated cache apply rechecks the current cache before reporting verified',async f=>{
  shared(f);await f.click('#btn-health-repair-preview');await f.click('#btn-health-repair-apply');
  const projection=()=>JSON.stringify(Array.from(f.api.EntityManager.getEntityCache().entries()));
  const expected=projection();assert.notEqual(expected,'[]','ordinary turn owns a real entity cache');
  f.api.EntityManager.clearCache();assert.equal(projection(),'[]');
  await f.click('#btn-health-repair-apply');
  const result=f.trace.calls.findLast(x=>x.method==='apply'&&x.kind==='refresh_derived_cache').result;
  assert(result,'real shared cache result observed');
  if(result.status==='verified')assert(projection()===expected,'verified requires cache to match canonical content now');
  else assert(!/검증 완료/.test(f.overlay.querySelector('#health-recovery-status').textContent),'stale cache never retains a verified UI claim');
  assert.equal(f.provider.calls,1);assert.equal(f.canonicalWrites().length,0);assert.equal(f.calls.hostWrites.length,0);
 });
 for(const transition of ['close','scope','canonical-change','unreadable','reset'])await test(`cache ticket fails closed after ${transition}`,async f=>{
  const dispatcher=shared(f);await f.click('#btn-health-repair-preview');
  const ticket=f.trace.calls.findLast(x=>x.method==='preview'&&x.kind==='refresh_derived_cache').result;assert(ticket.allowed);
  if(transition==='close')await f.click('#xbtn');
  if(transition==='scope'){f.control.chat.bindedPersona='persona-b';f.control.char.chats[0]=f.control.chat;}
  if(transition==='unreadable')f.control.failReads=true;
  if(transition==='canonical-change'){const value=f.canonicalPayload();value.entries.push({comment:'other',content:'changed'});f.store.set(f.key,JSON.stringify(value));}
  if(transition==='reset'){
   const action=f.overlay.querySelector('#lmai-data-reset').onclick();const dialog=f.w.document.querySelector('[data-libra-dialog="true"]');assert(dialog);[...dialog.querySelectorAll('button')].find(x=>x.textContent==='확인').click();await action;
   assert.equal(f.canonicalPayload().entries.length,0);
  }
  const before=f.canonicalWrites().length,result=await dispatcher.apply(ticket);
  assert.equal(result.status,'blocked','known stale/unreadable preflight fails closed before execution');assert.equal(f.canonicalWrites().length,before);assert.equal(f.provider.calls,1);assert.equal(f.calls.hostWrites.length,0);
  if(['close','reset'].includes(transition))assert(f.trace.calls.some(x=>x.method==='clear'),'view/reset invalidates the shared dispatcher');
 });

 for(const transition of ['close','scope','reset'])await test(`explicit action fails closed before publication after ${transition}`,async f=>{
  shared(f);const raw=f.store.get(f.key),release=f.holdProvider();f.editSource();f.button().click();
  try{
   await waitFor(()=>f.provider.calls===2,'explicit model starts before lifecycle change');
   if(transition==='close')f.overlay.querySelector('#xbtn').click();
   if(transition==='scope'){
    f.control.chat={id:'destination',bindedPersona:'persona-a',localLore:[],message:[]};f.control.char={id:'other-character',chatPage:0,chats:[f.control.chat]};
    f.api.MemoryState._activeScopeKey='destination';f.api.TimeEngine.resetState({notes:'destination sentinel'});
   }
   if(transition==='reset'){
    const action=f.overlay.querySelector('#lmai-data-reset').onclick();const dialog=f.w.document.querySelector('[data-libra-dialog="true"]');assert(dialog);[...dialog.querySelectorAll('button')].find(x=>x.textContent==='확인').click();await action;
   }
  }finally{release();await f.flush();}
  const result=f.trace.calls.findLast(x=>x.method==='apply'&&x.kind==='explicit_reanalysis').result;
  assert.equal(result.state,'rejected','known prewrite lifecycle rejection stays rejected');assert.equal(result.writeIssued,false);
  if(transition==='reset'){assert.equal(f.canonicalPayload().entries.length,0);assert.equal(f.canonicalWrites().length,1,'only the explicitly confirmed reset root is published');}
  else{assert.equal(f.store.get(f.key),raw);assert.equal(f.canonicalWrites().length,0);}
  if(transition==='scope')assert.equal(f.api.TimeEngine.getState().notes,'destination sentinel');
  assert.equal(f.provider.calls,2);assert.equal(f.calls.hostWrites.length,0);
 });
 for(const terminal of ['committed','uncertain'])await test(`${terminal} publication result survives closing the view during write`,async f=>{
  const dispatcher=shared(f);f.editSource();
  f.control.afterSet=async()=>{if(terminal==='uncertain')f.control.failReads=true;f.overlay.querySelector('#xbtn').click();};
  await f.click('.act-reanalyze-turn');await f.flush();
  const application=f.trace.calls.findLast(x=>x.method==='apply'&&x.kind==='explicit_reanalysis');assert(application?.result,'shared apply returns its publication result');
  const result=application.result;assert.equal(result.state||result.status,terminal,'late invalidation preserves durable or uncertain outcome');
  assert(f.trace.calls.some(x=>x.method==='clear'),'close clears the same dispatcher');
  assert.equal(f.canonicalWrites().length,1);assert.equal(f.provider.calls,2);assert.equal(f.calls.hostWrites.length,0);
  const replay=await dispatcher.apply(application.args[0]);assert.equal(replay.status,'blocked');assert.equal(f.canonicalWrites().length,1);assert.equal(f.provider.calls,2);
 });
 const report={testSourceSha256,passed:checks.filter(x=>x.ok).length,failed:checks.filter(x=>!x.ok).length,artifact,sha256:crypto.createHash('sha256').update(source).digest('hex'),mockOnly:true,realEmittedDom:true,checks};
 if(process.env.LIBRA_SHARED_DISPATCH_REPORT){fs.mkdirSync(path.dirname(process.env.LIBRA_SHARED_DISPATCH_REPORT),{recursive:true});fs.writeFileSync(process.env.LIBRA_SHARED_DISPATCH_REPORT,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
