'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {test}=require('node:test');
const context=vm.createContext({setTimeout,clearTimeout,Date,console});vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceEditConsent.source.js'),'utf8'),context);

test('missing previous raw is rebuilt automatically with uncertainty and no fabricated diff',async()=>{
  const store=new Map();let prompts=0,calls=0;
  const controller=context.createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,
    read:async k=>store.get(k)??null,write:async(k,v)=>{store.set(k,v);return true;},
    collect:async()=>({scopeKey:'chat',units:[{key:'6',start:6,end:6,digest:'under-new-policy',sourceDigest:'under-new-policy',rawDigest:'raw-current',originalDigest:'under-old-policy',originalRawDigest:'',policyUncertain:true,basis:'b',identity:'pair-6',changed:false,current:false}]}),
    prompt:async()=>{prompts++;return{decision:'approve',keys:['6']};},execute:async(task,permit)=>{await permit.assertCurrent();calls++;return{ok:true};}});
  try{
    await controller.setSourceRules({version:1,sourceTags:[{open:'<original>',close:'</original>'}],ignoredTags:[],unwrapTags:[],controls:[]});
    await controller.beforeRequest();
    const task=controller.status().tasks[0],event=controller.status().events[0];
    assert.equal(calls,1);assert.equal(prompts,0);assert.equal(task.state,'applied');
    assert.equal(task.changeKind,'projection_policy_changed');assert.equal(task.policyUncertain,true);
    assert.equal(event.policyUncertain,true);assert.equal('beforeText' in event,false);assert.equal('afterText' in event,false);
    assert.equal((await controller.review()).reason,'automatic_before_request_only');
  }finally{controller.dispose();}
});

test('ordinary failed owner execution reports the exact failure without an approval path',async()=>{
  const store=new Map();let calls=0,prompts=0;
  const controller=context.createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,read:async k=>store.get(k)??null,
    write:async(k,v)=>{store.set(k,v);return true;},collect:async()=>({scopeKey:'chat',units:[{key:'1',start:1,end:1,digest:'new',sourceDigest:'new',originalDigest:'old',basis:'b',identity:'i',changed:true}]}),
    prompt:async()=>{prompts++;return{decision:'approve',keys:['1']};},execute:async()=>{calls++;return{ok:false,error:'owner_readback_failed'};}});
  try{await controller.beforeRequest();assert.equal(calls,1);assert.equal(prompts,0);assert.equal(controller.status().tasks[0].state,'failed');assert.match(controller.status().tasks[0].error,/owner_readback_failed/);}
  finally{controller.dispose();}
});
