 'use strict';
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
(async()=>{
 const f=await createLibraVmHarness({}, {}, {transformSource:source=>source.replace('try { globalThis.__LIBRA__ = publicApi; } catch (_) {}',
  'globalThis.__commonSave={Gui,ensureGuiState,saveGuiState,loadSettings};\ntry { globalThis.__LIBRA__ = publicApi; } catch (_) {}')});
 try{
  const t=f.context.__commonSave;await t.ensureGuiState();
  t.Gui.state.runtime.debugLog=true;
  assert.equal(await t.saveGuiState(),true);
  assert.equal((await t.loadSettings()).debugLog,true,'retained settings use the durable common save');
  console.log('libra_book_quick_save_runtime_test: PASS (retired drawer; common save persistence)');
 }finally{await f.cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
