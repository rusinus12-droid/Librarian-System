'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadGui}=require('./libra_management_gui_integration_test.cjs');
const {profile}=require('./wm-analysis-preset-test-support.cjs');
const {importSettings,decodePhysical}=require('./libra_portable_settings_fixture.cjs');
async function bounded(work,label){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),5000)})]);}finally{clearTimeout(timer);}}
for(const fault of ['pending','rejected'])test('independent registered analysis uses verified A during '+fault+' native B save',async()=>{
 const a={useLLM:true,llm:profile('legacy'),llmPresets:{a:profile('A'),b:profile('B')},llmDefaultPreset:'a'},store=new Map([['LMAI_Config',JSON.stringify(a)]]);
 const f=await loadGui({observeCommonAnalysis:true,nativeInitialization:true,args:{use_llm:'true'},store});let release,p,restoreWriter;
 try{
  const calls=[],storage=f.w.risuai.pluginStorage,set=storage.setItem.bind(storage);let started,writerAttempts=0;const entered=new Promise(q=>started=q),gate=new Promise(q=>release=q);
  restoreWriter=()=>{storage.setItem=set;};
  storage.setItem=async(key,value)=>{if(key!=='LMAI_Config')return set(key,value);writerAttempts++;started();if(fault==='pending')await gate;return false;};
  // Real portable preview + Apply; selected name is portable, credentials stay local.
  p=importSettings(f,{llmDefaultPreset:'b'});p.catch(()=>{});
  await bounded(entered,'real native B writer entered');assert.equal(writerAttempts,1);
  if(fault==='rejected')await bounded(p,'rejected B Apply settles');
  assert.equal(f.api.MemoryEngine.CONFIG.llmDefaultPreset,'a');
  f.common.LLMProvider.call=async cfg=>{calls.push(f.common.resolveCommonAnalysisPreset(cfg).profile?.model);return {content:'{"worldItems":[{"kind":"material","title":"Synthetic crystal"}]}'};};
  f.overlay.querySelector('#udlc-world-request').value='Add one synthetic material.';f.overlay.querySelector('#btn-analyze-user-dlc-world').click();
  const deadline=Date.now()+5000;while(!calls.length){assert(Date.now()<deadline,'registered gateway reached');await new Promise(q=>setTimeout(q,5));}
  assert.deepEqual(calls,['A']);assert.equal(f.api.MemoryEngine.CONFIG.llmDefaultPreset,'a');assert.equal(decodePhysical(store).llmDefaultPreset,'a');
  release();await bounded(p,'held B Apply settles');
  assert.equal(f.overlay.querySelector('#settings-transfer-status').dataset.state,'failed');
  assert.equal(f.api.MemoryEngine.CONFIG.llmDefaultPreset,'a');assert.equal(decodePhysical(store).llmDefaultPreset,'a');assert.equal(writerAttempts,1);
 }finally{
  release?.();
  try{if(p)await bounded(p,'import cleanup settles');await bounded(Promise.allSettled(f.pending.splice(0)),'registered analysis cleanup settles');restoreWriter?.();for(const callback of f.callbacks.unload||[])await bounded(Promise.resolve().then(()=>callback()),'runtime unload settles');}finally{f.close();}
 }
});
