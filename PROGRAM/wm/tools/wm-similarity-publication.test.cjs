'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadGui,cfg,plain}=require('./wm-similarity-cache-support.cjs');
const pair=['Alice remembers the silver pendant promise at the market','Alice remembers the silver pendant promise after meeting Bob at the tower'];
async function imported(f,settings){await f.overlay.querySelector('#settings-file-input').onchange({target:{files:[{name:'synthetic.json',text:async()=>JSON.stringify(settings)}]}});}
async function waitFor(fn){const end=Date.now()+5000;while(!fn()){assert(Date.now()<end,'registered GUI publication settled');await new Promise(r=>setTimeout(r,10));}}
async function reset(f){const p=f.overlay.querySelector('#btn-reset-settings').onclick();const modal=f.w.document.querySelector('[data-libra-dialog="true"]');assert(modal);[...modal.querySelectorAll('button')].find(n=>n.textContent==='확인').click();await p;}
for(const kind of ['manual save','autosave','import','reset'])test('registered '+kind+' config ABA retires pending actual similarity score',async()=>{
 let started,finish;const ready=new Promise(r=>started=r),gate=new Promise(r=>finish=r);let calls=0;
 const f=await loadGui({args:{embedding_enabled:''},nativeFetch:async()=>{calls++;started();await gate;return {ok:true,status:200,text:async()=>JSON.stringify({embeddings:[[1,.25,-.5]]})};}});
 try{
  await imported(f,{embed:cfg()});const identity=f.m.CONFIG,descriptor=Object.getOwnPropertyDescriptor(identity,'embed');const pending=f.a.calcSimilarity(...pair),cache=f.a.getSimCache();await ready;
  if(kind==='reset'){await reset(f);await imported(f,{embed:cfg()});}
  else if(kind==='import'){await imported(f,{embed:cfg({enabled:false})});await imported(f,{embed:cfg()});}
  else for(const value of [false,true]){
   const input=f.overlay.querySelector('#seenabled');input.checked=value;
   if(kind==='manual save')f.overlay.querySelector('#btn-save-settings').onclick();else input.dispatchEvent(new f.w.Event('change',{bubbles:true}));
   await waitFor(()=>f.m.CONFIG.embed.enabled===value&&f.overlay.querySelector('#settings-auto-save-status').dataset.state==='saved');
  }
  finish();assert.equal(typeof await pending,'number');assert.equal(cache.stats.size,0);assert.equal(f.m.CONFIG,identity);
  const after=Object.getOwnPropertyDescriptor(identity,'embed');assert.equal(after.get,descriptor.get);assert.equal(after.set,descriptor.set);assert.equal(calls,1,'existing stale embedding behavior unchanged');
 }finally{finish();f.close();}
});
test('registered weight-only import ABA is observed even while embedding identity is unchanged',async()=>{
 let started,finish;const ready=new Promise(r=>started=r),gate=new Promise(r=>finish=r);let calls=0;
 const f=await loadGui({args:{embedding_enabled:''},nativeFetch:async()=>{calls++;started();await gate;return {ok:true,status:200,text:async()=>JSON.stringify({embeddings:[[1,.25,-.5]]})};}});
 try{
  await imported(f,{embed:cfg()});const initial=plain(f.m.CONFIG.scoringWeights);const pending=f.a.calcSimilarity(...pair),cache=f.a.getSimCache();await ready;
  await imported(f,{embed:cfg(),scoringWeights:{...initial,word:initial.word+.05}});assert.notEqual(f.m.CONFIG.scoringWeights.word,initial.word);
  await imported(f,{embed:cfg(),scoringWeights:initial});assert.deepEqual(plain(f.m.CONFIG.scoringWeights),initial);
  finish();assert.equal(typeof await pending,'number');assert.equal(cache.stats.size,0);assert.equal(calls,2,'unchanged existing detailed scorer path, no retry');
 }finally{finish();f.close();}
});
test('unchanged publication and unrelated registered debug autosave preserve similarity hit',async()=>{
 let calls=0;const f=await loadGui({args:{embedding_enabled:''},nativeFetch:async()=>{calls++;return {ok:true,status:200,text:async()=>JSON.stringify({embeddings:[[1,.25,-.5]]})};}});
 try{
  await imported(f,{embed:cfg()});const value=await f.a.calcSimilarity(...pair),before=f.obs.details;
  f.m.EmbeddingEngine.noteConfigurationPublished();const debug=f.overlay.querySelector('#sdebug');debug.checked=true;debug.dispatchEvent(new f.w.Event('change',{bubbles:true}));
  await waitFor(()=>f.overlay.querySelector('#settings-auto-save-status').dataset.state==='saved');
  assert.equal(await f.a.calcSimilarity(...pair),value);assert.equal(f.obs.details,before);assert.equal(calls,2);
 }finally{f.close();}
});
test('offline GUI fixtures attempted zero external transports',()=>assert.deepEqual(globalThis.__finalDeliveryTransportAttempts||[],[]));

test('startup final publication observes scorer argument overrides after embedding assignment',async()=>{
 const f=await loadGui({args:{scoring_word_weight:'0.81',recall_anchor_bonus:'0.027'}});
 try{assert(f.obs.publications.length>=2,'early embedding notification retained and final scoring notification added');const final=f.obs.publications.at(-1);assert.equal(final.word,f.preGuiConfig.scoringWeights.word);assert.equal(final.anchor,.027);}finally{f.close();}
});
