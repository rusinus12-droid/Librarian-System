'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {gradia,wait}=require('./fixtures/companion_gui_fixture.cjs');
const KEY='serial_gradation_agents_for_rp:runtime_settings:v2';
test('visible NSFW selector saves, reopens, cancels and stays synchronized with existing response controls',async()=>{
 const f=await gradia();
 const select=()=>f.doc.querySelector('[data-detail="main"] select[data-existing-response-field="nsfwMode"]');
 const saved=()=>JSON.parse(f.store.get(KEY)).settings;
 const change=async mode=>{
  select().value=mode;select().dispatchEvent(new f.w.Event('change',{bubbles:true}));
  await wait(()=>[...f.doc.querySelectorAll('[data-existing-response-field="nsfwMode"]')].every(c=>c.value===mode)&&!f.doc.querySelector('#savebar [data-revert]').disabled,'NSFW controls synchronize');
 };
 const save=async()=>{f.doc.querySelector('#savebar [data-save]').click();await wait(()=>!f.plugin.debugGuiStateInfo().dirty,'NSFW save');};
 try{
  await f.plugin.openSettingsGui();assert.equal(select().value,'off');
  assert.match(select().closest('.setting').textContent,/입력 후보와 내부 초안/);
  for(const mode of ['soft','direct','explicit']){
   await change(mode);assert.equal(f.plugin.debugGuiStateInfo().dirty,true);
   for(const control of f.doc.querySelectorAll('[data-existing-response-field="nsfwMode"]'))assert.equal(control.value,mode);
   await save();assert.equal(saved().nsfw_mode,mode);assert.equal(saved().nsfw_guidance_enabled,'true');
   await f.plugin.closeSettingsGui();await f.plugin.openSettingsGui();assert.equal(select().value,mode);
  }
  await change('off');f.doc.querySelector('#savebar [data-revert]').click();await wait(()=>!f.plugin.debugGuiStateInfo().dirty&&select().value==='explicit','NSFW cancel');
  assert.equal(select().value,'explicit');assert.equal(saved().nsfw_mode,'explicit');
  const enabled=f.doc.querySelector('[data-existing-response-field="nsfwGuidanceEnabled"]');enabled.click();await wait(()=>!f.doc.querySelector('#savebar [data-revert]').disabled,'NSFW toggle dirty state');await save();
  assert.equal(saved().nsfw_guidance_enabled,'false');
  await change('soft');await save();assert.equal(saved().nsfw_mode,'soft');assert.equal(saved().nsfw_guidance_enabled,'true');
  const injectFinal=()=>f.doc.querySelector('[data-detail="main"] input[data-existing-response-field="nsfwInjectFinalRequest"]');
  assert.equal(injectFinal().checked,false);assert.equal(injectFinal().disabled,false);
  injectFinal().click();await wait(()=>[...f.doc.querySelectorAll('[data-existing-response-field="nsfwInjectFinalRequest"]')].every(c=>c.checked)&&!f.doc.querySelector('#savebar [data-revert]').disabled,'NSFW inject final synchronize');
  await save();assert.equal(saved().nsfw_inject_final_request,'true');assert.equal(injectFinal().checked,true);
  await f.plugin.closeSettingsGui();await f.plugin.openSettingsGui();assert.equal(injectFinal().checked,true);
  injectFinal().click();await wait(()=>[...f.doc.querySelectorAll('[data-existing-response-field="nsfwInjectFinalRequest"]')].every(c=>!c.checked)&&!f.doc.querySelector('#savebar [data-revert]').disabled,'NSFW final toggle is ready to cancel');
  f.doc.querySelector('#savebar [data-revert]').click();await wait(()=>!f.plugin.debugGuiStateInfo().dirty&&injectFinal().checked===true,'NSFW inject final cancel');
  assert.equal(saved().nsfw_inject_final_request,'true');
  assert.equal(f.getCalls(),0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
