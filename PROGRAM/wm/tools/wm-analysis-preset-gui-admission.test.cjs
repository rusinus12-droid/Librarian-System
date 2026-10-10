'use strict';
// Registered analysis buttons must never admit the model currently drafted in settings.
const test=require('node:test'),assert=require('node:assert/strict');
const {loadGui}=require('./libra_management_gui_integration_test.cjs');
const {profile}=require('./wm-analysis-preset-test-support.cjs');
const config=()=>({useLLM:true,llm:profile('legacy'),llmPresets:{a:profile('A'),b:profile('B')},llmDefaultPreset:'a'});
test('registered_user_dlc_world_ignores_unsaved_model_selection',async()=>{
 const f=await loadGui({observeCommonAnalysis:true,nativeInitialization:true,args:{use_llm:'true'},store:new Map([['LMAI_Config',JSON.stringify(config())]])});const calls=[];const provider=f.common.LLMProvider.call;
 try{
  f.common.LLMProvider.call=async(cfg)=>{calls.push(f.common.resolveCommonAnalysisPreset(cfg).profile?.model);return {content:'{"worldItems":[{"kind":"material","title":"Synthetic crystal"}]}'};};
  f.overlay.querySelector('#sllmdefault').value='b';
  f.overlay.querySelector('#udlc-world-request').value='Add one synthetic crystal material.';
  f.overlay.querySelector('#btn-analyze-user-dlc-world').click();
  const end=Date.now()+5000;while(!calls.length){assert(Date.now()<end,'registered analysis reaches actual provider gateway');await new Promise(r=>setTimeout(r,5));}
  assert.deepEqual(calls,['A'],'verified active selection owns the new job');
  assert.equal(f.api.MemoryEngine.CONFIG.llmDefaultPreset,'a');assert.equal(JSON.parse(f.store.get('LMAI_Config')).llmDefaultPreset,'a');
 }finally{f.common.LLMProvider.call=provider;f.close();}
});
