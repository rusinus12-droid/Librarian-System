'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {loadGui,cfg,plain}=require('./wm-similarity-cache-support.cjs');
const root=process.env.WM_SCORING_SETTINGS_ROOT||path.resolve(__dirname,'..');
const pair=['Alice remembers the silver pendant promise at the market','Alice remembers the silver pendant promise after meeting Bob at the tower'];
const baseWeights={word:.4,char:.2,concept:.2,lexicalCoverage:.1,focus:.1,wordCoverageFactor:.11,charCoverageFactor:.22,conceptCoverageFactor:.33,savedOnly:{kept:['saved']}};
const keys=['wordCoverageFactor','charCoverageFactor','conceptCoverageFactor'];
const pick=o=>Object.fromEntries(keys.map(k=>[k,o[k]]));
async function settled(f,wanted='saved'){const end=Date.now()+6000;while(f.overlay.querySelector('#settings-auto-save-status').dataset.state!==wanted){assert(Date.now()<end,'save '+wanted);await new Promise(r=>setTimeout(r,10));}}
function edit(f,id,value,dispatch=true){const e=f.overlay.querySelector('#'+id);assert(e,id);if(e.type==='checkbox')e.checked=value;else e.value=String(value);if(dispatch)e.dispatchEvent(new f.w.Event('change',{bubbles:true}));}
async function imported(f,settings){await f.overlay.querySelector('#settings-file-input').onchange({target:{files:[{name:'synthetic.json',text:async()=>JSON.stringify(settings)}]}});}
const stored=f=>JSON.parse(f.store.get('LMAI_Config'));
async function open(flavor,overrides={}){
 process.env.LIBRA_GUI_TEST_DIST=process.env.WM_CHECKSUM_DIST||path.join(root,'dist',flavor==='Full'?'LIBRA World Manager Full.js':'LIBRA World Manager.js');
 const store=new Map([['LMAI_Config',JSON.stringify({scoringProfile:'balanced',scoringWeights:baseWeights})]]);
 return loadGui({store,nativeInitialization:true,args:{scoring_profile:'lexical',...overrides}});
}
for(const flavor of process.env.WM_CHECKSUM_DIST?[process.env.WM_TEST_PROFILE==='release'?'Min':'Full']:['Full','Min']){
 test(flavor+' actual cached/uncached ordered score unchanged after unrelated debug autosave',async()=>{
  process.env.LIBRA_GUI_TEST_DIST=process.env.WM_CHECKSUM_DIST||path.join(root,'dist',flavor==='Full'?'LIBRA World Manager Full.js':'LIBRA World Manager.js');let calls=0;
  const f=await loadGui({nativeInitialization:true,args:{embedding_enabled:''},nativeFetch:async()=>{calls++;return {ok:true,status:200,text:async()=>JSON.stringify({embeddings:[[1,.25,-.5]]})};}});
  try{await imported(f,{embed:cfg()});const weights=plain(f.m.CONFIG.scoringWeights),score=await f.a.calcSimilarity(...pair);edit(f,'sdebug',true);await settled(f);assert.deepEqual(plain(f.m.CONFIG.scoringWeights),weights);assert.equal(await f.a.calcSimilarity(...pair),score);assert.equal((await f.a.calcSimilarityDetailed(...pair,{})).similarity,score);assert.equal(calls,2);}finally{f.close();}
 });
 test(flavor+' unrelated save does not invent absent stored scoring fields from runtime defaults or arguments',async()=>{
  process.env.LIBRA_GUI_TEST_DIST=process.env.WM_CHECKSUM_DIST||path.join(root,'dist',flavor==='Full'?'LIBRA World Manager Full.js':'LIBRA World Manager.js');
  const f=await loadGui({store:new Map([['LMAI_Config',JSON.stringify({debug:false})]]),nativeInitialization:true,args:{scoring_profile:'lexical'}});
  try{const live=plain(f.m.CONFIG.scoringWeights),profile=f.m.CONFIG.scoringProfile;edit(f,'sdebug',true);await settled(f);assert.equal(Object.prototype.hasOwnProperty.call(stored(f),'scoringWeights'),false);assert.equal(Object.prototype.hasOwnProperty.call(stored(f),'scoringProfile'),false);assert.deepEqual(plain(f.m.CONFIG.scoringWeights),live);assert.equal(f.m.CONFIG.scoringProfile,profile);}finally{f.close();}
 });
 test(flavor+' debug and unchanged manual save preserve separate saved/live coefficients and unknown siblings',async()=>{
  const f=await open(flavor);try{const liveOnly={kept:['live']};f.m.CONFIG.scoringWeights.liveOnly=liveOnly;const saved=stored(f),live=plain(f.m.CONFIG.scoringWeights),identity=f.m.CONFIG.scoringWeights;assert.notDeepEqual(pick(saved.scoringWeights),pick(live),'explicit argument creates real layer difference');
   edit(f,'sdebug',true);await settled(f);assert.deepEqual(stored(f).scoringWeights,saved.scoringWeights);assert.equal(stored(f).scoringProfile,'balanced');assert.deepEqual(plain(f.m.CONFIG.scoringWeights),live);assert.equal(f.m.CONFIG.scoringProfile,'lexical');assert.equal(f.m.CONFIG.scoringWeights,identity);assert.equal(f.m.CONFIG.scoringWeights.liveOnly,liveOnly);
   f.overlay.querySelector('#btn-save-settings').onclick();await settled(f);assert.deepEqual(stored(f).scoringWeights,saved.scoringWeights);assert.deepEqual(plain(f.m.CONFIG.scoringWeights),live);
  }finally{f.close();}
 });
 test(flavor+' manual visible edit without events changes only that owned key on each fresh layer',async()=>{
  const f=await open(flavor);try{const marker={runtime:true};f.m.CONFIG.scoringWeights.liveOnly=marker;const saved=stored(f).scoringWeights,live=plain(f.m.CONFIG.scoringWeights);edit(f,'sscword',.57,false);f.overlay.querySelector('#btn-save-settings').onclick();await settled(f);assert.deepEqual(stored(f).scoringWeights,{...saved,word:.57});assert.deepEqual(plain(f.m.CONFIG.scoringWeights),{...live,word:.57});assert.equal(f.m.CONFIG.scoringWeights.liveOnly,marker);edit(f,'sdebug',true);await settled(f);assert.deepEqual(stored(f).scoringWeights,{...saved,word:.57});assert.deepEqual(plain(f.m.CONFIG.scoringWeights),{...live,word:.57});}finally{f.close();}
 });
 test(flavor+' explicit same-value scoring events own that field even when displayed saved value differs from live args',async()=>{
  const f=await open(flavor);try{const live=plain(f.m.CONFIG.scoringWeights);edit(f,'sscword',baseWeights.word);await settled(f);assert.deepEqual(plain(f.m.CONFIG.scoringWeights),{...live,word:baseWeights.word});edit(f,'sscprof','balanced');await settled(f);assert.equal(f.m.CONFIG.scoringProfile,'balanced');assert.deepEqual(pick(f.m.CONFIG.scoringWeights),pick(live));}finally{f.close();}
 });
 test(flavor+' explicit reset deliberately replaces the entire owned scoring defaults',async()=>{
  const f=await open(flavor);try{f.m.CONFIG.scoringWeights.liveOnly={keep:'until-reset'};const expected=plain(f.m.createDefaultSettingsConfig().scoringWeights);const done=f.overlay.querySelector('#btn-reset-settings').onclick();const modal=f.w.document.querySelector('[data-libra-dialog="true"]');assert(modal);[...modal.querySelectorAll('button')].find(b=>b.textContent==='확인').click();await done;assert.deepEqual(stored(f).scoringWeights,expected);assert.deepEqual(plain(f.m.CONFIG.scoringWeights),expected);assert.equal(f.m.CONFIG.scoringProfile,'balanced');assert.equal(stored(f).scoringProfile,'balanced');}finally{f.close();}
 });
 test(flavor+' profile-only GUI edit preserves all explicit coefficient and unknown fields',async()=>{
  const f=await open(flavor);try{const saved=stored(f).scoringWeights,live=plain(f.m.CONFIG.scoringWeights);edit(f,'sscprof','semantic');await settled(f);assert.equal(stored(f).scoringProfile,'semantic');assert.equal(f.m.CONFIG.scoringProfile,'semantic');assert.deepEqual(stored(f).scoringWeights,saved);assert.deepEqual(plain(f.m.CONFIG.scoringWeights),live);}finally{f.close();}
 });
 test(flavor+' imports patch only explicit mixed-known/unknown keys and preserve omitted scoring layers',async()=>{
  const f=await open(flavor);try{const marker={runtime:true};f.m.CONFIG.scoringWeights.liveOnly=marker;let saved=stored(f).scoringWeights,live=plain(f.m.CONFIG.scoringWeights);
   await imported(f,{activityDashboard:'full'});assert.deepEqual(stored(f).scoringWeights,saved);assert.deepEqual(plain(f.m.CONFIG.scoringWeights),live);assert.equal(stored(f).scoringProfile,'balanced');assert.equal(f.m.CONFIG.scoringProfile,'lexical');
   const patch={word:.57,wordCoverageFactor:0,importOnly:{kept:['import']},unknownFlag:false};await imported(f,{scoringWeights:patch});saved={...saved,...patch};live={...live,...patch};assert.deepEqual(stored(f).scoringWeights,saved);assert.deepEqual(plain(f.m.CONFIG.scoringWeights),live);assert.equal(f.m.CONFIG.scoringWeights.liveOnly,marker);
   await imported(f,{scoringProfile:'semantic'});assert.equal(stored(f).scoringProfile,'semantic');assert.equal(f.m.CONFIG.scoringProfile,'semantic');assert.deepEqual(stored(f).scoringWeights,saved);assert.deepEqual(plain(f.m.CONFIG.scoringWeights),live);
  }finally{f.close();}
 });
 test(flavor+' queued form edit uses fresh saved/live bases while unrelated save is held',async()=>{
  const f=await open(flavor);let release;try{const storage=f.w.risuai.pluginStorage,get=storage.getItem.bind(storage);let seen,armed=true;const entered=new Promise(r=>seen=r),gate=new Promise(r=>release=r);storage.getItem=async k=>{if(k==='LMAI_Config'&&armed){armed=false;seen();await gate;}return get(k);};
   edit(f,'sdebug',true);await entered;const s=stored(f);s.scoringWeights.charCoverageFactor=.77;s.scoringWeights.freshSaved={fresh:true};f.store.set('LMAI_Config',JSON.stringify(s));f.m.CONFIG.scoringWeights.conceptCoverageFactor=.88;const marker={fresh:true};f.m.CONFIG.scoringWeights.freshLive=marker;const live=plain(f.m.CONFIG.scoringWeights);
   edit(f,'sscword',.49);release();await settled(f);assert.deepEqual(stored(f).scoringWeights,{...s.scoringWeights,word:.49});assert.deepEqual(plain(f.m.CONFIG.scoringWeights),{...live,word:.49});assert.equal(f.m.CONFIG.scoringWeights.freshLive,marker);
  }finally{release?.();f.close();}
 });
 test(flavor+' queued edit returning to the initial displayed value overrides the earlier pending change',async()=>{
  const f=await open(flavor);let release;try{const storage=f.w.risuai.pluginStorage,set=storage.setItem.bind(storage);let seen,armed=true;const entered=new Promise(r=>seen=r),gate=new Promise(r=>release=r);storage.setItem=async(k,v)=>{if(k==='LMAI_Config'&&armed){armed=false;seen();await gate;}return set(k,v);};
   edit(f,'sscword',.57,false);edit(f,'sscprof','semantic',false);f.overlay.querySelector('#btn-save-settings').onclick();await entered;
   edit(f,'sscword',baseWeights.word,false);edit(f,'sscprof','balanced',false);f.overlay.querySelector('#btn-save-settings').onclick();release();await settled(f);
   assert.equal(stored(f).scoringWeights.word,baseWeights.word);assert.equal(f.m.CONFIG.scoringWeights.word,baseWeights.word);assert.equal(stored(f).scoringProfile,'balanced');assert.equal(f.m.CONFIG.scoringProfile,'balanced');
  }finally{release?.();f.close();}
 });
 test(flavor+' held physical write publishes selected key against latest live hidden values only after verification',async()=>{
  const f=await open(flavor);let release;try{const storage=f.w.risuai.pluginStorage,set=storage.setItem.bind(storage);let seen;const entered=new Promise(r=>seen=r),gate=new Promise(r=>release=r);storage.setItem=async(k,v)=>{if(k==='LMAI_Config'){seen();await gate;}return set(k,v);};const before=plain(f.m.CONFIG.scoringWeights);edit(f,'sscword',.51);await entered;assert.deepEqual(plain(f.m.CONFIG.scoringWeights),before);f.m.CONFIG.scoringWeights.wordCoverageFactor=.91;const expected={...before,word:.51,wordCoverageFactor:.91};release();await settled(f);assert.deepEqual(plain(f.m.CONFIG.scoringWeights),expected);assert.deepEqual(stored(f).scoringWeights,{...baseWeights,word:.51});}finally{release?.();f.close();}
 });
 for(const mode of ['false','throw','ack-without-write','readback-mismatch'])test(flavor+' scoring failure '+mode+' leaves live subtree unchanged and retry remains owned',async()=>{
  const f=await open(flavor);try{const storage=f.w.risuai.pluginStorage,set=storage.setItem.bind(storage),get=storage.getItem.bind(storage);let wrote=false;const before=plain(f.m.CONFIG.scoringWeights);
   storage.setItem=async(k,v)=>{if(k!=='LMAI_Config')return set(k,v);wrote=true;if(mode==='false')return false;if(mode==='throw')throw Error('synthetic rejected');if(mode==='ack-without-write')return true;return set(k,v);};storage.getItem=async k=>k==='LMAI_Config'&&wrote&&mode==='readback-mismatch'?'{}':get(k);
   edit(f,'sscword',.53);await settled(f,'failed');assert.deepEqual(plain(f.m.CONFIG.scoringWeights),before);storage.setItem=set;storage.getItem=get;f.overlay.querySelector('#btn-save-settings').onclick();await settled(f);assert.deepEqual(plain(f.m.CONFIG.scoringWeights),{...before,word:.53});assert.deepEqual(pick(stored(f).scoringWeights),pick(baseWeights));
  }finally{f.close();}
 });
}
test('all scoring fixtures attempted zero external transport',()=>assert.deepEqual(globalThis.__finalDeliveryTransportAttempts||[],[]));
