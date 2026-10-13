(async function(){
  var out = {}, ok = {};
  function q(s,r){ return (r||document).querySelector(s); }
  function qa(s,r){ return [].slice.call((r||document).querySelectorAll(s)); }
  function fire(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  function wait(ms){ return new Promise(function(r){setTimeout(r,ms||80)}); }
  function setv(el,v){ el.value=v; fire(el); }
  function bar(){ return q('#savebar'); }
  function stitle(){ return q('#savebar [data-save-title]').textContent; }
  function nav(){ return qa('.nav-item[data-go]').filter(function(i){return i.classList.contains('is-unsaved')}).map(function(i){return i.dataset.go}); }
  function bindNames(){ return qa('#bind-list > *').map(function(r){ return r.textContent.replace(/\s+/g,' ').trim().slice(0,30); }); }
  function pg(){ return q('.page.is-active').dataset.page; }
  function shelfRow(name){ return qa('#shelf-list .row').filter(function(r){return r.textContent.indexOf(name)>-1})[0]; }

  /* === 이슈 4: 카엘 채택 -> 연결 목록에 카엘 === */
  window.suiteGo('shelf'); await wait();
  shelfRow('카엘 로웬').click(); await wait();
  out.i4_page = pg();
  out.i4_adoptBefore = q('#btn-adopt').textContent + '/disabled=' + q('#btn-adopt').disabled;
  q('#btn-adopt').click(); await wait();
  out.i4_adoptAfter = q('#btn-adopt').textContent + '/disabled=' + q('#btn-adopt').disabled;
  out.i4_bindBtnEnabled = !q('#btn-bind').disabled;
  q('#btn-bind').click(); await wait();
  out.i4_sheetList = bindNames();
  ok.i4_kaelInList = bindNames().some(function(t){return t.indexOf('카엘')>-1;});
  // 연결 대상 선택 가능한지 (카엘 행이 기본 선택)
  q('#btn-bind-go').click(); await wait(200);
  window.suiteGo('mine'); await wait();
  out.i4_pocket = q('#pocket h2').textContent;
  ok.i4_pocketKael = out.i4_pocket.indexOf('카엘')>-1;

  /* === 이슈 2: 이름·역할 편집 저장 -> 채택/다시열기에서 유지 === */
  window.suiteGo('shelf'); await wait();
  shelfRow('리오넬').click(); await wait();
  var nm = q('#edit-root [data-key="name"]'), rl = q('#edit-root [data-key="role"]');
  out.i2_init = nm.value + ' / ' + rl.value;
  setv(nm, '리오넬 베르그'); setv(rl, '근위대 대장'); await wait();
  out.i2_dirty = stitle() + ' / adoptDisabled=' + q('#btn-adopt').disabled;
  ok.i2_adoptBlockedWhileDirty = q('#btn-adopt').disabled;
  bar().querySelector('[data-save]').click(); await wait();
  out.i2_saved = stitle() + ' / name=' + nm.value + ' / role=' + rl.value;
  q('#btn-adopt').click(); await wait();
  out.i2_afterAdopt = nm.value + ' / ' + rl.value + ' / ' + q('#btn-adopt').textContent;
  ok.i2_valuesKeptAfterAdopt = nm.value==='리오넬 베르그' && rl.value==='근위대 대장';
  // 다른 곳 갔다 다시 열기
  window.suiteGo('shelf'); await wait();
  var row = shelfRow('리오넬 베르그'); out.i2_shelfHasNewName = !!row;
  row.click(); await wait();
  nm = q('#edit-root [data-key="name"]'); rl = q('#edit-root [data-key="role"]');
  out.i2_reopen = nm.value + ' / ' + rl.value;
  ok.i2_reopenKept = nm.value==='리오넬 베르그' && rl.value==='근위대 대장';
  // 채택본 이름도 편집 후 이름으로
  window.suiteGo('mine'); await wait();
  out.i2_mineList = qa('#mine-list .pcard').map(function(c){return c.textContent.replace(/\s+/g,' ').trim().slice(0,28)});
  ok.i2_mineHasNewName = out.i2_mineList.some(function(t){return t.indexOf('리오넬 베르그')>-1;});

  /* === 이슈 3: 설정 미저장 + Persona 편집 열기 -> 설정 미저장 유지 === */
  window.suiteGo('settings'); await wait();
  var ins = qa('.page[data-page=settings] input.input');
  var model = ins.filter(function(i){return i.value==='model-name'})[0];
  setv(model, 'gpt-x-test'); await wait();
  out.i3_settingsDirty = stitle();
  window.suiteGo('shelf'); await wait();
  out.i3_navMarks = nav().join(',');
  shelfRow('세라 하운').click(); await wait();
  out.i3_editTitle = stitle() + ' / navMarks=' + nav().join(',');
  ok.i3_editSavedLabel = stitle().indexOf('저장되어 있습니다')>-1;
  ok.i3_settingsStillMarked = nav().indexOf('settings')>-1;
  window.suiteGo('settings'); await wait();
  out.i3_settingsBack = stitle() + ' / model=' + model.value;
  ok.i3_settingsDirtyStillCounted = /1개 변경/.test(stitle()) && model.value==='gpt-x-test';
  bar().querySelector('[data-revert]').click(); await wait();
  out.i3_settingsReverted = stitle() + ' / model=' + model.value;
  ok.i3_revertOk = model.value==='model-name';

  /* === 클래식 생성: 원본 Persona 선택 반영 === */
  window.suiteGo('make'); await wait();
  var sel = q('#src-sel');
  out.src_options = qa('option', sel).map(function(o){return o.value+':'+o.textContent});
  var pick = qa('option', sel).filter(function(o){return o.textContent.indexOf('길손')>-1})[0];
  if (pick) { sel.value = pick.value; fire(sel); }
  q('#mk-classic').click(); await wait(300);
  var ov = qa('.overlay.is-open').pop();
  out.classic_overlay = ov ? (ov.id + ' :: ' + ov.textContent.replace(/\s+/g,' ').slice(0,200)) : 'none';
  ok.classic_usesSelected = !!ov && ov.textContent.indexOf('길손')>-1;

  out.ok = ok;
  out.failed = Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
