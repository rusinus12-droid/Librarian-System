'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const code=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceEditConsent.source.js'),'utf8');
const context=vm.createContext({setTimeout,clearTimeout,Date,console});vm.runInContext(code+'\nthis.factory=createMemorySuiteSourceEditConsent;',context);
function fixture(overrides={}){
  const db=overrides.db||new Map();let unit={key:'1',start:1,end:1,digest:'new',sourceDigest:'new',rawDigest:'raw-new',originalDigest:'old',originalRawDigest:'raw-old',basis:'basis-new',identity:'pair-1',changed:true,current:false};
  let calls=0,prompts=0;
  const controller=context.factory({owner:'test',requestBoundary:true,read:async k=>db.get(k)??null,write:async(k,v)=>{db.set(k,v);return true;},
    collect:async()=>({scopeKey:'chat',units:[{...unit}]}),prompt:async()=>{prompts++;return{decision:'approve',keys:['1']};},
    execute:async(task,permit)=>{await permit.assertCurrent();calls++;return{ok:true};},...overrides});
  return{controller,db,setUnit:value=>{unit={...unit,...value};},get calls(){return calls;},get prompts(){return prompts;}};
}

test('beforeRequest automatically reconciles and never opens a consent dialog',async()=>{
  const f=fixture();try{await f.controller.beforeRequest();assert.equal(f.calls,1);assert.equal(f.prompts,0);assert.equal(f.controller.status().tasks[0].state,'applied');}
  finally{f.controller.dispose();}
});

test('manual review and background refresh cannot process source edits',async()=>{
  const f=fixture();try{await f.controller.refresh();assert.equal(f.calls,0);assert.equal(f.controller.status().tasks.length,0);
    assert.equal((await f.controller.review()).reason,'automatic_before_request_only');assert.equal(f.prompts,0);assert.equal(f.calls,0);
    await f.controller.beforeRequest();assert.equal(f.calls,1);assert.equal(f.prompts,0);
  }finally{f.controller.dispose();}
});

test('an automatic processing failure is truthful and only retried at a later request',async()=>{
  let calls=0;const f=fixture({execute:async(_task,permit)=>{await permit.assertCurrent();calls++;if(calls===1)throw Error('provider_failed');return{ok:true};}});
  try{await f.controller.beforeRequest();assert.equal(calls,1);assert.equal(f.controller.status().tasks[0].state,'failed');assert.match(f.controller.status().tasks[0].error,/provider_failed/);
    f.controller.afterRequest();await f.controller.beforeRequest();assert.equal(calls,2);assert.equal(f.controller.status().tasks[0].state,'applied');
  }finally{f.controller.dispose();}
});

test('a source mutation during automatic work invalidates that result',async()=>{
  let release,started;const waiting=new Promise(resolve=>{started=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  let calls=0;const f=fixture({execute:async(_task,permit)=>{calls++;if(calls===1){started();await gate;await permit.assertCurrent();}else await permit.assertCurrent();return{ok:true};}});
  try{const pending=f.controller.beforeRequest();await waiting;f.setUnit({digest:'newer',sourceDigest:'newer',rawDigest:'raw-newer'});release();await pending;
    assert.equal(f.controller.status().tasks[0].state,'failed');assert.match(f.controller.status().tasks[0].error,/SOURCE_CHANGED/);
    f.controller.afterRequest();await f.controller.beforeRequest();assert.equal(calls,2);assert.equal(f.controller.status().tasks[0].sourceDigest,'newer');
  }finally{f.controller.dispose();}
});

test('legacy notification modes migrate to automatic only',async()=>{
  for(const mode of ['notify','silent']){const db=new Map([['__source_tracking_preferences_v1__',JSON.stringify({mode,epoch:0})]]),f=fixture({db});try{
    await f.controller.ready();assert.equal(f.controller.status().mode,'auto');assert.equal(JSON.parse(db.get('__source_tracking_preferences_v1__')).mode,'auto');
  }finally{f.controller.dispose();}}
});
