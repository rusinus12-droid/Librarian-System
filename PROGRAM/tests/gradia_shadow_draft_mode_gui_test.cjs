'use strict';
// 2026-10-31: the SHADOW ACT card's "첫 초안 방식 (소설)" was mockup markup that
// nothing read or saved, so it always showed Classic while the settings page
// (and the pipeline) used Input-inclusive. Both must be one setting.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {gradia,wait}=require('./fixtures/companion_gui_fixture.cjs');
const KEY='serial_gradation_agents_for_rp:runtime_settings:v2';
test('SHADOW card and settings page show and save the same novel first-draft mode',async()=>{
 const f=await gradia();
 const controls=()=>[...f.doc.querySelectorAll('select[data-existing-response-field="shadowDraftMode"]')];
 const card=()=>controls().find(control=>control.closest('.field.only-novel'));
 const settingsPage=()=>controls().find(control=>!control.closest('.field.only-novel'));
 const saved=()=>JSON.parse(f.store.get(KEY)).settings;
 const save=async()=>{f.doc.querySelector('#savebar [data-save]').click();await wait(()=>!f.plugin.debugGuiStateInfo().dirty,'draft mode save');};
 try{
  await f.plugin.openSettingsGui();
  assert.ok(card(),'the SHADOW card select is bound to the setting');assert.ok(settingsPage(),'the settings page select exists');
  assert.deepEqual([...card().options].map(option=>option.value),['classic','input_inclusive']);
  assert.ok(![...card().options].some(option=>/Input-inclusive|^Classic$/.test(option.textContent)),'mockup labels are replaced');
  assert.equal(card().value,settingsPage().value);
  // Change on the card: the settings page follows and the novel setting is saved.
  card().value='input_inclusive';card().dispatchEvent(new f.w.Event('change',{bubbles:true}));
  await wait(()=>controls().every(control=>control.value==='input_inclusive')&&!f.doc.querySelector('#savebar [data-revert]').disabled,'card change synchronizes');
  await save();assert.equal(saved().novel_shadow_draft_mode,'input_inclusive');assert.equal(saved().shadow_draft_mode,'input_inclusive');
  // Reopen: the card shows the saved value instead of the first mockup option.
  await f.plugin.closeSettingsGui();await f.plugin.openSettingsGui();
  assert.equal(card().value,'input_inclusive');assert.equal(settingsPage().value,'input_inclusive');
  // Change on the settings page: the card follows.
  settingsPage().value='classic';settingsPage().dispatchEvent(new f.w.Event('change',{bubbles:true}));
  await wait(()=>controls().every(control=>control.value==='classic'),'settings page change synchronizes');
  await save();assert.equal(saved().novel_shadow_draft_mode,'classic');
  assert.equal(f.getCalls(),0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
