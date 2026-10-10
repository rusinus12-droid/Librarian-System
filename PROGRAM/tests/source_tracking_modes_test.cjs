'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {test}=require('node:test');
const context=vm.createContext({setTimeout,clearTimeout,Date,console});vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceEditConsent.source.js'),'utf8'),context);
const copy=x=>JSON.parse(JSON.stringify(x));
function fixture(values=new Map()){
  let snapshot={scopeKey:'chat',completedTurnIds:[],units:[{key:'1',start:1,end:1,digest:'d1',sourceDigest:'s1',originalDigest:'s0',rawDigest:'r1',originalRawDigest:'r0',identity:'pair',basis:'basis',changed:true,current:false}]},calls=0,prompts=0;
  const c=context.createMemorySuiteSourceEditConsent({owner:'test',requestBoundary:true,read:async k=>values.get(k)??null,write:async(k,v)=>{values.set(k,v);return true;},collect:async()=>copy(snapshot),prompt:async()=>{prompts++;return{decision:'approve',keys:['1']};},execute:async(_t,p)=>{await p.assertCurrent();calls++;return{ok:true};}});
  return{c,values,get snapshot(){return snapshot;},set snapshot(v){snapshot=v;},change(patch){snapshot={...snapshot,units:snapshot.units.map(u=>u.key==='1'?{...u,...patch}:u)};},get calls(){return calls;},get prompts(){return prompts;}};
}

test('tracking controls expose only automatic and off modes',async()=>{const f=fixture();try{
  await f.c.ready();await f.c.setMode('silent');assert.equal(f.c.status().mode,'auto');await f.c.setMode('notify');assert.equal(f.c.status().mode,'auto');
  await assert.rejects(()=>f.c.setMode('manual'),/MODE_INVALID/);
}finally{f.c.dispose();}});

test('off skips detection and re-enable establishes a baseline without backfilling edits',async()=>{const f=fixture();try{
  await f.c.setMode('off');f.change({digest:'disabled-edit',sourceDigest:'disabled-edit',rawDigest:'raw-disabled'});
  await f.c.beforeRequest();assert.equal(f.calls,0);assert.equal(f.c.status().tasks.length,0);
  await f.c.setMode('auto');await f.c.beforeRequest();assert.equal(f.calls,0);assert.equal(f.c.status().tasks.length,0);
  f.c.afterRequest();f.change({digest:'next-edit',sourceDigest:'next-edit',rawDigest:'raw-next'});await f.c.beforeRequest();
  assert.equal(f.calls,1);assert.equal(f.c.status().tasks[0].sourceDigest,'next-edit');
}finally{f.c.dispose();}});

test('legacy silent and notify preferences migrate to auto',async()=>{for(const mode of ['silent','notify']){const store=new Map([['__source_tracking_preferences_v1__',JSON.stringify({mode,epoch:0})]]),f=fixture(store);try{
  await f.c.ready();assert.equal(f.c.status().mode,'auto');assert.equal(JSON.parse(store.get('__source_tracking_preferences_v1__')).mode,'auto');
}finally{f.c.dispose();}}});

test('background inspection and manual review cannot trigger processing',async()=>{const f=fixture();try{
  await f.c.inspect(f.snapshot);assert.equal(f.c.status().tasks.length,0);assert.equal(f.calls,0);
  assert.equal((await f.c.review()).reason,'automatic_before_request_only');assert.equal(f.prompts,0);assert.equal(f.calls,0);
  await f.c.beforeRequest();assert.equal(f.calls,1);assert.equal(f.prompts,0);
}finally{f.c.dispose();}});

test('failed automatic writes surface their failure and can retry on the next request',async()=>{let attempts=0;const f=fixture();
  // Recreate with the same stable snapshot and an owner that fails once.
  f.c.dispose();const store=new Map();const unit={key:'1',start:1,end:1,digest:'d1',sourceDigest:'s1',originalDigest:'s0',identity:'pair',basis:'basis',changed:true,current:false};
  const c=context.createMemorySuiteSourceEditConsent({owner:'test',requestBoundary:true,read:async k=>store.get(k)??null,write:async(k,v)=>{store.set(k,v);return true;},collect:async()=>({scopeKey:'chat',units:[unit]}),execute:async(_t,p)=>{await p.assertCurrent();attempts++;if(attempts===1)throw Error('transient');return{ok:true};}});
  try{await c.beforeRequest();assert.equal(c.status().tasks[0].state,'failed');assert.match(c.status().tasks[0].error,/transient/);c.afterRequest();await c.beforeRequest();assert.equal(attempts,2);assert.equal(c.status().tasks[0].state,'applied');}
  finally{c.dispose();}
});
