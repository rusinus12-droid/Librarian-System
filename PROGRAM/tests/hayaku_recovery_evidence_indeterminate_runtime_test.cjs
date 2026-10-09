"use strict";
const assert = require('node:assert/strict');
const { createHayakuRuntime, createStore } = require('./fixtures/hayaku_runtime_harness.cjs');
const pause = ms => new Promise(r => setTimeout(r, ms));
const isEvidence = k => String(k).includes('hayaku.v2.recovery_evidence_');
const input = (id='late') => ({scopeKey:'recovery-test',recordId:id,pairIndex:32,user:'문이 열렸는지 살핀다.',assistant:'문은 닫혀 있었다.'});
const completed=[];
const watchdog=setTimeout(()=>{console.error('indeterminate regression did not complete');process.exit(1);},100000);
async function run(name, setup, check) {
 const store=createStore(); const ctl=setup(store);
 const r=await createHayakuRuntime({pluginStorage:store,pluginSourceFile:process.env.HAYAKU_UNDER_TEST});
 try { await check(r,ctl,store); completed.push(name); console.log('PASS '+name); }
 finally { await r.dispose(); ctl.release?.(); }
}
(async()=>{
 await run('2.2s write settles, physical readback precedes success, each key written once', store=>{
  const old=store.setItem.bind(store), counts=new Map();
  store.setItem=async(k,v)=>{if(isEvidence(k)){counts.set(k,(counts.get(k)||0)+1);if(String(k).includes('::user::0'))await pause(2200);}return old(k,v);};return {counts};
 },async(r,c)=>{const result=await r.hayaku._test.writeRecoveryEvidenceSidecar(input());assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.durable,true);assert.ok([...c.counts.values()].every(n=>n===1));const read=await r.hayaku._test.readRecoveryEvidenceSidecar(result.manifestRef);assert.equal(read.ok,true);assert.equal(r.llmCalls.length,0);});
 await run('slow initial physical read is not treated as missing',store=>{
  const old=store.getItem.bind(store);let slow=false;const put=store.setItem.bind(store);let count=0;
  store.getItem=async k=>{if(isEvidence(k)&&slow)await pause(2200);return old(k);};
  store.setItem=async(k,v)=>{if(isEvidence(k))count++;return put(k,v);};return {setSlow:v=>slow=v,count:()=>count};
 },async(r,c)=>{const first=await r.hayaku._test.writeRecoveryEvidenceSidecar(input('slowread'));assert.equal(first.ok,true);const n=c.count();c.setSlow(true);const again=await r.hayaku._test.writeRecoveryEvidenceSidecar(input('slowread'));assert.equal(again.ok,true,JSON.stringify(again));assert.equal(c.count(),n,'no duplicate write after slow get');});
 await run('unsettled write stays pending; a retry joins original, never duplicate',store=>{
  const old=store.setItem.bind(store);let release;const gate=new Promise(resolve=>{release=resolve;});let calls=0;
  store.setItem=async(k,v)=>{if(String(k).includes('recovery_evidence_chunk.')&&String(k).endsWith('::user::0')){calls++;await gate;}return old(k,v);};return {release,calls:()=>calls};
 },async(r,c)=>{const pending=await r.hayaku._test.writeRecoveryEvidenceSidecar(input('pending'));assert.equal(pending.durable,false);assert.equal(pending.storageState,'indeterminate');assert.equal(pending.preservedForRetry,true);const retry=r.hayaku._test.writeRecoveryEvidenceSidecar(input('pending'));await pause(100);c.release();const done=await retry;assert.equal(done.ok,true,JSON.stringify(done));assert.equal(c.calls(),1);assert.equal(r.llmCalls.length,0);});
 await run('unreadable storage prevents write; never interpret timeout as absent',store=>{
  const put=store.setItem.bind(store);let writes=0;store.getItem=async k=>isEvidence(k)?new Promise(()=>{}):null;store.setItem=async(k,v)=>{if(isEvidence(k))writes++;return put(k,v);};return {writes:()=>writes};
 },async(r,c)=>{const result=await r.hayaku._test.writeRecoveryEvidenceSidecar(input('unreadable'));assert.equal(result.durable,false);assert.equal(result.storageState,'indeterminate');assert.equal(c.writes(),0);assert.equal(r.llmCalls.length,0);});
 await run('definite write rejection remains failed with zero model calls',store=>{
  const old=store.setItem.bind(store);store.setItem=async(k,v)=>{if(isEvidence(k))throw Error('disk_refused');return old(k,v);};return {};
 },async r=>{const result=await r.hayaku._test.writeRecoveryEvidenceSidecar(input('reject'));assert.equal(result.ok,false);assert.match(result.reason,/write_rejected/);assert.equal(r.llmCalls.length,0);});
 console.log(JSON.stringify({test:'hayaku_recovery_evidence_indeterminate_runtime',passed:completed.length,cases:completed}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
