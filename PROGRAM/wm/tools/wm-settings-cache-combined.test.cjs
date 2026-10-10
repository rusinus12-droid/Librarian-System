'use strict';
// Removing the owned publication notification must fail ABA; publishing before
// verified readback must fail the rejected/held cases. Portable model metadata is
// allowed, but enablement is not portable. No assertion grants typed activation.
const test=require('node:test'),assert=require('node:assert/strict');
const {loadGui}=require('./wm-cache-currentness-gui-support.cjs');
const {importSettings,decodePhysical}=require('./libra_portable_settings_fixture.cjs');
const cfg=()=>({enabled:true,provider:'ollama',url:'http://127.0.0.1:9999/api/embed',key:'',model:'tiny-3',timeout:120000});
const copy=x=>JSON.parse(JSON.stringify(x));
const tuple=c=>Object.fromEntries(['maxLimit','threshold','simThreshold','gcBatchSize'].map(k=>[k,c[k]]));
const retentionSeed={maxLimit:180,threshold:5,simThreshold:.25,gcBatchSize:6};
const budget=c=>({injectionBudgetPreset:c.injectionBudgetPreset,injectionBudgetMaxTokens:c.injectionBudgetMaxTokens,injectionBudgetTokens:c.injectionBudgetTokens});
const large={injectionBudgetPreset:'large',injectionBudgetMaxTokens:20000,injectionBudgetTokens:20000};
const compact={injectionBudgetPreset:'compact',injectionBudgetMaxTokens:12000,injectionBudgetTokens:12000};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(work,label){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),5000)})]);}finally{clearTimeout(timer);}}
async function waitFor(fn){const end=Date.now()+5000;while(!fn()){assert(Date.now()<end,'actual GUI save must settle');await pause(10);}}
async function imported(f,obj){return bounded(importSettings(f,obj),'portable preview and Apply settle');}
function form(f,enabled,debug,preset){
 const p=f.overlay.querySelector('#sinjbp');assert(p,'current owned injection-budget control');p.value=preset;
 f.overlay.querySelector('#sdebug').checked=debug;f.overlay.querySelector('#seenabled').checked=enabled;
}
async function manual(f){f.overlay.querySelector('#btn-save-settings').onclick();await waitFor(()=>['saved','failed'].includes(f.overlay.querySelector('#settings-auto-save-status').dataset.state));}
async function reset(f){const task=f.overlay.querySelector('#btn-reset-settings').onclick();const modal=f.w.document.querySelector('[data-libra-dialog="true"]');assert(modal);[...modal.querySelectorAll('button')].find(n=>n.textContent==='확인').click();await bounded(task,'actual Reset settles');}
async function restoreConnection(f){
 const value=cfg();for(const [id,key]of [['sep','provider'],['seu','url'],['sek','key'],['sem','model']]){const input=f.overlay.querySelector('#'+id);assert(input);input.value=value[key];}
 f.overlay.querySelector('#seenabled').checked=true;await manual(f);
 assert.equal(f.overlay.querySelector('#settings-auto-save-status').dataset.state,'saved');
 for(const key of ['enabled','provider','url','key','model']){assert.equal(f.api.MemoryEngine.CONFIG.embed[key],value[key]);assert.equal(decodePhysical(f.store).embed[key],value[key]);}
}
async function closeFixture(f,work){try{if(work)await bounded(work,'pending embedding cleanup settles');await bounded(Promise.allSettled(f.pending.splice(0)),'registered event cleanup settles');for(const callback of f.callbacks.unload||[])await bounded(Promise.resolve().then(()=>callback()),'runtime unload settles');}finally{f.close();}}
async function pendingFixture(label){
 let enter,release,f,old;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);let calls=0;
 try{
  const store=new Map([['LMAI_Config',JSON.stringify({embed:cfg(),debug:false,dualRecallMode:'legacy',...retentionSeed,...compact})]]);
  f=await loadGui({store,args:{embedding_enabled:''},nativeInitialization:true,nativeFetch:async()=>{calls++;enter();await gate;return {ok:true,status:200,text:async()=>JSON.stringify({embeddings:[[1,.25,-.5]]})}}});
  const m=f.api.MemoryEngine,identity=m.CONFIG;assert.equal(m.CONFIG.embed.enabled,true);assert.equal(m.CONFIG.embed.model,cfg().model);assert.equal(calls,0);
  m.getCachedMeta({key:'composition-meta',content:'[META:{"t":1,"imp":8}]\nSynthetic'});const meta=f.api.MemoryState.metaCache;
  const text='Synthetic combined '+label;old=m.EmbeddingEngine.getEmbedding(text);old.catch(()=>{});await bounded(entered,'real embedding provider entered');
  return {f,m,identity,meta,text,old,release,calls:()=>calls,retention:tuple(m.CONFIG),storedRetention:tuple(decodePhysical(store)),initialBudget:budget(m.CONFIG)};
 }catch(error){release();if(f)await closeFixture(f,old);throw error;}
}
function retained(x,live=x.retention,stored=x.storedRetention){assert.deepEqual(tuple(x.m.CONFIG),live,'unowned retention tuple stays unchanged');assert.deepEqual(tuple(decodePhysical(x.f.store)),stored,'stored retention tuple stays unchanged');}
function largePublished(f){assert.deepEqual(budget(f.api.MemoryEngine.CONFIG),large);assert.deepEqual(budget(decodePhysical(f.store)),large);}
const typedRows=f=>copy([...f.store].filter(([key])=>key.startsWith('libra:v1:typed-semantic:')));

for(const fault of ['false','throw','false-ack','readback-mismatch'])test('combined rejected manual '+fault+' preserves settings and pending embedding',async()=>{
 const x=await pendingFixture(fault),{f,m}=x;const prior=tuple(m.CONFIG);const storage=f.w.risuai.pluginStorage,set=storage.setItem.bind(storage),get=storage.getItem.bind(storage);let wrote=false;
 storage.setItem=async(k,v)=>{if(k!=='LMAI_Config')return set(k,v);wrote=true;if(fault==='false')return false;if(fault==='throw')throw Error('synthetic failure');if(fault==='false-ack')return true;return set(k,v);};
 storage.getItem=async k=>k==='LMAI_Config'&&wrote&&fault==='readback-mismatch'?'{}':get(k);
 try{
  form(f,false,true,'large');await manual(f);assert(wrote,'rejected save reaches the physical writer');
  assert.equal(f.overlay.querySelector('#settings-auto-save-status').dataset.state,'failed');assert.equal(m.CONFIG,x.identity);assert.equal(m.CONFIG.embed.enabled,true);assert.equal(m.CONFIG.debug,false);assert.deepEqual(tuple(m.CONFIG),prior);assert.deepEqual(budget(m.CONFIG),x.initialBudget);retained(x);
  assert.equal(f.overlay.querySelector('#sdebug-status').classList.contains('is-ok'),false);assert.equal(f.api.MemoryState.metaCache,x.meta);
  x.release();assert.deepEqual(copy(await bounded(x.old,'pending old embedding settles')),[1,.25,-.5]);assert.deepEqual(copy(await bounded(m.EmbeddingEngine.getEmbedding(x.text),'compatible cache hit settles')),[1,.25,-.5]);assert.equal(x.calls(),1);
 }finally{x.release();storage.setItem=set;storage.getItem=get;await closeFixture(f,x.old);}
});
test('combined failed import does not publish settings or retire pending embedding',async()=>{
 const x=await pendingFixture('failed import'),{f,m}=x,prior=tuple(m.CONFIG),s=f.w.risuai.pluginStorage,set=s.setItem.bind(s);let attempted=0;
 s.setItem=async(k,v)=>{if(k==='LMAI_Config'){attempted++;return false;}return set(k,v);};
 try{
  // Replaces unsupported enabled/memoryPreset transfer with supported metadata,
  // debug and injection-budget fields; it still reaches a real rejected writer.
  await imported(f,{embed:{...cfg(),model:'tiny-3-b'},debug:true,...large});assert.equal(attempted,1);assert.equal(f.overlay.querySelector('#settings-transfer-status').dataset.state,'failed');
  assert.equal(m.CONFIG,x.identity);assert.equal(m.CONFIG.embed.enabled,true);assert.equal(m.CONFIG.embed.model,cfg().model);assert.equal(m.CONFIG.debug,false);assert.deepEqual(tuple(m.CONFIG),prior);assert.deepEqual(budget(m.CONFIG),x.initialBudget);retained(x);
  x.release();assert.deepEqual(copy(await bounded(x.old,'failed-import pending embedding settles')),[1,.25,-.5]);assert.equal(x.calls(),1);
 }finally{x.release();s.setItem=set;await closeFixture(f,x.old);}
});
test('combined physically written but unverified settings preserve current embedding until readback',async()=>{
 const x=await pendingFixture('held readback'),{f,m}=x,prior=tuple(m.CONFIG),s=f.w.risuai.pluginStorage,set=s.setItem.bind(s),get=s.getItem.bind(s);let wrote=false,releaseRead,enteredRead;const held=new Promise(r=>enteredRead=r),gate=new Promise(r=>releaseRead=r);
 s.setItem=async(k,v)=>{const result=await set(k,v);if(k==='LMAI_Config')wrote=true;return result;};s.getItem=async k=>{if(k==='LMAI_Config'&&wrote){enteredRead();await gate;}return get(k);};
 try{
  form(f,false,true,'large');f.overlay.querySelector('#btn-save-settings').onclick();await bounded(held,'readback barrier reached');
  assert.equal(decodePhysical(f.store).embed.enabled,false);assert.deepEqual(budget(decodePhysical(f.store)),large);assert.equal(m.CONFIG.embed.enabled,true);assert.equal(m.CONFIG.debug,false);assert.deepEqual(tuple(m.CONFIG),prior);assert.deepEqual(budget(m.CONFIG),x.initialBudget);retained(x);assert.equal(f.overlay.querySelector('#sdebug-status').classList.contains('is-ok'),false);
  x.release();assert.deepEqual(copy(await bounded(x.old,'embedding finishes while readback is held')),[1,.25,-.5]);assert.equal(m.getCacheStats().embedding.size,1);
  releaseRead();await waitFor(()=>f.overlay.querySelector('#settings-auto-save-status').dataset.state==='saved');assert.equal(m.CONFIG.embed.enabled,false);assert.equal(m.CONFIG.debug,true);largePublished(f);retained(x);assert.equal(await bounded(m.EmbeddingEngine.getEmbedding(x.text),'disabled embedding settles'),null);assert.equal(x.calls(),1);assert.equal(m.CONFIG,x.identity);assert.equal(f.api.MemoryState.metaCache,x.meta);
 }finally{releaseRead();x.release();s.setItem=set;s.getItem=get;try{if(wrote)await waitFor(()=>['saved','failed'].includes(f.overlay.querySelector('#settings-auto-save-status').dataset.state));}finally{await closeFixture(f,x.old);}}
});
for(const kind of ['manual','autosave','import','reset'])test('combined actual '+kind+' ABA fences pending embedding while publishing preset and debug',async()=>{
 const x=await pendingFixture(kind),{f,m}=x;let retainedLive=x.retention,retainedStored=x.storedRetention;
 try{
  if(kind==='reset'){
   await reset(f);
   // Reset is an explicit whole-config replacement. Subsequent owned saves must
   // preserve its post-reset retention tuple, not resurrect a retired preset.
   retainedLive=tuple(m.CONFIG);retainedStored=tuple(decodePhysical(f.store));
   await restoreConnection(f);retained(x,retainedLive,retainedStored);
   form(f,true,true,'large');await manual(f);assert.equal(f.overlay.querySelector('#settings-auto-save-status').dataset.state,'saved');
  }else if(kind==='import'){
   // Explicit migration of the old unsupported enabled false/true import ABA:
   // use the supported model A -> B -> A metadata publication route instead.
   // Keep the old request held, with no caller-side embedding observation between.
   const typed=copy(f.api.TypedRecallRollout.inspect()),rows=typedRows(f),enabled=m.CONFIG.embed.enabled,useLLM=m.CONFIG.useLLM;
   for(const model of ['tiny-3-b',cfg().model]){
    const calls=x.calls(),embeddingCalls=m.EmbeddingEngine.getDebugSnapshot().totalCalls,writes=f.calls.writes.filter(row=>row.key==='LMAI_Config').length;
    await imported(f,{embed:{...decodePhysical(f.store).embed,model},debug:true,...large});
    assert.equal(f.overlay.querySelector('#settings-transfer-status').dataset.state,'saved');assert.equal(f.calls.writes.filter(row=>row.key==='LMAI_Config').length,writes+1,'actual Apply invokes one physical writer');
    assert.equal(m.CONFIG.embed.model,model);assert.equal(decodePhysical(f.store).embed.model,model);assert.equal(m.CONFIG.embed.enabled,enabled);assert.equal(decodePhysical(f.store).embed.enabled,enabled);assert.equal(m.CONFIG.useLLM,useLLM);
    for(const key of ['provider','url','key'])assert.equal(m.CONFIG.embed[key],cfg()[key]);
    assert.equal(x.calls(),calls,'imports do not dispatch a provider request');assert.equal(m.EmbeddingEngine.getDebugSnapshot().totalCalls,embeddingCalls,'no getEmbedding call between imports');
    assert.deepEqual(copy(f.api.TypedRecallRollout.inspect()),typed,'portable cache fence does not configure or activate typed recall');assert.deepEqual(typedRows(f),rows);assert.equal(f.calls.hostWrites.length,0);
    assert.equal(m.CONFIG,x.identity);assert.equal(m.CONFIG.debug,true);largePublished(f);retained(x);
   }
  }else for(const enabled of [false,true]){
   form(f,enabled,true,'large');if(kind==='manual')await manual(f);else{f.overlay.querySelector('#seenabled').dispatchEvent(new f.w.Event('change',{bubbles:true}));await waitFor(()=>m.CONFIG.embed.enabled===enabled&&f.overlay.querySelector('#settings-auto-save-status').dataset.state==='saved');}
   assert.equal(m.CONFIG.embed.enabled,enabled);assert.equal(m.CONFIG.debug,true);largePublished(f);retained(x);
  }
  assert.equal(m.CONFIG,x.identity);assert.equal(f.api.MemoryState.metaCache,x.meta);assert.equal(m.CONFIG.debug,true);largePublished(f);retained(x,retainedLive,retainedStored);assert.equal(decodePhysical(f.store).injectionBudgetPreset,'large');assert.equal(x.calls(),1,'settings changes never start a second provider request');
  x.release();assert.equal(await bounded(x.old,'ABA old embedding settles'),null);assert.equal(m.getCacheStats().embedding.size,0);assert.equal(x.calls(),1);
 }finally{x.release();await closeFixture(f,x.old);}
});
test('combined unrelated preset and debug publication keeps a compatible completed hit across cold settings restore',async()=>{
 const x=await pendingFixture('unrelated'),{f,m}=x;let fresh;
 try{
  x.release();assert.deepEqual(copy(await bounded(x.old,'initial embedding settles')),[1,.25,-.5]);
  form(f,true,true,'large');await manual(f);assert.equal(m.CONFIG.debug,true);largePublished(f);retained(x);assert.deepEqual(copy(await bounded(m.EmbeddingEngine.getEmbedding(x.text),'compatible cache hit settles')),[1,.25,-.5]);assert.equal(x.calls(),1);
  fresh=await loadGui({store:f.store,args:{embedding_enabled:''},nativeInitialization:true});assert.equal(fresh.preGuiConfig.debug,true);assert.deepEqual(budget(fresh.preGuiConfig),large);assert.deepEqual(tuple(fresh.preGuiConfig),x.retention);assert.equal(fresh.preGuiConfig.embed.enabled,true);assert.equal(m.CONFIG,x.identity);assert.equal(f.api.MemoryState.metaCache,x.meta);
 }finally{x.release();try{if(fresh)await closeFixture(fresh);}finally{await closeFixture(f,x.old);}}
});
