'use strict';
// Actual emitted-plugin boot with a deliberately delayed native initialization read.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const Module=require('node:module');
const artifact=path.resolve(process.env.LIBRA_GUI_TEST_DIST||path.join(__dirname,'../dist/LIBRA World Manager Full.js'));
const emitted=fs.readFileSync(artifact,'utf8');
const fixturePath=path.join(__dirname,'libra_management_gui_integration_test.cjs');
const fixture=fs.readFileSync(fixturePath,'utf8');
const fixtureBoundary=fixture.indexOf(' let code=fs.readFileSync(');
assert(fixtureBoundary>0,'native fixture setup boundary');
const fixtureModule=new Module(fixturePath,module);
fixtureModule.filename=fixturePath;fixtureModule.paths=Module._nodeModulePaths(__dirname);
fixtureModule._compile(fixture.slice(0,fixtureBoundary)+' return {dom,w,store,pending,calls,callbacks,control,R};\n}\nmodule.exports={loadGui};',fixturePath);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label,limit=3000){const end=Date.now()+limit;while(Date.now()<end){if(predicate())return;await sleep(5);}assert.fail(label);}
function instrument(source,fault=false){
  if(fault){
    // Deliberate test-only failure at the initialization entry, outside its own catch.
    // The emitted footer itself is never replaced; its rejection handler is exercised.
    const entries=['const runtimeReady = runtimeDetached ? Promise.resolve() : (async () => {','runtimeReady=runtimeDetached?Promise.resolve():(async()=>{'];
    const entry=entries.find(value=>source.includes(value));assert(entry,'actual initialization entry exists for rejection injection');
    assert.equal(source.split(entry).length,2,'one initialization entry');
    source=source.replace(entry,entry+'globalThis.__WM_BOOT_FAULT_STARTED=true;await globalThis.__WM_BOOT_FAULT_GATE;throw new Error("fixture_initialization_rejected api_key=BOOT_SECRET_CANARY");');
  }
  const markers=['    if (runtimeDetached) return privateHandle;','if(runtimeDetached)return privateHandle;'];
  const marker=markers.find(value=>source.includes(value));assert(marker,'actual emitted live/detached return boundary');
  assert.equal(source.split(marker).length,2,'one runtime return boundary');
  return source.replace(marker,'globalThis.__WM_BOOT_TEST__={MemoryState,MemoryEngine,DebugExportManager,LatestTurnBaselineOwner,turnReanalysisAvailability,runtimeReady};'+marker);
}
async function harness(fault=false){
  const f=await fixtureModule.exports.loadGui({nativeInitialization:true,store:new Map()});
  const registrations={};
  for(const [method,label] of [['registerSetting','setting'],['registerButton','button'],['addRisuReplacer','replacer']]){
    const original=f.R[method];f.R[method]=async(...args)=>{const key=label==='replacer'?String(args[0]):label;registrations[key]=(registrations[key]||0)+1;return original.apply(f.R,args);};
  }
  const logs=[],unhandled=[];
  for(const method of ['log','warn','error','debug'])f.w.console[method]=(...args)=>logs.push(args.map(String).join(' '));
  const onUnhandled=reason=>unhandled.push(String(reason?.message||reason));
  process.on('unhandledRejection',onUnhandled);f.w.addEventListener('unhandledrejection',event=>onUnhandled(event.reason));
  let release;const gate=new Promise(resolve=>{release=resolve;});let held=false;
  const getArgument=f.R.getArgument;
  f.R.getArgument=async key=>{if(!held){held=true;await gate;}return getArgument.call(f.R,key);};
  if(fault)f.w.__WM_BOOT_FAULT_GATE=gate;
  const started=Date.now();let settled=false,topError=null;
  const top=Promise.resolve(f.w.eval(instrument(emitted,fault))).then(()=>{settled=true;},error=>{settled=true;topError=error;});
  await until(()=>fault?f.w.__WM_BOOT_FAULT_STARTED:held,'initialization reached the deliberately held boundary');
  return {...f,registrations,logs,unhandled,top,release,get settled(){return settled;},get topError(){return topError;},started,
    async close(){release();await Promise.race([top,sleep(1000)]);f.w.close();process.off('unhandledRejection',onUnhandled);}};
}
const checks=[];
async function run(name,body,fault=false){let f;try{f=await harness(fault);await body(f);checks.push({name,ok:true});}catch(error){checks.push({name,ok:false,error:error.stack||String(error)});process.exitCode=1;}finally{await f?.close();}}
(async()=>{
  await run('delayed native initialization never blocks top-level plugin completion and registers hooks once',async f=>{
    await sleep(100);
    assert.equal(f.settled,true,'top-level emitted plugin promise settles while native initialization remains blocked');
    assert.equal(f.topError,null,'top-level plugin load succeeds');
    const api=f.w.__WM_BOOT_TEST__;assert(api,'lexical observation is available before initialization completes');
    assert.equal(api.MemoryState.isInitialized,false,'held native read really keeps initialization pending');
    assert.equal(api.turnReanalysisAvailability('fixture-existing-canonical-memory').eligible,false,'turn reanalysis remains unavailable while initialization is pending');
    for(const key of ['setting','button','beforeRequest','afterRequest'])assert.equal(f.registrations[key],1,`${key} registers exactly once before initialization is released`);
    f.release();await until(()=>api.MemoryState.isInitialized,'released initialization becomes ready');
    await api.runtimeReady;
    for(const key of ['setting','button','beforeRequest','afterRequest'])assert.equal(f.registrations[key],1,`${key} is not registered again on readiness`);
    assert.equal(f.unhandled.length,0);assert.equal(f.calls.hostWrites.length,0);
  });
  await run('initialization work rejection is logged without an unhandled rejection or failed plugin promise',async f=>{
    await sleep(100);assert.equal(f.settled,true,'plugin completion does not await a delayed initialization failure');
    const api=f.w.__WM_BOOT_TEST__;api.MemoryEngine.CONFIG.debug=true;
    f.release();await until(()=>[...api.MemoryState.suppressedErrorStatsByKey.values()].some(row=>row.label==='runtime.initialization_failed'),'rejected runtimeReady reaches the real footer error handler');
    const records=api.DebugExportManager.getRuntimeRecords('global');
    assert(records.some(record=>record.events?.length),'initialization failure creates a diagnostic event');
    assert(!JSON.stringify(records).includes('BOOT_SECRET_CANARY'),'public diagnostic records do not leak the raw rejection canary');
    assert(!f.logs.join(' ').includes('BOOT_SECRET_CANARY'),'console does not leak the raw rejection canary');
    await sleep(20);assert.equal(f.topError,null);assert.equal(f.unhandled.length,0);
    assert.equal(f.w.__WM_BOOT_TEST__.MemoryState.isInitialized,false,'failed initialization is not marked ready');
    assert.equal(f.w.__WM_BOOT_TEST__.turnReanalysisAvailability('fixture-existing-canonical-memory').eligible,false);
    assert.equal(f.calls.hostWrites.length,0);
  },true);
  const report={passed:checks.filter(check=>check.ok).length,failed:checks.filter(check=>!check.ok).length,productionArtifact:artifact,sha256:crypto.createHash('sha256').update(emitted).digest('hex'),mockOnly:true,checks};
  if(process.env.LIBRA_NONBLOCKING_BOOT_REPORT){fs.mkdirSync(path.dirname(process.env.LIBRA_NONBLOCKING_BOOT_REPORT),{recursive:true});fs.writeFileSync(process.env.LIBRA_NONBLOCKING_BOOT_REPORT,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
