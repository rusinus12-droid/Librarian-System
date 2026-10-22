'use strict';
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
(async()=>{
 const f=await createLibraVmHarness({}, {}, {transformSource:source=>source.replace('try { globalThis.__LIBRA__ = publicApi; } catch (_) {}',
 'globalThis.__analyzerDraft={Gui,ensureGuiState,selectBookExternalSettings,saveGuiState,loadSettings,markGuiDirty};\ntry { globalThis.__LIBRA__ = publicApi; } catch (_) {}')});
 try{
  const t=f.context.__analyzerDraft;await t.ensureGuiState();
  const draft=t.Gui.state;
  draft.agents.librarian.enabled=false;t.markGuiDirty();
  for(const route of ['memory_analysis','performance','ai','embedding','agents']){
   t.selectBookExternalSettings(route);assert.equal(t.Gui.state,draft);assert.equal(t.Gui.dirty,true);
   assert.equal(t.Gui.state.agents.librarian.enabled,false,'one analyzer draft across destinations');
  }
  assert.equal(await t.saveGuiState(),true);
  assert.equal((await t.loadSettings()).enableLibrarian,false);
  console.log('libra_agent_workbench_consolidation_runtime_test: PASS (single analyzer draft, navigation and common save)');
 }finally{await f.cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
