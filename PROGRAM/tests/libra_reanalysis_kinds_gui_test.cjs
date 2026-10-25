'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture:runtimeFixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {fixture:guiFixture}=require('./fixtures/libra_reanalysis_gui_fixture.cjs');
const {microReply,lensReply,transformSource,createLens}=require('./fixtures/libra_reanalysis_kinds_fixture.cjs');
const wait=async fn=>{for(let i=0;i<400;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Reanalysis page timed out');};
async function setup(turns=5){
  const f=await runtimeFixture({transformSource});f.chat.message.splice(turns*2);const core=f.r.context.__reanalysisKindsCore;await core.refreshSnapshot();
  const ui=guiFixture({core});await ui.show();return {f,core,...ui,dispose:async()=>{ui.close();await f.r.cleanup();}};
}
async function page(s,kind){
  s.root.querySelector('[data-reanalysis-kind="'+kind+'"]').click();
  await wait(()=>s.root.querySelector('[data-reanalysis-page]')?.dataset.reanalysisPage===kind&&!s.root.querySelector('[data-reanalysis-status]').textContent.includes('읽는 중'));
}
test('LIBRA provides canonical, Micro and lens internal pages, initially folded with keyboard navigation',async()=>{
  const s=await setup(3);try{
    assert.deepEqual([...s.root.querySelectorAll('[role=tab]')].map(tab=>tab.textContent),['정본','미크로','렌즈']);assert.equal(s.root.querySelector('[data-reanalysis-fold]').open,false);
    assert.equal(s.root.querySelectorAll('[data-reanalysis-ranges] input').length,0);
    const tab=s.root.querySelector('[data-reanalysis-kind=canonical]');tab.dispatchEvent(new s.dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    await wait(()=>s.root.querySelectorAll('[data-reanalysis-ranges] input').length===3);
    assert.equal(s.root.querySelector('[data-reanalysis-kind=micro]').getAttribute('aria-selected'),'true');assert.equal(s.document.activeElement,s.root.querySelector('[data-reanalysis-kind=micro]'));
    assert.match(s.root.querySelector('[data-reanalysis-introduction]').textContent,/1턴마다/);s.select(2);assert.match(s.root.querySelector('#range-calls').textContent,/1턴당 1회/);assert.equal(s.root.querySelector('[data-reanalysis-review]').hidden,false);
    await page(s,'lens');assert.match(s.root.querySelector('[data-reanalysis-status]').textContent,/저장된 렌즈가 없습니다/);assert.equal(s.root.querySelector('[data-reanalysis-run]').disabled,true);assert.equal(s.f.control.calls.length,0);
  }finally{await s.dispose();}
});
test('switching internal pages clears selected turns and an unsaved source review',async()=>{
  const s=await setup();try{
    s.f.chat.message[1].data+='<drop>Private</drop>';s.select(1);s.root.querySelector('[data-reanalysis-review]').click();await wait(()=>s.root.querySelector('[data-review-apply]')?.disabled===false);
    await page(s,'micro');assert.equal(s.root.querySelector('[data-source-reanalysis-review]'),null);assert.equal(s.root.querySelectorAll('[data-reanalysis-ranges] input:checked').length,0);
    s.select(2);await page(s,'canonical');assert.equal(s.root.querySelectorAll('[data-reanalysis-ranges] input:checked').length,0);assert.equal(s.root.querySelector('[data-reanalysis-run]').disabled,true);assert.equal(s.f.r.api.getSourceEditRules().ignoredTags.includes('drop'),false);
  }finally{await s.dispose();}
});
test('Micro multi-turn direct reanalysis invokes only Micro and disables navigation until completion',async()=>{
  const s=await setup(3);let release;try{
    await page(s,'micro');const gate=new Promise(resolve=>release=resolve);s.f.control.onCall=async args=>{await gate;return microReply(args);};s.select(1);s.select(3);
    assert.equal(s.root.querySelector('[data-reanalysis-review]').hidden,true);assert.match(s.root.querySelector('#range-calls').textContent,/^2회/);
    s.root.querySelector('[data-reanalysis-run]').click();await wait(()=>s.f.control.calls.length>0);
    assert.ok([...s.root.querySelectorAll('[data-reanalysis-kind]')].every(tab=>tab.disabled));release();await wait(()=>!s.root.querySelector('[data-canonical-range-drawer]'));
    assert.equal(s.f.control.calls.length,2);assert.equal((await s.f.r.api.debugReadActiveMicroMemory(1)).status,'verified');assert.equal((await s.f.r.api.debugReadActiveMicroMemory(3)).status,'verified');assert.equal(s.f.getRecords('libra.canonical_memory.v1').length,0);
  }finally{release?.();await s.dispose();}
});
test('a partial Micro failure removes completed turns from the remaining selection',async()=>{
  const s=await setup(3);try{
    await page(s,'micro');s.f.control.onCall=args=>JSON.parse(args[0].messages.find(row=>row.role==='user').content).binding.turn===2?{type:'error',result:'failed second turn'}:microReply(args);
    s.root.querySelector('[data-reanalysis-select-all]').click();s.root.querySelector('[data-reanalysis-run]').click();await wait(()=>s.root.querySelector('[data-reanalysis-status]').textContent.includes('완료 1개'));
    assert.deepEqual([...s.root.querySelectorAll('[data-reanalysis-ranges] input:checked')].map(input=>input.value),['2','3']);assert.equal(s.root.querySelector('[data-reanalysis-run]').disabled,false);
  }finally{await s.dispose();}
});
for(const kind of ['micro','lens'])test(kind+' single-turn review saves exclusions and dispatches its native engine',async()=>{
  const s=await setup(1);try{
    if(kind==='lens')await createLens(s.f);s.f.chat.message[1].data+='<drop>Private</drop>';
    s.f.control.onCall=args=>kind==='micro'?microReply(args):lensReply(s.f);
    await page(s,kind);s.select(kind==='micro'?'1':'1-1');s.root.querySelector('[data-reanalysis-review]').click();await wait(()=>s.root.querySelector('[data-review-apply]')?.disabled===false);
    const review=s.root.querySelector('[data-source-reanalysis-review]'),area=review.querySelector('[data-review-source=assistant]'),start=area.value.indexOf('Private');area.setSelectionRange(start,start+7);area.onselect();review.querySelector('[data-review-extract]').click();await review.querySelector('[data-review-apply]').onclick();await review.querySelector('[data-review-run]').onclick();
    assert.equal(s.root.querySelector('[data-canonical-range-drawer]'),null);assert.equal(s.f.r.api.getSourceEditRules().ignoredTags.includes('drop'),true);assert.equal(s.f.control.calls.length,1);assert.equal(JSON.stringify(s.f.control.calls[0]).includes('Private'),false);assert.equal(s.f.getRecords('libra.canonical_memory.v1').length,0);
    if(kind==='micro')assert.equal((await s.f.r.api.debugReadActiveMicroMemory(1)).status,'verified');else assert.equal((await s.f.r.api.inspectScopeLenses()).memories.length,1);
  }finally{await s.dispose();}
});
test('lens page displays the chosen lens and actual record ranges; multi-turn ranges offer direct reanalysis',async()=>{
  const s=await setup();try{
    const a=await createLens(s.f,'관점 A'),b=await createLens(s.f,'관점 B');s.f.control.onCall=()=>lensReply(s.f);
    assert.equal((await s.f.r.api.runLensForRange({lensId:a.lensId,startTurn:1,endTurn:2})).ok,true);
    await page(s,'lens');assert.match(s.root.textContent,/T1–T2/);s.select('1-2');assert.equal(s.root.querySelector('[data-reanalysis-review]').hidden,true);
    const choice=s.root.querySelector('[data-reanalysis-lens]');choice.value=b.lensId;choice.dispatchEvent(new s.dom.window.Event('change',{bubbles:true}));await wait(()=>s.root.querySelector('[data-reanalysis-ranges]').textContent.includes('관점 B'));
    assert.equal(s.root.querySelectorAll('[data-reanalysis-ranges] input:checked').length,0);s.select('1-5');s.root.querySelector('[data-reanalysis-run]').click();await wait(()=>!s.root.querySelector('[data-canonical-range-drawer]'));
    const data=await s.f.r.api.inspectScopeLenses();assert.equal(data.lenses[a.lensId].recordCount,1);assert.equal(data.lenses[b.lensId].recordCount,1);
  }finally{await s.dispose();}
});
test('refresh replaces a deleted lens choice and invalidates its unsaved review',async()=>{
  const s=await setup(1);try{
    const a=await createLens(s.f,'삭제할 렌즈'),b=await createLens(s.f,'남은 렌즈');await page(s,'lens');s.select('1-1');s.root.querySelector('[data-reanalysis-review]').click();await wait(()=>s.root.querySelector('[data-review-apply]')?.disabled===false);
    await s.f.r.api.trashLens(a.lensId);s.root.querySelectorAll('[data-reanalysis-fold] button')[0].click();await wait(()=>s.root.querySelector('[data-reanalysis-lens]').value===b.lensId);
    assert.equal(s.root.querySelector('[data-source-reanalysis-review]'),null);assert.equal(s.root.querySelectorAll('[data-reanalysis-ranges] input:checked').length,0);assert.match(s.root.querySelector('[data-reanalysis-ranges]').textContent,/남은 렌즈/);assert.equal(s.f.control.calls.length,0);
  }finally{await s.dispose();}
});
