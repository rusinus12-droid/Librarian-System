'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadGui}=require('./libra_management_gui_integration_test.cjs'),{profile}=require('./wm-analysis-preset-test-support.cjs');
test('saving an already-opened draft cannot undo explicit activation through a hidden enabled flag',async()=>{
 const cfg={useLLM:true,llm:profile('legacy'),llmPresets:{a:profile('A'),b:profile('B',{enabled:false})},llmDefaultPreset:'a'},f=await loadGui({nativeInitialization:true,args:{use_llm:'true'},store:new Map([['LMAI_Config',JSON.stringify(cfg)]])});
 const q=s=>f.overlay.querySelector(s),change=(s,v)=>{q(s).value=v;q(s).dispatchEvent(new f.w.Event('change',{bubbles:true}));},wait=async fn=>{const end=Date.now()+2000;while(!fn()){assert(Date.now()<end,'actual queued save completed');await new Promise(r=>setTimeout(r,5));}};
 try{change('#sllmpresetselect','b');assert.equal(q('#sllmpenabled').checked,false);change('#sllmdefault','b');await wait(()=>f.api.MemoryEngine.CONFIG.llmDefaultPreset==='b');assert.equal(f.api.MemoryEngine.CONFIG.llmPresets.b.enabled,true);q('#btn-llmp-save').click();await wait(()=>q('#common-ai-save-status').dataset.state==='saved');assert.equal(f.api.MemoryEngine.CONFIG.llmPresets.b.enabled,true);assert.equal(JSON.parse(f.store.get('LMAI_Config')).llmPresets.b.enabled,true);}finally{f.close();}
});
