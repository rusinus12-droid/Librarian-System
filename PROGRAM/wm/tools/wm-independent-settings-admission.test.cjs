'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadGui}=require('./libra_management_gui_integration_test.cjs');
const {profile}=require('./wm-analysis-preset-test-support.cjs');
for(const fault of ['pending','rejected'])test('independent registered analysis uses verified A during '+fault+' native B save',async()=>{
 const a={useLLM:true,llm:profile('legacy'),llmPresets:{a:profile('A'),b:profile('B')},llmDefaultPreset:'a'},b={...a,llmDefaultPreset:'b'},store=new Map([['LMAI_Config',JSON.stringify(a)]]);
 const f=await loadGui({observeCommonAnalysis:true,nativeInitialization:true,args:{use_llm:'true'},store});let release;try{
  const calls=[],storage=f.w.risuai.pluginStorage,set=storage.setItem.bind(storage);let started;const entered=new Promise(q=>started=q),gate=new Promise(q=>release=q);
  storage.setItem=async(key,value)=>{if(key!=='LMAI_Config')return set(key,value);started();if(fault==='pending')await gate;return false;};
  const p=f.overlay.querySelector('#settings-file-input').onchange({target:{files:[{name:'synthetic-settings.json',text:async()=>JSON.stringify(b)}]}});
  await entered;if(fault==='rejected')await p;
  assert.equal(f.api.MemoryEngine.CONFIG.llmDefaultPreset,'a');
  f.common.LLMProvider.call=async cfg=>{calls.push(f.common.resolveCommonAnalysisPreset(cfg).profile?.model);return {content:'{"worldItems":[{"kind":"material","title":"Synthetic crystal"}]}'};};
  f.overlay.querySelector('#udlc-world-request').value='Add one synthetic material.';f.overlay.querySelector('#btn-analyze-user-dlc-world').click();
  const deadline=Date.now()+5000;while(!calls.length){assert(Date.now()<deadline,'registered gateway reached');await new Promise(q=>setTimeout(q,5));}
  assert.deepEqual(calls,['A']);assert.equal(f.api.MemoryEngine.CONFIG.llmDefaultPreset,'a');assert.equal(JSON.parse(store.get('LMAI_Config')).llmDefaultPreset,'a');release();await p;
 }finally{release?.();f.close();}
});
