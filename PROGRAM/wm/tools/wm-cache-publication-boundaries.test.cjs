'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadGui}=require('./wm-cache-currentness-gui-support.cjs');
const {decodePhysical}=require('./libra_portable_settings_fixture.cjs');
const cfg=()=>({enabled:true,provider:'ollama',url:'http://127.0.0.1:9999/api/embed',key:'',model:'tiny-3',timeout:120000});
const seed=()=>new Map([['LMAI_Config',JSON.stringify({embed:cfg(),debug:false,dualRecallMode:'legacy'})]]);
async function bounded(work,label){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),5000)})]);}finally{clearTimeout(timer);}}
async function waitFor(fn){const deadline=Date.now()+5000;while(!fn()){assert(Date.now()<deadline,'registered GUI publication settled');await new Promise(r=>setTimeout(r,10));}}
async function closeFixture(f,work){try{if(work)await bounded(work,'pending embedding cleanup settles');for(const callback of f.callbacks.unload||[])await bounded(Promise.resolve().then(()=>callback()),'runtime unload settles');}finally{f.close();}}
async function reset(f){const pending=f.overlay.querySelector('#btn-reset-settings').onclick();const modal=f.w.document.querySelector('[data-libra-dialog="true"]');assert(modal);[...modal.querySelectorAll('button')].find(n=>n.textContent==='확인').click();await bounded(pending,'registered reset settles');}
async function restoreConnection(f){
 const value=cfg();
 for(const [id,key]of [['sep','provider'],['seu','url'],['sek','key'],['sem','model']]){const input=f.overlay.querySelector('#'+id);assert(input);input.value=value[key];}
 f.overlay.querySelector('#seenabled').checked=true;
 f.overlay.querySelector('#btn-save-settings').onclick();
 await waitFor(()=>f.api.MemoryEngine.CONFIG.embed.provider==='ollama'&&f.api.MemoryEngine.CONFIG.embed.model===value.model&&f.overlay.querySelector('#settings-auto-save-status').dataset.state==='saved');
 for(const key of ['enabled','provider','url','key','model']){assert.equal(f.api.MemoryEngine.CONFIG.embed[key],value[key]);assert.equal(decodePhysical(f.store).embed[key],value[key]);}
}
for(const kind of ['manual save','autosave','reset'])test('real '+kind+' publication ABA retires old pending legacy embedding',async()=>{
 let started,finish,old;const ready=new Promise(r=>started=r),gate=new Promise(r=>finish=r);let calls=0;
 const f=await loadGui({store:seed(),nativeInitialization:true,args:{embedding_enabled:''},nativeFetch:async()=>{calls++;started();await gate;return {ok:true,status:200,text:async()=>JSON.stringify({embeddings:[[1,.25,-.5]]})}}});
 try {
  const m=f.api.MemoryEngine,identity=m.CONFIG;assert.equal(m.CONFIG.embed.enabled,true);assert.equal(m.CONFIG.embed.model,cfg().model);
  old=m.EmbeddingEngine.getEmbedding('Synthetic '+kind+' config publication');old.catch(()=>{});await bounded(ready,'real embedding dispatch reached');
  if(kind==='reset'){await reset(f);await restoreConnection(f);}
  else for(const value of [false,true]){
   const input=f.overlay.querySelector('#seenabled');input.checked=value;
   if(kind==='manual save')f.overlay.querySelector('#btn-save-settings').onclick();
   else input.dispatchEvent(new f.w.Event('change',{bubbles:true}));
   await waitFor(()=>m.CONFIG.embed.enabled===value&&f.overlay.querySelector('#settings-auto-save-status').dataset.state==='saved');
   assert.equal(decodePhysical(f.store).embed.enabled,value);
  }
  assert.equal(calls,1,'settings publications do not dispatch another provider request');
  finish();assert.equal(await bounded(old,'old embedding settles'),null);assert.equal(m.CONFIG,identity);assert.equal(m.getCacheStats().embedding.size,0);assert.equal(calls,1);
 }finally{finish();await closeFixture(f,old);}
});
test('unrelated successful GUI autosave preserves a completed embedding cache hit',async()=>{
 let calls=0;const f=await loadGui({store:seed(),nativeInitialization:true,args:{embedding_enabled:''},nativeFetch:async()=>{calls++;return {ok:true,status:200,text:async()=>JSON.stringify({embeddings:[[1,.25,-.5]]})}}});
 try {
  const m=f.api.MemoryEngine,text='Synthetic unrelated GUI cache hit';assert.equal(m.CONFIG.embed.enabled,true);assert(Array.isArray(await bounded(m.EmbeddingEngine.getEmbedding(text),'initial embedding settles')));
  const input=f.overlay.querySelector('#sdebug');input.checked=true;input.dispatchEvent(new f.w.Event('change',{bubbles:true}));
  await waitFor(()=>m.CONFIG.debug===true&&f.overlay.querySelector('#settings-auto-save-status').dataset.state==='saved');
  assert.equal(decodePhysical(f.store).debug,true);
  assert(Array.isArray(await bounded(m.EmbeddingEngine.getEmbedding(text),'completed cache hit settles')));assert.equal(calls,1);
 }finally{await closeFixture(f);}
});
