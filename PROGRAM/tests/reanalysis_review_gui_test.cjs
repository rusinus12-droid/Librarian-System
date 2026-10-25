'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {setup,waitFor}=require('./fixtures/reanalysis_review_ui_fixture.cjs');
const {envelope,OLD,NEW}=require('./fixtures/shared_reanalysis_owner_fixture.cjs');
const text=NEW+' <drop>Do not remember this.</drop>';
const ruleRow=(review,tag)=>[...review.querySelectorAll('[data-review-rule]')].find(row=>row.querySelector('input').value===tag);
for(const owner of ['flashback','hayaku']){
  test(owner+' folds by default, shows stored contents, and offers review only for one selected turn',{timeout:15000},async()=>{
    const s=await setup(owner,{turns:2});try{
      assert.equal(s.root.querySelector('[data-reanalysis-fold]').open,false);
      assert.equal(s.find('run').disabled,true);assert.equal(s.find('review').hidden,true);
      assert.match(s.find('ranges').textContent,/저장된 내용/);assert.match(s.find('ranges').textContent,/Alice signed/);
      s.select(0);assert.equal(s.find('review').hidden,false);assert.equal(s.find('run').disabled,false);
      s.select(1);assert.equal(s.find('review').hidden,true);assert.equal(s.find('run').disabled,false);
      s.select(1,false);assert.equal(s.find('review').hidden,false);
      const records=JSON.stringify(await s.f.records()),calls=s.f.calls();
      s.f.edit(text);const details=s.find('ranges').querySelector('details');details.open=true;await details.ontoggle();
      await waitFor(()=>details.querySelector('pre').textContent.includes(NEW));
      assert.equal(s.f.calls(),calls);assert.equal(JSON.stringify(await s.f.records()),records);
      assert.match(s.find('ranges').querySelector('p').textContent,/Alice signed/,'stored summary stays distinct from the current source');
    }finally{await s.close();}
  });
  test(owner+' extracts, edits and previews tags locally, then verifies saved rules before reanalysis',{timeout:15000},async()=>{
    const s=await setup(owner);try{
      s.f.edit(text);const before=JSON.stringify(await s.f.records()),chat=s.f.chat.message[1].data;
      const review=await s.open(),run=review.querySelector('[data-review-run]');assert.equal(run.disabled,true);
      s.extract(review,'assistant','Do not remember this.');const row=ruleRow(review,'<drop>');assert.ok(row);
      // Editing an extracted candidate changes only the draft, and requires Apply again.
      row.querySelector('input').value='<drop>';row.querySelector('input').dispatchEvent(new s.dom.window.Event('input'));
      await review.querySelector('[data-review-apply]').onclick();
      assert.equal(review.querySelector('[data-review-output="assistant"]').textContent.trim(),NEW);
      assert.equal(s.f.api.getSourceEditRules().ignoredTags.includes('drop'),false);
      assert.equal(JSON.stringify(await s.f.records()),before);assert.equal(s.f.calls(),0);
      s.f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
      const first=run.onclick(),second=run.onclick();
      await waitFor(()=>s.find('confirm'));
      assert.ok(s.f.api.getSourceEditRules().ignoredTags.includes('drop'));
      assert.equal(s.find('run').disabled,true);assert.equal(s.find('review').disabled,true);assert.equal(s.f.calls(),0);
      s.find('confirm').click();await Promise.all([first,second]);
      assert.match(s.find('status').textContent,owner==='hayaku'?/기억을 갱신했습니다/:/원문을 저장했습니다/);
      assert.equal(s.f.calls(),owner==='hayaku'?1:0);assert.equal(s.f.chat.message[1].data,chat);
      const stored=[...s.f.store.values.entries()].find(([key])=>owner==='hayaku'?key==='hayaku.v2.settings.source-tracking.v1':key==='flashback.settings.source-tracking.v1');
      assert.ok(JSON.parse(stored[1]).sourceRules.ignoredTags.includes('drop'));
      assert.ok(JSON.stringify(await s.f.records()).includes(NEW));
    }finally{await s.close();}
  });
  test(owner+' rejects reviewed text changed after the final confirmation opens',{timeout:15000},async()=>{
    const s=await setup(owner);try{
      const before=JSON.stringify(await s.f.records()),review=await s.open();await review.querySelector('[data-review-apply]').onclick();
      const running=review.querySelector('[data-review-run]').onclick();await waitFor(()=>s.find('confirm'));
      s.f.edit(NEW);s.find('confirm').click();await running;
      assert.match(s.find('status').textContent,/재분석 중단/);assert.equal(s.f.calls(),0);assert.equal(JSON.stringify(await s.f.records()),before);
    }finally{await s.close();}
  });
  test(owner+' selection changes dismiss the single-turn draft without writing rules',{timeout:15000},async()=>{
    const s=await setup(owner,{turns:2});try{
      s.f.edit(text);const review=await s.open();s.extract(review,'assistant','Do not remember this.');
      s.select(1);assert.equal(s.root.querySelector('[data-source-reanalysis-review]'),null);assert.equal(s.find('review').hidden,true);
      assert.equal(s.f.api.getSourceEditRules().ignoredTags.includes('drop'),false);assert.equal(s.f.calls(),0);
    }finally{await s.close();}
  });
  test(owner+' failed rule readback prevents model dispatch and preserves prior memory',{timeout:15000},async()=>{
    const s=await setup(owner);try{
      s.f.edit(text);const before=JSON.stringify(await s.f.records()),review=await s.open();s.extract(review,'assistant','Do not remember this.');await review.querySelector('[data-review-apply]').onclick();
      const set=s.f.store.setItem.bind(s.f.store);s.f.store.setItem=async(key,value)=>String(key).includes('source-tracking.v1')?false:set(key,value);
      await review.querySelector('[data-review-run]').onclick();
      assert.match(review.querySelector('[data-review-status]').textContent,/재분석 중단/);assert.equal(s.find('confirm'),null);assert.equal(s.f.calls(),0);assert.equal(JSON.stringify(await s.f.records()),before);
    }finally{await s.close();}
  });
}
for(const owner of ['flashback','hayaku'])test(owner+' blocks raw-text edits after review when excluded content has the same projection',{timeout:15000},async()=>{
  const s=await setup(owner);let release;try{
    s.f.edit(text);const before=JSON.stringify(await s.f.records()),review=await s.open();s.extract(review,'assistant','Do not remember this.');await review.querySelector('[data-review-apply]').onclick();
    const running=review.querySelector('[data-review-run]').onclick();await waitFor(()=>s.find('confirm'));
    const get=s.f.store.getItem.bind(s.f.store);let entered,held=false;const gate=new Promise(r=>entered=r),pause=new Promise(r=>release=r);
    s.f.store.getItem=async key=>{if(!held&&(owner==='hayaku'?String(key).startsWith('hayaku.v2.ledger.'):String(key).endsWith(':manifest:v2'))){held=true;entered();await pause;}return get(key);};
    s.find('confirm').click();await gate;s.f.edit(NEW+' <drop>Changed after review.</drop>');release();await running;
    assert.match(s.find('status').textContent,/재분석 중단/);assert.equal(s.f.calls(),0);assert.equal(JSON.stringify(await s.f.records()),before);
  }finally{release?.();await s.close();}
});
test('HAYAKU positional legacy sources can save extracted tags and run their reviewed source',{timeout:15000},async()=>{
  const s=await setup('hayaku',{legacy:true});try{
    s.f.edit(text);const review=await s.open();s.extract(review,'assistant','Do not remember this.');await review.querySelector('[data-review-apply]').onclick();
    s.f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
    const running=review.querySelector('[data-review-run]').onclick();await waitFor(()=>s.find('confirm'));s.find('confirm').click();await running;
    assert.match(s.find('status').textContent,/기억을 갱신했습니다/);assert.equal(s.f.calls(),1);
  }finally{await s.close();}
});
