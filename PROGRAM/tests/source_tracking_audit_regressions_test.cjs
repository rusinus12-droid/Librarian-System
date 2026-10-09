'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {test}=require('node:test');
const context=vm.createContext({setTimeout,clearTimeout,Date,console});vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceEditConsent.source.js'),'utf8'),context);
const clone=x=>JSON.parse(JSON.stringify(x));
function make(initial){
  const store=new Map();let snapshot={scopeKey:'chat',units:clone(initial)},calls=0,prompts=0;
  const c=context.createMemorySuiteSourceEditConsent({owner:'audit',requestBoundary:true,read:async k=>store.get(k)??null,write:async(k,v)=>{store.set(k,v);return true;},
    collect:async()=>clone(snapshot),prompt:async()=>{prompts++;return{decision:'approve',keys:[]};},execute:async(_t,p)=>{await p.assertCurrent();calls++;return{ok:true};}});
  return{c,store,set units(value){snapshot.units=clone(value);},get units(){return clone(snapshot.units);},get calls(){return calls;},get prompts(){return prompts;}};
}
const u=(key,start,{digest,sourceDigest= digest,originalDigest='old-'+key,basis='basis-'+key,identity='id-'+key,changed=true,current=false,changeKind='source_changed'}={})=>({key,start,end:start,digest,sourceDigest,originalDigest,basis,identity,changed,current,changeKind});

test('read-only observation invalidates an applied write receipt after dependency change',async()=>{
  const f=make([u('1',1,{digest:'new',sourceDigest:'new'})]);try{
    await f.c.beforeRequest();assert.equal(f.c.status().tasks[0].state,'applied');assert.equal(f.c.canWrite('chat','1','new'),true);
    const changed=u('1',1,{digest:'new',sourceDigest:'new',basis:'basis-changed'});f.units=[changed];
    await f.c.inspect({scopeKey:'chat',units:f.units});
    assert.equal(f.c.canWrite('chat','1','new'),false);
    assert.equal(f.c.status().tasks[0].state,'applied','read-only guard does not mutate the source journal');
    assert.equal(f.c.status().events.length,1,'read-only guard does not create source-edit history');
  }finally{f.c.dispose();}
});

test('OFF then automatic establishes a baseline; later direct and dependent edits reconcile',async()=>{
  const f=make([u('6',6,{digest:'six',sourceDigest:'six'}),u('11',11,{digest:'eleven',sourceDigest:'eleven',originalDigest:'eleven',changed:false,current:true})]);try{
    await f.c.setMode('off');await f.c.setMode('auto');await f.c.beforeRequest();assert.equal(f.calls,0);assert.equal(f.c.status().tasks.length,0);
    f.c.afterRequest();f.units=[u('6',6,{digest:'six-new',sourceDigest:'six-new',basis:'prefix-new'}),u('11',11,{digest:'eleven',sourceDigest:'eleven',originalDigest:'eleven',basis:'prefix-new',changeKind:'dependency_affected'})];
    await f.c.beforeRequest();assert.deepEqual(Array.from(f.c.status().tasks,task=>task.key),['6','11']);assert.equal(f.calls,2);
    assert.equal(f.c.status().tasks[1].changeKind,'dependency_affected');
  }finally{f.c.dispose();}
});

test('two owner controllers automatically process independently without prompts',async()=>{
  const a=make([u('1',1,{digest:'a-new',sourceDigest:'a-new'})]),b=make([u('1',1,{digest:'b-new',sourceDigest:'b-new'})]);try{
    await Promise.all([a.c.beforeRequest(),b.c.beforeRequest()]);
    assert.equal(a.calls,1);assert.equal(b.calls,1);assert.equal(a.prompts+b.prompts,0);
    assert.equal(a.c.status().tasks[0].state,'applied');assert.equal(b.c.status().tasks[0].state,'applied');
  }finally{a.c.dispose();b.c.dispose();}
});
