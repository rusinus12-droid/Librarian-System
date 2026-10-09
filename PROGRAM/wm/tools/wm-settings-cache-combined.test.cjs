'use strict';
// Removal of an owned configuration-publication notification must fail the ABA cases.
// Premature CONFIG publication must fail the rejected/held-readback cases.
const test=require('node:test'),assert=require('node:assert/strict');
const {loadGui}=require('./wm-cache-currentness-gui-support.cjs');
const cfg=()=>({enabled:true,provider:'ollama',url:'http://127.0.0.1:9999/api/embed',key:'',model:'tiny-3',timeout:120000});
const copy=x=>JSON.parse(JSON.stringify(x));
const tuple=c=>Object.fromEntries(['maxLimit','threshold','simThreshold','gcBatchSize'].map(k=>[k,c[k]]));
const large={maxLimit:560,threshold:3,simThreshold:.15,gcBatchSize:12};
const small={maxLimit:180,threshold:5,simThreshold:.25,gcBatchSize:6};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn){const end=Date.now()+5000;while(!fn()){assert(Date.now()<end,'actual GUI save must settle');await pause(10)}}
async function imported(f,obj){await f.overlay.querySelector('#settings-file-input').onchange({target:{files:[{name:'combined-synthetic.json',text:async()=>JSON.stringify(obj)}]}})}
function form(f,enabled,debug,preset){
 const p=f.overlay.querySelector('#smempreset');p.value=preset;p.dispatchEvent(new f.w.Event('change',{bubbles:true}));
 f.overlay.querySelector('#sdebug').checked=debug;
 f.overlay.querySelector('#seenabled').checked=enabled;
}
async function manual(f){f.overlay.querySelector('#btn-save-settings').onclick();await waitFor(()=>['saved','failed'].includes(f.overlay.querySelector('#settings-auto-save-status').dataset.state));}
async function reset(f){const task=f.overlay.querySelector('#btn-reset-settings').onclick();const modal=f.w.document.querySelector('[data-libra-dialog="true"]');assert(modal);[...modal.querySelectorAll('button')].find(n=>n.textContent==='확인').click();await task;}
async function pendingFixture(label){
 let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);let calls=0;
 const f=await loadGui({args:{embedding_enabled:''},nativeInitialization:true,nativeFetch:async()=>{calls++;enter();await gate;return {ok:true,status:200,text:async()=>JSON.stringify({embeddings:[[1,.25,-.5]]})}}});
 await imported(f,{embed:cfg(),debug:false});const m=f.api.MemoryEngine,identity=m.CONFIG;
 m.getCachedMeta({key:'composition-meta',content:'[META:{"t":1,"imp":8}]\nSynthetic'});const meta=f.api.MemoryState.metaCache;
 const text='Synthetic combined '+label;const old=m.EmbeddingEngine.getEmbedding(text);await entered;
 return {f,m,identity,meta,text,old,release,calls:()=>calls};
}
for(const fault of ['false','throw','false-ack','readback-mismatch'])test('combined rejected manual '+fault+' preserves settings and pending embedding',async()=>{
 const x=await pendingFixture(fault),{f,m}=x;const prior=tuple(m.CONFIG);const storage=f.w.risuai.pluginStorage,set=storage.setItem.bind(storage),get=storage.getItem.bind(storage);let wrote=false;
 storage.setItem=async(k,v)=>{if(k!=='LMAI_Config')return set(k,v);wrote=true;if(fault==='false')return false;if(fault==='throw')throw Error('synthetic failure');if(fault==='false-ack')return true;return set(k,v)};
 storage.getItem=async k=>k==='LMAI_Config'&&wrote&&fault==='readback-mismatch'?'{}':get(k);
 try{
  form(f,false,true,'sim_large');await manual(f);
  assert.equal(f.overlay.querySelector('#settings-auto-save-status').dataset.state,'failed');assert.equal(m.CONFIG,x.identity);assert.equal(m.CONFIG.embed.enabled,true);assert.equal(m.CONFIG.debug,false);assert.deepEqual(tuple(m.CONFIG),prior);
  assert.equal(f.overlay.querySelector('#sdebug-status').classList.contains('is-ok'),false);assert.equal(f.api.MemoryState.metaCache,x.meta);
  x.release();assert.deepEqual(copy(await x.old),[1,.25,-.5]);assert.deepEqual(copy(await m.EmbeddingEngine.getEmbedding(x.text)),[1,.25,-.5]);assert.equal(x.calls(),1);
 }finally{x.release();f.close()}
});
test('combined failed import does not publish settings or retire pending embedding',async()=>{
 const x=await pendingFixture('failed import'),{f,m}=x,prior=tuple(m.CONFIG),s=f.w.risuai.pluginStorage,set=s.setItem.bind(s);
 s.setItem=async(k,v)=>k==='LMAI_Config'?false:set(k,v);
 try{await imported(f,{embed:{...cfg(),enabled:false},debug:true,memoryPreset:'sim_large'});assert.equal(m.CONFIG,x.identity);assert.equal(m.CONFIG.embed.enabled,true);assert.equal(m.CONFIG.debug,false);assert.deepEqual(tuple(m.CONFIG),prior);x.release();assert.deepEqual(copy(await x.old),[1,.25,-.5]);assert.equal(x.calls(),1)}finally{x.release();f.close()}
});
test('combined physically written but unverified settings preserve current embedding until readback',async()=>{
 const x=await pendingFixture('held readback'),{f,m}=x,prior=tuple(m.CONFIG),s=f.w.risuai.pluginStorage,set=s.setItem.bind(s),get=s.getItem.bind(s);let wrote=false,releaseRead,enteredRead;const held=new Promise(r=>enteredRead=r),gate=new Promise(r=>releaseRead=r);
 s.setItem=async(k,v)=>{const result=await set(k,v);if(k==='LMAI_Config')wrote=true;return result};s.getItem=async k=>{if(k==='LMAI_Config'&&wrote){enteredRead();await gate}return get(k)};
 try{
  form(f,false,true,'sim_large');f.overlay.querySelector('#btn-save-settings').onclick();await Promise.race([held,pause(5000).then(()=>{throw Error('readback barrier not reached')})]);
  assert.equal(JSON.parse(f.store.get('LMAI_Config')).embed.enabled,false);assert.equal(m.CONFIG.embed.enabled,true);assert.equal(m.CONFIG.debug,false);assert.deepEqual(tuple(m.CONFIG),prior);assert.equal(f.overlay.querySelector('#sdebug-status').classList.contains('is-ok'),false);
  x.release();assert.deepEqual(copy(await x.old),[1,.25,-.5]);assert.equal(m.getCacheStats().embedding.size,1);
  releaseRead();await waitFor(()=>f.overlay.querySelector('#settings-auto-save-status').dataset.state==='saved');assert.equal(m.CONFIG.embed.enabled,false);assert.equal(m.CONFIG.debug,true);assert.deepEqual(tuple(m.CONFIG),large);assert.equal(await m.EmbeddingEngine.getEmbedding(x.text),null);assert.equal(x.calls(),1);assert.equal(m.CONFIG,x.identity);assert.equal(f.api.MemoryState.metaCache,x.meta);
 }finally{releaseRead();x.release();f.close()}
});
for(const kind of ['manual','autosave','import','reset'])test('combined actual '+kind+' ABA fences pending embedding while publishing preset and debug',async()=>{
 const x=await pendingFixture(kind),{f,m}=x;
 try{
  if(kind==='reset'){await reset(f);await imported(f,{embed:cfg(),debug:true,memoryPreset:'sim_large'});}
  else for(const enabled of [false,true]){
   if(kind==='import')await imported(f,{embed:{...cfg(),enabled},debug:true,memoryPreset:'sim_large'});
   else{form(f,enabled,true,'sim_large');if(kind==='manual')await manual(f);else{f.overlay.querySelector('#seenabled').dispatchEvent(new f.w.Event('change',{bubbles:true}));await waitFor(()=>m.CONFIG.embed.enabled===enabled&&f.overlay.querySelector('#settings-auto-save-status').dataset.state==='saved');}}
   assert.equal(m.CONFIG.embed.enabled,enabled);assert.equal(m.CONFIG.debug,true);assert.deepEqual(tuple(m.CONFIG),large);
  }
  assert.equal(m.CONFIG,x.identity);assert.equal(f.api.MemoryState.metaCache,x.meta);assert.equal(m.CONFIG.debug,true);assert.deepEqual(tuple(m.CONFIG),large);assert.equal(JSON.parse(f.store.get('LMAI_Config')).memoryPreset,'sim_large');
  x.release();assert.equal(await x.old,null);assert.equal(m.getCacheStats().embedding.size,0);assert.equal(x.calls(),1);
 }finally{x.release();f.close()}
});
test('combined unrelated preset and debug publication keeps a compatible completed hit across cold settings restore',async()=>{
 const x=await pendingFixture('unrelated'),{f,m}=x;let fresh;
 try{
  x.release();assert.deepEqual(copy(await x.old),[1,.25,-.5]);
  form(f,true,true,'sim_large');await manual(f);assert.equal(m.CONFIG.debug,true);assert.deepEqual(tuple(m.CONFIG),large);assert.deepEqual(copy(await m.EmbeddingEngine.getEmbedding(x.text)),[1,.25,-.5]);assert.equal(x.calls(),1);
  fresh=await loadGui({store:f.store,args:{embedding_enabled:''},nativeInitialization:true});assert.equal(fresh.preGuiConfig.debug,true);assert.deepEqual(tuple(fresh.preGuiConfig),large);assert.equal(fresh.preGuiConfig.embed.enabled,true);assert.equal(m.CONFIG,x.identity);assert.equal(f.api.MemoryState.metaCache,x.meta);
 }finally{x.release();fresh?.close();f.close()}
});
