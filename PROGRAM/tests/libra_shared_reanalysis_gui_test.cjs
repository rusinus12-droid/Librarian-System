'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture:runtimeFixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {fixture:guiFixture}=require('./fixtures/libra_reanalysis_gui_fixture.cjs');
const wait=async fn=>{for(let i=0;i<400;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('LIBRA review timed out');};
async function setup(){
  const f=await runtimeFixture({transformSource:source=>source.replace('const memoryStageEnabledForSettings =','globalThis.__reviewCore=LibraMemoryCore;\n  const memoryStageEnabledForSettings =')});
  assert.equal((await f.run()).completed,1);await f.r.api.retryPendingUnifiedVectors();const core=f.r.context.__reviewCore;await core.refreshSnapshot();
  const ui=guiFixture({core});await ui.show();return {f,core,...ui,dispose:async()=>{ui.close();await f.r.cleanup();}};
}
async function open(s){s.select(1);s.root.querySelector('[data-reanalysis-review]').click();await wait(()=>s.root.querySelector('[data-review-apply]')?.disabled===false);return s.root.querySelector('[data-source-reanalysis-review]');}
function extract(s,review){const area=review.querySelector('[data-review-source="assistant"]'),start=area.value.indexOf('Private');assert.ok(start>=0);area.setSelectionRange(start,start+7);area.onselect();review.querySelector('[data-review-extract]').click();}
test('LIBRA uses the shared extraction/editor with its real canonical replacement engine',async()=>{
  const s=await setup();try{
    s.f.chat.message[1].data+='<drop>Private module output.</drop>';const old={...s.f.getManifest().memories['1']},bytes=s.f.r.values.get(old.key),calls=s.f.control.calls.length;
    const review=await open(s);extract(s,review);await review.querySelector('[data-review-apply]').onclick();
    assert.equal(review.querySelector('[data-review-output="assistant"]').textContent.includes('Private module output.'),false);assert.equal(s.f.control.calls.length,calls);assert.equal(s.f.r.api.getSourceEditRules().ignoredTags.includes('drop'),false);
    const run=review.querySelector('[data-review-run]'),first=run.onclick(),second=run.onclick();await Promise.all([first,second]);
    assert.equal(s.f.r.api.getSourceEditRules().ignoredTags.includes('drop'),true);assert.equal(s.f.control.calls.length,calls+1);assert.ok(s.f.getManifest().memories['1'].revision>old.revision);assert.equal(s.f.r.values.get(old.key),bytes);assert.equal(s.root.querySelector('[data-canonical-range-drawer]'),null);
  }finally{await s.dispose();}
});
test('LIBRA switching to multiple turns removes the optional review without saving tags',async()=>{
  const s=await setup();try{
    s.f.chat.message[1].data+='<drop>Private module output.</drop>';const review=await open(s);extract(s,review);s.select(2);
    assert.equal(s.root.querySelector('[data-source-reanalysis-review]'),null);assert.equal(s.root.querySelector('[data-reanalysis-review]').hidden,true);assert.equal(s.f.r.api.getSourceEditRules().ignoredTags.includes('drop'),false);
  }finally{await s.dispose();}
});
test('LIBRA rejects edits in another turn of the reviewed 5-turn memory before saving tags',async()=>{
  const s=await setup();try{
    s.f.chat.message[1].data+='<drop>Private module output.</drop>';const old={...s.f.getManifest().memories['1']},calls=s.f.control.calls.length,review=await open(s);extract(s,review);await review.querySelector('[data-review-apply]').onclick();
    s.f.chat.message[5].data+=' Changed while reviewing.';await review.querySelector('[data-review-run]').onclick();
    assert.match(review.querySelector('[data-review-status]').textContent,/재분석 중단/);assert.equal(s.f.r.api.getSourceEditRules().ignoredTags.includes('drop'),false);assert.equal(s.f.control.calls.length,calls);assert.equal(s.f.getManifest().memories['1'].key,old.key);
  }finally{await s.dispose();}
});
test('LIBRA failed tag persistence never dispatches a canonical replacement',async()=>{
  const s=await setup();try{
    s.f.chat.message[1].data+='<drop>Private module output.</drop>';const calls=s.f.control.calls.length,review=await open(s);extract(s,review);await review.querySelector('[data-review-apply]').onclick();
    const storage=s.f.r.context.risuai.pluginStorage,set=storage.setItem.bind(storage);storage.setItem=async(k,v)=>String(k).endsWith(':settings:source-tracking:v1')?false:set(k,v);
    await review.querySelector('[data-review-run]').onclick();assert.match(review.querySelector('[data-review-status]').textContent,/재분석 중단/);assert.equal(s.f.control.calls.length,calls);
  }finally{await s.dispose();}
});
