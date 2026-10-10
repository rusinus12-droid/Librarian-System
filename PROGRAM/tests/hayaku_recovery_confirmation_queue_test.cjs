'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');
const start=source.indexOf('  const scheduleNativeRecoveryDebtRepair =');
const end=source.indexOf('  const pruneInBandRecoveryReservations',start);
assert.ok(start>0 && end>start);
const timers=[], microtasks=[], requests=[];
const Memory={settings:{backgroundAutoRepair:true},nativeRecovery:{},finalizedCaptureInFlight:new Set(),finalizedBindingInFlight:new Set()};
let owner=true, responder=async r=>{requests.push(r.recordId);return true;};
const ctx=vm.createContext({Memory,Map,NATIVE_JOB_TERMINAL_STATES:new Set(['completed','failed','cancelled']),
  ownsRuntime:()=>owner,inBandRecoveryPendingForDebt:()=>false,
  requestRecoveryJournalBackgroundConfirmation:(...args)=>responder(...args),
  setTimeout:fn=>{timers.push(fn);return {unref(){}};},queueMicrotask:fn=>microtasks.push(fn),
  pushOperationLog:()=>{},compact:x=>String(x)});
vm.runInContext(source.slice(start,end)+'\nglobalThis.schedule=scheduleNativeRecoveryDebtRepair;',ctx);
const row=n=>({scopeKey:'scope',recordId:String(n),worldlineStatus:'active'});
const tick=async()=>{const f=timers.splice(0);for(const fn of f)fn();for(let i=0;i<8;i++)await Promise.resolve();};
const flush=async()=>{while(microtasks.length)microtasks.shift()();for(let i=0;i<8;i++)await Promise.resolve();};
(async()=>{
  Memory.finalizedCaptureInFlight.add('capture');
  ctx.schedule(row(1));ctx.schedule(row(1));await flush();
  for(let i=0;i<70;i++)await tick();
  assert.equal(requests.length,0);assert.equal(timers.length,1,'deduplicated wait survives old cutoff');
  Memory.finalizedCaptureInFlight.clear();await tick();
  assert.deepEqual(requests,['1']);assert.equal(Memory.nativeRecovery.confirmationTimers.size,0);
  responder=async r=>{requests.push(r.recordId);Memory.nativeRecovery.job={state:'awaiting_confirmation'};return true;};
  ctx.schedule(row(2));ctx.schedule(row(3));await flush();await tick();
  assert.deepEqual(requests,['1','2']);
  Memory.nativeRecovery.job.state='completed';await tick();
  assert.deepEqual(requests,['1','2','3'],'next consent resumes after active dialog');
  Memory.nativeRecovery.job=null;
  let racing=true;
  responder=async r=>{if(racing){Memory.nativeRecovery.repairInFlight=true;return false;}requests.push(r.recordId);return true;};
  ctx.schedule(row(4));await flush();assert.equal(timers.length,1);
  racing=false;Memory.nativeRecovery.repairInFlight=false;await tick();assert.equal(requests.at(-1),'4');
  Memory.nativeRecovery.coldStartInFlight=true;ctx.schedule(row(5));await flush();
  Memory.settings.backgroundAutoRepair=false;await tick();assert.equal(Memory.nativeRecovery.confirmationTimers.size,0);
  Memory.settings.backgroundAutoRepair=true;ctx.schedule(row(6));await flush();owner=false;await tick();
  assert.equal(Memory.nativeRecovery.confirmationTimers.size,0);
  owner=true;Memory.nativeRecovery.coldStartInFlight=false;
  responder=async()=>false;ctx.schedule(row(7));await flush();
  assert.equal(timers.length,0,'UI unavailable or non-actionable debt must not loop');
  assert.match(source,/호출 가능 · 모델 연결 미확인/);
  console.log('PASS long wait, dedup, sequential consent, readback race, disabled/owner cancellation, no UI retry loop');
})().catch(e=>{console.error(e);process.exitCode=1;});
