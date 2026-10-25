'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,source}=require('./fixtures/libra_reanalysis_gui_fixture.cjs');
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
test('reading desk exposes the common reanalysis drawer',()=>{
  const panel=source.slice(source.indexOf('  const buildBookMemoryProgressPanel ='),source.indexOf('  const buildCanonicalActionPanel ='));
  assert.match(panel,/bookMemoryReanalyze/);assert.match(panel,/showCanonicalRangeDrawer\('source_edit'\)/);
});
test('turn selection folds initially and offers review for a single turn',async()=>{
  const f=fixture();try{
    await f.show();assert.equal(f.root.querySelector('[data-reanalysis-fold]').open,false);assert.equal(f.root.querySelector('[data-reanalysis-review]').hidden,true);
    f.select(1);assert.equal(f.root.querySelector('[data-reanalysis-review]').hidden,false);assert.equal(f.root.querySelector('#range-go').textContent,'바로 재분석');
    f.select(2);assert.equal(f.root.querySelector('[data-reanalysis-review]').hidden,true);assert.match(f.root.querySelector('#range-calls').textContent,/^1회/);
    f.select(6);assert.match(f.root.querySelector('#range-calls').textContent,/^2회/);assert.match(f.root.textContent,/T1–T5, T6–T10/);
  }finally{f.close();}
});
test('one direct submit sends the selected turns without opening the review flow',async()=>{
  const f=fixture();try{
    await f.show();f.select(1);f.root.querySelector('#range-go').click();await flush();
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].ranges.length,1);assert.equal(f.calls[0].ranges[0].key,'1');assert.equal(f.root.querySelector('[data-canonical-range-drawer]'),null);
  }finally{f.close();}
});
test('repeated submit while the first operation is pending dispatches once',async()=>{
  let release;const f=fixture({run:()=>new Promise(resolve=>release=resolve)});try{
    await f.show();f.select(1);const button=f.root.querySelector('#range-go');button.click();button.click();await flush();assert.equal(f.calls.length,1);assert.equal(button.disabled,true);release({ok:true});await flush();
  }finally{release?.({ok:true});f.close();}
});
test('a failed operation preserves the selection and leaves the drawer usable',async()=>{
  const f=fixture({run:()=>({ok:false,reason:'replacement_failed'})});try{
    await f.show();f.select(1);f.root.querySelector('#range-go').click();await flush();assert.equal(f.calls.length,1);assert.equal(f.root.querySelector('#range-go').disabled,false);assert.match(f.root.querySelector('[data-reanalysis-status]').textContent,/replacement_failed/);
  }finally{f.close();}
});
test('closing before inventory resolves cannot create work or reopen the drawer',async()=>{
  let release;const f=fixture({inventory:()=>new Promise(resolve=>release=resolve)});try{
    const showing=f.show();f.Gui.canonicalRangeDrawerClose();release({scopeKey:'scope-a',topology:'a',ranges:[]});await showing;assert.equal(f.calls.length,0);assert.equal(f.root.querySelector('[data-canonical-range-drawer]'),null);
  }finally{f.close();}
});
