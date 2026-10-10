'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRootBoundary}=require('./fixtures/source_edit_root_boundary.cjs');
const code=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceEditConsent.source.js'),'utf8');
const context=vm.createContext({setTimeout,clearTimeout,console});vm.runInContext(code+';this.factory=createMemorySuiteSourceEditConsent;',context);
(async()=>{
  const root=createRootBoundary(),store=new Map();let prompts=0,executions=0;
  const controller=context.factory({owner:'libra',requestBoundary:true,api:()=>({getRootDocument:async()=>root.root}),
    read:async k=>store.get(k)??null,write:async(k,v)=>{store.set(k,v);return true;},
    collect:async()=>({scopeKey:'A',units:[{key:'1',start:1,end:5,digest:'new',sourceDigest:'new',originalDigest:'old',basis:'b',identity:'i',changed:true}]}),
    prompt:async()=>{prompts++;return{decision:'approve',keys:['1']};},execute:async()=>{executions++;return{ok:false,error:'packet_readback_failed'};}});
  try{
    await controller.beforeRequest();
    assert.equal(prompts,0);assert.equal(executions,1);assert.equal(await root.ready(),false,'automatic processing does not mount SafeElement dialogs');
    assert.equal(controller.status().tasks[0].state,'failed');assert.match(controller.status().tasks[0].error,/packet_readback_failed/);
    assert.equal((await controller.review()).reason,'automatic_before_request_only');assert.equal(prompts,0);assert.equal(executions,1);
    assert.equal(await root.ready(),false);
    console.log(JSON.stringify({test:'source_edit_safe_dialog',passed:2}));
  }finally{controller.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
