'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadGui}=require('./libra_management_gui_integration_test.cjs');
const {profile}=require('./wm-analysis-preset-test-support.cjs');
test('saving an unselected preset reports storage confirmation without claiming analysis activation',async()=>{
 const config={useLLM:true,llm:profile('legacy'),llmPresets:{a:profile('A'),b:profile('B')},llmDefaultPreset:'a'};
 const f=await loadGui({nativeInitialization:true,args:{use_llm:'true'},store:new Map([['LMAI_Config',JSON.stringify(config)]])});
 try {const q=s=>f.overlay.querySelector(s);q('#sllmpresetselect').value='b';q('#sllmpresetselect').dispatchEvent(new f.w.Event('change',{bubbles:true}));q('#sllmpm').value='B-edited';q('#btn-llmp-save').click();const end=Date.now()+2000;while(q('#common-ai-save-status').dataset.state!=='saved'){assert(Date.now()<end,'verified save completed');await new Promise(r=>setTimeout(r,5));}assert.equal(f.api.MemoryEngine.CONFIG.llmDefaultPreset,'a');assert.equal(q('#common-ai-save-status').textContent,'저장 확인됨.');}finally{f.close();}
});
