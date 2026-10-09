'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRootBoundary}=require('./fixtures/source_edit_root_boundary.cjs');
const ctx=vm.createContext({setTimeout,clearTimeout,console});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceEditConsent.source.js'),'utf8')+';this.factory=createMemorySuiteSourceEditConsent;',ctx);
(async()=>{
  const root=createRootBoundary(),counts={libra:0,hayaku:0},prompts={libra:0,hayaku:0},controllers=[];
  const make=owner=>{const store=new Map(),c=ctx.factory({owner,requestBoundary:true,api:()=>({getRootDocument:async()=>root.root}),
    read:async k=>store.get(k),write:async(k,v)=>{store.set(k,v);return true;},
    collect:async()=>({scopeKey:'A',units:[{key:'1',start:1,end:1,digest:owner+'-new',sourceDigest:owner+'-new',originalDigest:owner+'-old',basis:'b',identity:owner,changed:true}]}),
    prompt:async()=>{prompts[owner]++;return{decision:'approve',keys:['1']};},execute:async()=>{counts[owner]++;return{ok:true};}});controllers.push(c);return c;};
  try{
    const libra=make('libra'),hayaku=make('hayaku');
    await Promise.all([libra.beforeRequest(),hayaku.beforeRequest()]);
    assert.equal(counts.libra,1);assert.equal(counts.hayaku,1);
    assert.deepEqual(prompts,{libra:0,hayaku:0});
    assert.equal(await root.ready(),false,'no owner claims a popup or dialog slot');
    assert.equal((await libra.review()).reason,'automatic_before_request_only');
    assert.equal((await hayaku.review()).reason,'automatic_before_request_only');
    assert.equal(counts.libra+counts.hayaku,2,'manual review cannot rerun or authorize an automatic task');
    console.log(JSON.stringify({test:'source_edit_multi_owner_dialog',passed:2}));
  }finally{for(const c of controllers)c.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
