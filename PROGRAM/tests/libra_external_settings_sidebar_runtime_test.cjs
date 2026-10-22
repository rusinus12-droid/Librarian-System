'use strict';
// Execute current navigation in the whole plugin. Legacy routes must reach a live
// settings section without saving drafts, calling a provider, or reviving retired UI.
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
(async()=>{
 const f=await createLibraVmHarness({}, {runLLMModel:async()=>{throw Error('navigation must not call a model');}}, {
  transformSource:source=>source.replace('try { globalThis.__LIBRA__ = publicApi; } catch (_) {}',
   'globalThis.__settingsNavigation={Gui,items:BOOK_EXTERNAL_SETTINGS_ITEMS,selectBookExternalSettings,bookExternalSettingsActive,bookSettingsRoomActiveSection};\ntry { globalThis.__LIBRA__ = publicApi; } catch (_) {}')
 });
 try{
  const n=f.context.__settingsNavigation;assert.ok(n,'observe actual navigation declarations');
  const draft={retainedDraft:'unsaved edits'};n.Gui.state=draft;n.Gui.dirty=true;
  assert.equal(n.items.length,15);assert.equal(new Set(n.items.map(item=>item.id)).size,15);
  for(const item of n.items){
   n.selectBookExternalSettings(item.id);
   assert.equal(n.Gui.bookPage,'settings',item.id);
   assert.equal(n.bookSettingsRoomActiveSection(),item.section,item.id);
   assert.equal(n.bookExternalSettingsActive(item),true,item.id);
   assert.equal(n.Gui.state,draft,'navigation retains draft identity');assert.equal(n.Gui.dirty,true);
  }
  for(const legacy of ['agents','pipeline']){
   n.selectBookExternalSettings('ai');n.selectBookExternalSettings(legacy);
   assert.equal(n.bookSettingsRoomActiveSection(),'pipeline',legacy+' resolves to memory analysis');
   assert.equal(n.Gui.pipelineHubSection,'memory_pipeline');
  }
  n.selectBookExternalSettings('ai');n.Gui.settingsRoomSaving=true;n.selectBookExternalSettings('modules');
  assert.equal(n.bookSettingsRoomActiveSection(),'ai','saving prevents navigation');
  n.Gui.settingsRoomSaving=false;n.selectBookExternalSettings('unknown-retired-section');
  assert.equal(n.bookSettingsRoomActiveSection(),'ai','unknown IDs leave the selected section alone');
  console.log('libra_external_settings_sidebar_runtime_test: PASS (15 live routes, 2 legacy aliases, draft preservation and save fence)');
 }finally{await f.cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
