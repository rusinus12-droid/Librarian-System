'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadGui:loadGuiBase,cfg,plain}=require('./wm-similarity-cache-support.cjs');
// Portable imports preserve local connection admission; seed an already configured synthetic fixture.
const loadGui=options=>loadGuiBase({store:new Map([['LMAI_Config',JSON.stringify({embed:cfg()})]]),...options});
const pair=['Alice remembers the silver pendant promise at the market','Alice remembers the silver pendant promise after meeting Bob at the tower'];
const {importSettings:imported,decodePhysical}=require('./libra_portable_settings_fixture.cjs');
async function waitFor(fn){const end=Date.now()+5000;while(!fn()){assert(Date.now()<end,'registered GUI publication settled');await new Promise(r=>setTimeout(r,10));}}
async function reset(f){const p=f.overlay.querySelector('#btn-reset-settings').onclick();const modal=f.w.document.querySelector('[data-libra-dialog="true"]');assert(modal);[...modal.querySelectorAll('button')].find(n=>n.textContent==='확인').click();await p;}
for(const kind of ['manual save','autosave','import','reset'])test('registered '+kind+' config ABA retires pending actual similarity score',async()=>{
 let started,finish;const ready=new Promise(r=>started=r),gate=new Promise(r=>finish=r);let calls=0;
 const f=await loadGui({args:{embedding_enabled:''},nativeFetch:async()=>{calls++;started();await gate;return {ok:true,status:200,text:async()=>JSON.stringify({embeddings:[[1,.25,-.5]]})};}});
 try{
  await imported(f,{embed:cfg()});const identity=f.m.CONFIG,descriptor=Object.getOwnPropertyDescriptor(identity,'embed');const pending=f.a.calcSimilarity(...pair),cache=f.a.getSimCache();await ready;
  if(kind==='reset'){
   await reset(f);
   // Reset selects the current provider defaults. Restore the synthetic connection through
   // the registered Save path; portable import correctly refuses a provider collision.
   const expected=cfg();for(const [id,value] of [['#sep',expected.provider],['#seu',expected.url],['#sem',expected.model],['#sek',expected.key||'']])f.overlay.querySelector(id).value=value;
   f.overlay.querySelector('#seenabled').checked=true;f.overlay.querySelector('#btn-save-settings').onclick();
   await waitFor(()=>f.overlay.querySelector('#settings-auto-save-status').dataset.state==='saved'&&Object.entries(expected).every(([key,value])=>f.m.CONFIG.embed[key]===value));
  }
  else if(kind==='import'){await imported(f,{embed:cfg({model:'temporary-synthetic-model'})});await imported(f,{embed:cfg()});}
  else for(const value of [false,true]){
   const input=f.overlay.querySelector('#seenabled');input.checked=value;
   if(kind==='manual save')f.overlay.querySelector('#btn-save-settings').onclick();else input.dispatchEvent(new f.w.Event('change',{bubbles:true}));
   await waitFor(()=>f.m.CONFIG.embed.enabled===value&&f.overlay.querySelector('#settings-auto-save-status').dataset.state==='saved');
  }
  finish();assert.equal(typeof await pending,'number');assert.equal(cache.stats.size,0);assert.equal(f.m.CONFIG,identity);
  const after=Object.getOwnPropertyDescriptor(identity,'embed');assert.equal(after.get,descriptor.get);assert.equal(after.set,descriptor.set);assert.equal(calls,1,'existing stale embedding behavior unchanged');
 }finally{finish();f.close();}
});
test('closed portable settings exclude scoring weights and reject injected weight fields without publication',async()=>{
 const f=await loadGui();
 try{
  const initial=plain(f.m.CONFIG.scoringWeights),envelope=f.w.LibraSettingsSchema.buildPublicExport({...decodePhysical(f.store),scoringWeights:{...initial,word:initial.word+.05}});
  assert.equal(Object.hasOwn(envelope,'scoringWeights'),false);assert.equal(Object.hasOwn(envelope.settings,'scoringWeights'),false);
  const before=JSON.stringify([...f.store]),writes=f.calls.writes.length,config=plain(f.m.CONFIG),publications=f.obs.publications.length,cache=f.a.getSimCache(),stats=plain(cache.stats);
  envelope.settings.scoringWeights={...initial,word:initial.word+.05};const raw=JSON.stringify(envelope);
  await f.overlay.querySelector('#settings-file-input').onchange({target:{files:[{name:'forbidden-scoring-field.json',size:Buffer.byteLength(raw),text:async()=>raw}]}});
  assert.equal(f.overlay.querySelector('#settings-transfer-status').dataset.state,'rejected');assert.equal(f.overlay.querySelector('#btn-apply-settings-import').disabled,true);
  assert.equal(JSON.stringify([...f.store]),before);assert.equal(f.calls.writes.length,writes);assert.deepEqual(plain(f.m.CONFIG),config);assert.equal(f.obs.publications.length,publications);assert.equal(f.a.getSimCache(),cache);assert.deepEqual(plain(cache.stats),stats);
 }finally{f.close();}
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
