'use strict';
// Background Recovery Journal repair is retired: afterRequest repair is the only
// automatic stage. Scheduling a durable debt must never queue a timer, a confirmation
// dialog or a paid call; the entry waits for manual repair.
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
const ctx=vm.createContext({Memory,Map,NATIVE_JOB_TERMINAL_STATES:new Set(['completed','failed','cancelled']),
  ownsRuntime:()=>true,inBandRecoveryPendingForDebt:()=>false,
  requestRecoveryJournalBackgroundConfirmation:r=>{requests.push(r.recordId);return true;},
  setTimeout:fn=>{timers.push(fn);return {unref(){}};},queueMicrotask:fn=>microtasks.push(fn),
  pushOperationLog:()=>{},compact:x=>String(x)});
vm.runInContext(source.slice(start,end)+'\nglobalThis.schedule=scheduleNativeRecoveryDebtRepair;',ctx);
(async()=>{
  for(const reason of ['packet_debt_ready','packet_debt_reactivated'])
    assert.equal(ctx.schedule({scopeKey:'scope',recordId:'1',worldlineStatus:'active'},reason),false,reason);
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(timers.length,0,'no timer');
  assert.equal(microtasks.length,0,'no queued attempt');
  assert.deepEqual(requests,[],'no confirmation dialog or background repair');
  assert.equal(Memory.nativeRecovery.confirmationTimers,undefined);
  console.log('hayaku recovery confirmation queue retired: ok');
})().catch(error=>{console.error(error);process.exit(1);});
