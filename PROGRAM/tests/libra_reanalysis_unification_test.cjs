'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {fixture:guiFixture}=require('./fixtures/libra_reanalysis_gui_fixture.cjs');
const {microReply,lensReply,createLens}=require('./fixtures/libra_reanalysis_kinds_fixture.cjs');
const wait=async fn=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Unified reanalysis timed out');};
async function setup(){const f=await fixture();await f.r.core.refreshSnapshot();const ui=guiFixture({core:f.r.core});return {...ui,f,scope:f.r.core.peekSnapshot().scope.scopeKey,dispose:async()=>{ui.close();await f.r.cleanup();}};}
test('retired public analysis APIs reject before any model call or owner write',async()=>{
  const f=await fixture();try{
    const calls=f.control.calls.length,writes=f.r.storageWrites.length;
    for(const name of ['regenerateCanonicalMemory','retryFailedMemoryAnalysis','scanMemoryNow','resumeNeverStartedMicro','retryMicroAnalysis','rebuildSelectedLegacyMemories','runLensForRange','runLensForTurnRange'])await assert.rejects(f.r.api[name]({}),error=>error.code==='LIBRA_REANALYSIS_ENTRY_RETIRED',name);
    for(const mode of ['failed','regenerate'])await assert.rejects(f.r.api.startSelectedCanonicalBatches({scopeKey:'old-scope',mode,ranges:[{startTurn:1}]}),error=>error.code==='LIBRA_REANALYSIS_ENTRY_RETIRED');
    for(const name of ['scanMemoryNow','runManualColdStart'])await assert.rejects(f.r.api[name]({forceRegenerate:true}),error=>error.code==='LIBRA_REANALYSIS_ENTRY_RETIRED');
    assert.equal(f.control.calls.length,calls);assert.equal(f.r.storageWrites.length,writes);
  }finally{await f.r.cleanup();}
});
test('canonical context opens one preselected five-turn group and runs only after explicit submission',async()=>{
  const s=await setup();try{
    await s.show({kind:'canonical',scopeKey:s.scope,startTurn:1,endTurn:5});
    assert.equal(s.root.querySelector('[data-reanalysis-page]').dataset.reanalysisPage,'canonical');assert.equal(s.root.querySelector('[data-reanalysis-fold]').open,true);assert.equal(s.root.querySelector('input:checked').value,'1-5');assert.equal(s.f.control.calls.length,0);
    s.root.querySelector('[data-reanalysis-run]').click();await wait(()=>!s.root.querySelector('[data-canonical-range-drawer]'));assert.equal(s.f.control.calls.length,1);assert.equal(s.f.getManifest().memories['1'].status,'committed');
  }finally{await s.dispose();}
});
test('Micro context opens the selected turn without a model call and uses the common dispatcher',async()=>{
  const s=await setup();try{
    s.f.control.onCall=args=>microReply(args);await s.show({kind:'micro',scopeKey:s.scope,startTurn:2,endTurn:2});assert.equal(s.root.querySelector('[data-reanalysis-page]').dataset.reanalysisPage,'micro');assert.equal(s.root.querySelector('input:checked').value,'2');assert.equal(s.f.control.calls.length,0);
    s.root.querySelector('[data-reanalysis-run]').click();await wait(()=>!s.root.querySelector('[data-canonical-range-drawer]'));assert.equal(s.f.control.calls.length,1);assert.equal((await s.f.r.api.debugReadActiveMicroMemory(2)).status,'verified');assert.equal(s.f.getRecords('libra.canonical_memory.v1').length,0);
  }finally{await s.dispose();}
});
test('lens context retains its lens and exact saved range without executing on navigation',async()=>{
  const s=await setup();try{
    const lens=await createLens(s.f);s.f.control.onCall=()=>lensReply(s.f);assert.equal((await s.f.r.core.runLensForRange({lensId:lens.lensId,startTurn:1,endTurn:2})).ok,true);const before=await s.f.r.api.inspectScopeLenses(),calls=s.f.control.calls.length;
    await s.show({kind:'lens',scopeKey:s.scope,lensId:lens.lensId,startTurn:1,endTurn:2});assert.equal(s.root.querySelector('[data-reanalysis-page]').dataset.reanalysisPage,'lens');assert.equal(s.root.querySelector('[data-reanalysis-lens]').value,lens.lensId);assert.equal(s.root.querySelector('input:checked').value,'1-2');assert.equal(s.f.control.calls.length,calls);
    s.root.querySelector('[data-reanalysis-run]').click();await wait(()=>!s.root.querySelector('[data-canonical-range-drawer]'));assert.equal(s.f.control.calls.length,calls+1);const after=await s.f.r.api.inspectScopeLenses();assert.equal(after.memories[0].recordKey,before.memories[0].recordKey);
  }finally{await s.dispose();}
});
test('missing contextual ranges are not silently substituted with other source ranges',async()=>{
  const s=await setup();try{
    await s.show({kind:'micro',scopeKey:s.scope,startTurn:20,endTurn:20});assert.equal(s.root.querySelectorAll('[data-reanalysis-ranges] input:checked').length,0);assert.equal(s.root.querySelector('[data-reanalysis-run]').disabled,true);assert.match(s.root.querySelector('[data-reanalysis-status]').textContent,/선택한 구간을 현재 채팅에서 찾지 못했습니다/);assert.equal(s.f.control.calls.length,0);
  }finally{await s.dispose();}
});
test('a deleted contextual lens cannot silently switch to another lens',async()=>{
  const s=await setup();try{
    await createLens(s.f);await s.show({kind:'lens',scopeKey:s.scope,lensId:'deleted-lens',startTurn:1,endTurn:5});assert.equal(s.root.querySelector('[data-reanalysis-run]').disabled,true);assert.equal(s.root.querySelectorAll('[data-reanalysis-ranges] input').length,0);assert.match(s.root.querySelector('[data-reanalysis-status]').textContent,/렌즈가 변경되거나 삭제/);assert.equal(s.f.control.calls.length,0);
  }finally{await s.dispose();}
});
test('a stale-scope shortcut cannot replace an already open current-scope popup',async()=>{
  const s=await setup();try{
    await s.show({kind:'canonical',scopeKey:s.scope});const popup=s.root.querySelector('[data-canonical-range-drawer]');await s.show({kind:'micro',scopeKey:'another-scope',startTurn:1,endTurn:1});assert.equal(s.root.querySelector('[data-canonical-range-drawer]'),popup);assert.equal(s.f.control.calls.length,0);
  }finally{await s.dispose();}
});
test('first-time memory generation retains only the missing-range workflow',async()=>{
  const s=await setup();try{
    await s.showGeneration();assert.equal(s.root.querySelector('#kind-sel'),null);assert.equal(s.root.querySelector('#regen-one'),null);assert.equal(s.root.querySelector('[data-reanalysis-pages]'),null);const input=s.root.querySelector('#seglist input:not(:disabled)');assert.ok(input);input.checked=true;input.dispatchEvent(new s.dom.window.Event('change',{bubbles:true}));assert.equal(s.f.control.calls.length,0);s.root.querySelector('#range-go').click();await wait(()=>s.f.getManifest()?.memories?.['1']?.status==='committed');assert.equal(s.f.control.calls.length,1);
  }finally{await s.dispose();}
});
