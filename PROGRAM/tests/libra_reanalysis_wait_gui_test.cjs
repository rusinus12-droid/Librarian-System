'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const {transformSource,select}=require('./fixtures/libra_reanalysis_kinds_fixture.cjs');

test('the production job dialog and minimized dock identify waiting, hide analysis progress, and allow cancellation',async()=>{
  const dom=new JSDOM('<main></main>',{pretendToBeVisual:true});
  const f=await fixture({
    transformSource:source=>transformSource(source).replace('  const publicApi = Object.freeze({',
      '  globalThis.__waitUI={Gui,renderCanonicalJobSurface,refreshCanonicalJobClock};\n  const publicApi = Object.freeze({'),
    contextGlobals:{document:dom.window.document,window:dom.window,MutationObserver:dom.window.MutationObserver,
      requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)}
  });
  let release;
  try{
    const core=f.r.context.__reanalysisKindsCore,ui=f.r.context.__waitUI;
    const inventory=await f.r.api.listReanalysisRanges({kind:'micro'});
    const pending=new Promise(resolve=>release=resolve);
    core.state.queues.set(inventory.scopeKey,pending);
    const execution=f.r.api.reanalyzeSelectedRanges(select(inventory,'1'));
    const job=await waitFor(()=>core.state.activeAuxiliaryJob?.phase==='waiting_for_memory'&&core.state.activeAuxiliaryJob);
    const root=dom.window.document.querySelector('main');
    ui.Gui.root=root;ui.Gui.app=root;
    ui.renderCanonicalJobSurface(job);
    const dialog=()=>root.querySelector('[data-canonical-job-portal]');
    assert.match(dialog().querySelector('[data-fill="kind"]').textContent,/다른 기억 작업 완료 대기/);
    const message=dialog().querySelector('[data-job-msg]');
    assert.match(message.textContent,/완료되면 재분석을 자동으로 시작/);
    assert.match(message.textContent,/아직 AI 분석은 시작하지 않았습니다/);
    assert.equal(message.getAttribute('role'),'status');
    assert.equal(message.getAttribute('aria-live'),'polite');
    assert.equal(dialog().querySelector('.progress').hidden,true);
    assert.equal(dialog().querySelectorAll('.step.is-active,.step.is-done').length,0);
    ui.Gui.visible=true;ui.refreshCanonicalJobClock(job);ui.Gui.visible=false;
    assert.match(dialog().querySelector('[data-canonical-job-clock]').textContent,/다른 기억 작업 완료 대기/);

    ui.Gui.canonicalJobMinimized=true;ui.renderCanonicalJobSurface(job);
    const chip=root.querySelector('[data-canonical-job-chip]');
    assert.match(chip.querySelector('.job-pill__meta').textContent,/다른 기억 작업 대기 · 분석 전/);
    assert.match(chip.getAttribute('aria-label'),/아직 AI 분석은 시작하지 않았습니다/);
    assert.equal(chip.querySelector('.job-pill__bar').hidden,true);
    chip.click();
    assert.equal(ui.Gui.canonicalJobMinimized,false);
    assert.match(dialog().querySelector('[data-job-msg]').textContent,/자동으로 시작/);
    const cancel=[...dialog().querySelectorAll('button')].find(node=>node.textContent==='작업 취소');
    assert.ok(cancel,'waiting retains the cancel action');
    cancel.click();
    const result=await execution;
    assert.equal(result.ok,false);
    assert.equal(f.control.calls.length,0);
    ui.renderCanonicalJobSurface(core.state.activeAuxiliaryJob);
    assert.equal(dialog().querySelector('[data-fill="kind"]').textContent,'취소됨');
    assert.doesNotMatch(dialog().querySelector('[data-canonical-job-clock]').textContent,/기억 작업 완료 대기/);
  }finally{release?.();await f.r.cleanup();dom.window.close();}
});
