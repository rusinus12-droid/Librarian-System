(async function(){
  var out={},ok={};
  function q(s,r){return (r||document).querySelector(s);} function qa(s,r){return [].slice.call((r||document).querySelectorAll(s));}
  function fire(el){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
  function wait(ms){return new Promise(function(r){setTimeout(r,ms||90)});}
  function toastT(){var t=qa('.toast');return t.length?t[t.length-1].textContent:'';}
  function openId(){var o=qa('.overlay.is-open');return o.length?o[o.length-1].id:'none';}
  function btn(root,txt){return qa('button',root).filter(function(b){return b.textContent.indexOf(txt)>-1})[0];}
  // counts
  out.counts=[q('#nav-mem-n').textContent,q('#link-people-n').textContent,q('#link-open-n').textContent,q('#story-open-n').textContent].join('/');
  ok.counts = out.counts==='25/3/2/2';
  // LIB-05 banner targets selected memory
  window.suiteGo('memory');await wait();
  q('#seg-mode button[data-val=manage]').click(); await wait();
  q('#memory-root .chapter[data-select-row=m23]').click(); await wait();
  q('#banner-versions').click(); await wait(150);
  out.banner = q('#dv-t').textContent + ' | rows=' + qa('#ver-rows .row').length;
  ok.bannerM23 = /M-23/.test(q('#dv-t').textContent);
  // LIB-06 promote shows M-23 canon text + LIB-07 list updates
  var pr = btn(q('#ver-rows'),'정본으로 올리기'); pr.click(); await wait(120);
  out.promote = q('#dpm-t').textContent + ' | cur=' + q('#dlg-promote [data-fill=cur]').textContent;
  ok.promoteCurIsM23 = /열쇠를 건네/.test(q('#dlg-promote [data-fill=cur]').textContent);
  btn(q('#dlg-promote .dialog__actions'),'정본으로 올리기').click(); await wait(150);
  out.afterPromote = qa('#ver-rows .row').map(function(r){return r.textContent.replace(/\s+/g,' ').slice(0,40)}).join(' || ') + ' | toast=' + toastT();
  ok.promoteApplied = /v1 · 현재 정본/.test(out.afterPromote);
  out.deck = q('#memory-root [data-detail=m23] .deck').textContent;
  // delete inactive
  var del = btn(q('#ver-rows'),'삭제'); del.click(); await wait(120);
  btn(q('#dlg-del-version .dialog__actions'),'삭제').click(); await wait(150);
  out.afterDel = qa('#ver-rows .row').length + ' | runs=' + qa('#run-rows .res-row').length;
  ok.deleteApplied = qa('#ver-rows .row').length===1;
  window.suiteClose('drawer-versions');
  // LIB-10 evidence for M-21
  q('#memory-root .chapter[data-select-row=m21]').click(); await wait();
  btn(q('#memory-root [data-detail=m21]'),'근거 5개').click(); await wait(150);
  out.ev21 = q('#de-t').textContent + ' | ' + qa('#ev-cites .anno__kicker').map(function(k){return k.textContent}).join(',') + ' | ' + q('#ev-receipt').textContent;
  ok.evidenceM21 = /T105/.test(out.ev21) && !/T125/.test(out.ev21) && qa('#ev-cites .anno').length===5;
  window.suiteClose('drawer-evidence');
  // world evidence count
  window.suiteGo('world'); await wait();
  var w1 = qa('[data-page=world] [data-open=drawer-evidence]').filter(function(b){return /근거 1개/.test(b.textContent)})[0]; w1.click(); await wait(150);
  out.evWorld = qa('#ev-cites .anno').length + ' | ' + q('.chain').textContent.replace(/\s+/g,' ').slice(0,120);
  ok.evWorldCount = qa('#ev-cites .anno').length===1 && !/M-25/.test(q('.chain').textContent);
  window.suiteClose('drawer-evidence');
  // LIB-08 regen single
  window.suiteGo('memory'); await wait();
  q('#memory-root .chapter[data-select-row=m23]').click(); await wait();
  btn(q('#memory-root [data-detail=m23]'),'재생성 후보').click(); await wait(120);
  var extra = qa('#seglist input').filter(function(i){return i.getAttribute('aria-label')==='T121–125 선택'})[0]; extra.checked=true; fire(extra); await wait();
  out.regenSel = qa('#seglist input:checked').map(function(i){return i.getAttribute('aria-label')}).join(',');
  ok.regenSingle = out.regenSel==='T121–125 선택';
  q('#range-go').click(); await wait(6300);
  var thenBtn = qa('#job-memory [data-then-open]').filter(function(b){return !b.hidden && !b.closest('[hidden]')})[0];
  thenBtn.click(); await wait(200);
  out.afterRegen = q('#dv-t').textContent + ' | ' + qa('#ver-rows .row__title').map(function(r){return r.textContent}).join(',');
  ok.regenCandidateListed = /M-25/.test(q('#dv-t').textContent) && /v4 · 재생성 후보/.test(out.afterRegen);
  window.suiteClose('drawer-versions');
  // LIB-09 miss
  q('#memory-root .chapter[data-select-row=m25]').click();
  window.suiteOpen('dlg-range'); await wait(100);
  var miss = qa('#seglist input').filter(function(i){return i.getAttribute('aria-label')==='T91–95 선택'})[0]; miss.checked=true; fire(miss); await wait();
  q('#range-go').click(); await wait(6300); window.suiteClose('job-memory');
  window.suiteOpen('dlg-range'); await wait(100); q('#kind-sel').value='miss'; fire(q('#kind-sel')); await wait();
  var rowMiss = qa('#seglist .segrow').filter(function(r){return r.textContent.indexOf('T91–95')>-1})[0];
  out.missAfter = rowMiss.textContent.replace(/\s+/g,' ') + ' | disabled=' + rowMiss.querySelector('input').disabled + ' | nav=' + q('#nav-mem-n').textContent;
  ok.missApplied = rowMiss.querySelector('input').disabled && q('#nav-mem-n').textContent==='26';
  window.suiteClose('dlg-range');
  // LIB-04 store dirty
  window.suiteGo('settings'); await wait(); q('[data-subtab=store]').click(); await wait();
  qa('#store-where .choice')[1].click(); await wait(100);
  out.store = q('#savebar-settings [data-save-title]').textContent + ' | badge=' + q('#store-badge').textContent + ' | hint=' + !q('#store-hint').hidden;
  ok.storeTracked = /1개 변경/.test(out.store) && /plugin_only/.test(q('#store-badge').textContent);
  q('#savebar-settings [data-save]').click(); await wait(100);
  out.storeSaved = q('#store-badge').textContent; ok.storeSavedBadge = /server_only/.test(out.storeSaved);
  // LIB-01/02 margin
  window.suiteGo('story'); await wait();
  out.savebarStory = q('#savebar-settings').hidden;
  var goal = q('#margin-form textarea'); goal.value='새 목표'; fire(goal); await wait(80);
  out.marginDirty = q('#margin-state').textContent + ' | save=' + !q('#margin-save').disabled;
  q('#margin-save').click(); await wait(80);
  out.marginSaved = q('#margin-state').textContent + ' | dirty=' + window.suiteDirty('story');
  ok.marginSave = window.suiteDirty('story')===0 && /기록된 내용과 같습니다/.test(q('#margin-state').textContent);
  q('#margin-reset').click(); await wait(100); btn(q('#dlg-margin-reset .dialog__actions'),'초기화').click(); await wait(120);
  out.marginReset = 'value=' + goal.value + ' | ' + q('#margin-state').textContent;
  ok.marginReset = goal.value==='' && window.suiteDirty('story')===1;
  q('#margin-revert').click(); await wait(100);
  ok.marginRevert = goal.value==='새 목표';
  // LIB-11 merge needs partner
  window.suiteGo('people'); await wait();
  btn(q('[data-page=people] [data-detail=p0]'),'병합').click(); await wait(120);
  out.merge0 = 'go disabled=' + q('#mg-go').disabled + ' opts=' + qa('#mg-partner option').map(function(o){return o.textContent}).join(',');
  ok.mergeNeedsPartner = q('#mg-go').disabled;
  q('#mg-partner').value='인물 · 정원사 로웬'; fire(q('#mg-partner')); await wait();
  ok.mergeEnabled = !q('#mg-go').disabled; q('#mg-go').click(); await wait(100); out.mergeToast = toastT();
  // LIB-12 pending per person
  btn(q('[data-page=people] [data-detail=p0]'),'보류 근거').click(); await wait(120);
  out.pend0 = q('#pend-list').textContent.replace(/\s+/g,' ').slice(0,60) + ' | go=' + q('#pend-go').disabled;
  ok.pendEmptyForAstel = /보류된 근거가 없습니다/.test(out.pend0) && q('#pend-go').disabled;
  window.suiteClose('dlg-pending');
  q('[data-page=people] .chapter[data-select-row=p2]').click(); await wait();
  btn(q('[data-page=people] [data-detail=p2]'),'보류 근거').click(); await wait(120);
  qa('#pend-list input[type=radio]')[1].click(); await wait();
  ok.pendEnabled = !q('#pend-go').disabled; q('#pend-go').click(); await wait(100); out.pendToast = toastT();
  btn(q('[data-page=people] [data-detail=p2]'),'보류 근거').click(); await wait(120);
  ok.pendResolvedGone = /보류된 근거가 없습니다/.test(q('#pend-list').textContent); window.suiteClose('dlg-pending');
  // LIB-14 prompt
  window.suiteOpen('dlg-prompt'); await wait(); q('#ps-in').value='바꾼 지침'; fire(q('#ps-in')); window.suiteClose('dlg-prompt'); window.suiteOpen('dlg-prompt'); await wait();
  ok.promptDiscarded = q('#ps-in').value!=='바꾼 지침';
  q('#ps-default').click(); ok.promptDefault = /기본 지침/.test(q('#ps-in').value); window.suiteClose('dlg-prompt');
  // LIB-15 rebuild boundary
  window.suiteGo('settings'); await wait(); q('[data-subtab=adv]').click(); await wait();
  var rb = qa('[data-open=dlg-recover]').filter(function(b){return /rebuild/.test(b.dataset.ctx)})[0]; rb.click(); await wait(120);
  q('#rb-bound').value='T110'; fire(q('#rb-bound')); await wait();
  q('#dlg-recover [data-run-job]').click(); await wait(4800);
  out.rebuild = q('#job-recover [data-fill=boundary]').textContent; ok.rebuildBoundary = out.rebuild==='T110'; window.suiteClose('job-recover');
  // guard: ?open-style no ctx
  window.suiteOpen('dlg-del-version'); await wait(80);
  out.guard = 'note=' + !q('#dlg-del-version .require-note').hidden + ' btnDisabled=' + q('#dlg-del-version .btn--danger-solid').disabled;
  ok.guardDelVersion = !q('#dlg-del-version .require-note').hidden && q('#dlg-del-version .btn--danger-solid').disabled;
  window.suiteClose('dlg-del-version');
  // pager
  window.suiteGo('memory'); await wait(); q('#memory-root .chapter[data-select-row=m25]').click(); await wait();
  q('[data-pager=m24]').click(); await wait();
  ok.pager = q('#memory-root .chapter.is-on').dataset.selectRow==='m24';
  // search
  var sr = q('[data-page=memory] .rail__search input'); sr.value='정원사'; fire(sr); await wait();
  out.search = qa('#memory-root .chapter').filter(function(c){return !c.hidden}).length; ok.search = out.search>=1 && out.search<5;
  sr.value=''; fire(sr);
  out.ok=ok; out.failed=Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
