'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadGui, plain } = require('./wm-similarity-cache-support.cjs');
const savedWeights = {word:0.4,char:0.2,concept:0.2,lexicalCoverage:0.1,focus:0.1,wordCoverageFactor:0.11,charCoverageFactor:0.22,conceptCoverageFactor:0.33,unknown:{keep:false,zero:0}};
const stored = f => JSON.parse(f.store.get('LMAI_Config'));
const edit = (f,id,value,event='change') => { const node=f.overlay.querySelector('#'+id); if(node.type==='checkbox')node.checked=value;else node.value=String(value);if(event)node.dispatchEvent(new f.w.Event(event,{bubbles:true})); };
const save = f => f.overlay.querySelector('#btn-save-settings').onclick();
const imported = (f,obj) => f.overlay.querySelector('#settings-file-input').onchange({target:{files:[{name:'reviewer-synthetic.json',text:async()=>JSON.stringify(obj)}]}});
async function state(f,wanted='saved'){ const end=Date.now()+6000;while(f.overlay.querySelector('#settings-auto-save-status').dataset.state!==wanted){assert(Date.now()<end,'expected '+wanted);await new Promise(r=>setTimeout(r,10));} }
async function open(flavor){process.env.LIBRA_GUI_TEST_DIST=path.resolve(__dirname,'../dist/'+(flavor==='Full'?'LIBRA World Manager Full.js':'LIBRA World Manager.js'));return loadGui({store:new Map([['LMAI_Config',JSON.stringify({scoringProfile:'balanced',scoringWeights:savedWeights})]]),nativeInitialization:true,args:{scoring_profile:'lexical'}});}
for(const flavor of ['Full','Min']){
 test(flavor+' successful edit relinquishes weight and profile ownership before later unrelated save',async()=>{const f=await open(flavor);try{
  edit(f,'sscword',0.57,'input');edit(f,'sscprof','semantic','input');save(f);await state(f);
  const s=stored(f);s.scoringWeights.word=0.91;s.scoringProfile='balanced';f.store.set('LMAI_Config',JSON.stringify(s));f.api.MemoryEngine.CONFIG.scoringWeights.word=0.81;f.api.MemoryEngine.CONFIG.scoringProfile='lexical';const live=plain(f.api.MemoryEngine.CONFIG.scoringWeights);
  edit(f,'sdebug',true);await state(f);assert.deepEqual(stored(f).scoringWeights,s.scoringWeights);assert.equal(stored(f).scoringProfile,'balanced');assert.deepEqual(plain(f.api.MemoryEngine.CONFIG.scoringWeights),live);assert.equal(f.api.MemoryEngine.CONFIG.scoringProfile,'lexical');
 }finally{f.close();}});
 test(flavor+' partial import merges into fresh stored and live layers after held read',async()=>{const f=await open(flavor);let release;try{
  const storage=f.w.risuai.pluginStorage,get=storage.getItem.bind(storage);let armed=true,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);storage.getItem=async key=>{if(key==='LMAI_Config'&&armed){armed=false;entered();await gate;}return get(key);};
  const pending=imported(f,{scoringWeights:{word:0.63}});await ready;const s=stored(f);s.scoringWeights.wordCoverageFactor=0.77;s.scoringWeights.freshSaved={x:1};f.store.set('LMAI_Config',JSON.stringify(s));f.api.MemoryEngine.CONFIG.scoringWeights.charCoverageFactor=0.88;const marker={x:2};f.api.MemoryEngine.CONFIG.scoringWeights.freshLive=marker;const live=plain(f.api.MemoryEngine.CONFIG.scoringWeights);release();await pending;
  assert.deepEqual(stored(f).scoringWeights,{...s.scoringWeights,word:0.63});assert.deepEqual(plain(f.api.MemoryEngine.CONFIG.scoringWeights),{...live,word:0.63});assert.equal(f.api.MemoryEngine.CONFIG.scoringWeights.freshLive,marker);
 }finally{release?.();f.close();}});
 test(flavor+' uncertain partial import does not publish and fences stale GUI edits',async()=>{const f=await open(flavor);try{
  const storage=f.w.risuai.pluginStorage,get=storage.getItem.bind(storage),set=storage.setItem.bind(storage);let written=false;const live=plain(f.api.MemoryEngine.CONFIG.scoringWeights),view=f.overlay.querySelector('#sscword').value;
  storage.setItem=async(k,v)=>{const out=await set(k,v);if(k==='LMAI_Config')written=true;return out;};storage.getItem=async k=>written&&k==='LMAI_Config'?'{}':get(k);
  await imported(f,{scoringWeights:{word:0.61}});assert.equal(stored(f).scoringWeights.word,0.61);assert.deepEqual(plain(f.api.MemoryEngine.CONFIG.scoringWeights),live);assert.equal(f.overlay.querySelector('#sscword').value,view);
  storage.setItem=set;storage.getItem=get;edit(f,'sscword',0.51,null);save(f);await state(f,'failed');assert.equal(stored(f).scoringWeights.word,0.61);assert.deepEqual(plain(f.api.MemoryEngine.CONFIG.scoringWeights),live);
 }finally{f.close();}});
 test(flavor+' false physical write acknowledgement is uncertain and fences stale replacement view',async()=>{const f=await open(flavor);try{
  const storage=f.w.risuai.pluginStorage,set=storage.setItem.bind(storage);edit(f,'sscword',0.53,'input');storage.setItem=async(k,v)=>k==='LMAI_Config'?false:set(k,v);const live=plain(f.api.MemoryEngine.CONFIG.scoringWeights);await imported(f,{scoringWeights:{char:0.63}});assert.deepEqual(plain(f.api.MemoryEngine.CONFIG.scoringWeights),live);assert.deepEqual(stored(f).scoringWeights,savedWeights);storage.setItem=set;save(f);await state(f,'failed');assert.match(f.overlay.querySelector('#settings-auto-save-status').textContent,/이전 화면/);assert.deepEqual(stored(f).scoringWeights,savedWeights);assert.deepEqual(plain(f.api.MemoryEngine.CONFIG.scoringWeights),live);
 }finally{f.close();}});
 test(flavor+' replacement read failure before write retains scoring edit ownership for retry',async()=>{const f=await open(flavor);try{
  const storage=f.w.risuai.pluginStorage,get=storage.getItem.bind(storage);edit(f,'sscword',0.53,'input');storage.getItem=async k=>{if(k==='LMAI_Config')throw Error('synthetic pre-write read rejection');return get(k);};const live=plain(f.api.MemoryEngine.CONFIG.scoringWeights);await imported(f,{scoringWeights:{char:0.63}});assert.deepEqual(plain(f.api.MemoryEngine.CONFIG.scoringWeights),live);assert.deepEqual(stored(f).scoringWeights,savedWeights);storage.getItem=get;save(f);await state(f);assert.equal(stored(f).scoringWeights.word,0.53);assert.equal(f.api.MemoryEngine.CONFIG.scoringWeights.word,0.53);assert.equal(stored(f).scoringWeights.char,0.2);
 }finally{f.close();}});
 test(flavor+' blank visible input preserves existing values and hidden absence per layer',async()=>{const f=await open(flavor);try{
  const s=stored(f);delete s.scoringWeights.wordCoverageFactor;f.store.set('LMAI_Config',JSON.stringify(s));delete f.api.MemoryEngine.CONFIG.scoringWeights.charCoverageFactor;const live=plain(f.api.MemoryEngine.CONFIG.scoringWeights);edit(f,'sscword','');await state(f);assert.deepEqual(stored(f).scoringWeights,s.scoringWeights);assert.deepEqual(plain(f.api.MemoryEngine.CONFIG.scoringWeights),live);
 }finally{f.close();}});
 test(flavor+' replacement clears earlier dirty fields so later unrelated save does not reuse them',async()=>{const f=await open(flavor);try{
  edit(f,'sscword',0.59,'input');await imported(f,{scoringWeights:{char:0.63}});assert.equal(stored(f).scoringWeights.word,0.4);const s=stored(f);s.scoringWeights.word=0.71;f.store.set('LMAI_Config',JSON.stringify(s));f.api.MemoryEngine.CONFIG.scoringWeights.word=0.81;const live=plain(f.api.MemoryEngine.CONFIG.scoringWeights);edit(f,'sdebug',true);await state(f);assert.deepEqual(stored(f).scoringWeights,s.scoringWeights);assert.deepEqual(plain(f.api.MemoryEngine.CONFIG.scoringWeights),live);
 }finally{f.close();}});
}
