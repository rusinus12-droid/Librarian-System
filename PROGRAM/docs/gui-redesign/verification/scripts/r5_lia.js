(async function(){
  var out={},ok={};
  function q(s,r){return (r||document).querySelector(s);} function qa(s,r){return [].slice.call((r||document).querySelectorAll(s));}
  function fire(el){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
  function wait(ms){return new Promise(function(r){setTimeout(r,ms||90)});}
  function toastT(){var t=qa('.toast');return t.length?t[t.length-1].textContent:'';}
  function openId(){var o=qa('.overlay.is-open');return o.length?o[o.length-1].id:'none';}
  function shelfRow(name){return qa('#shelf-list .row').filter(function(r){return r.textContent.indexOf(name)>-1})[0];}
  // LIA-03 consistent update state
  window.suiteGo('mine'); await wait();
  out.mineUpd = q('#upd-badge').textContent + ' | ' + q('#upd-hint').textContent;
  window.suiteGo('update'); await wait();
  out.updPage = q('#upd2-badge').textContent + ' | go=' + q('#upd-go').disabled + ' | ' + q('#upd2-why').textContent;
  ok.updConsistent = /3 \/ 5/.test(out.mineUpd) && q('#upd-go').disabled;
  // simulate turns
  q('#proto-turn').click(); q('#proto-turn').click(); await wait();
  ok.updReady = !q('#upd-go').disabled && /준비됨/.test(q('#upd2-badge').textContent);
  q('#upd-go').click(); await wait(4800);
  var cancel = q('#job-update [data-job-cancel]'); out.cancelAtSave = cancel.disabled; await wait(1500);
  ok.cancelLockedAtSave = out.cancelAtSave===true;
  window.suiteClose('job-update'); await wait();
  out.hist = qa('#upd-hist .ver b').map(function(b){return b.textContent}).join(' | ') + ' | badge=' + q('#upd2-badge').textContent;
  ok.histAdded = /TURN 6~10 · 방금/.test(out.hist) && /0 \/ 5/.test(out.hist);
  // restore with ctx
  qa('#upd-hist [data-open=sheet-restore]')[0].click(); await wait(100);
  out.restore = q('#sheet-restore .muted').textContent; q('#sheet-restore [data-act=upd-restore]').click(); await wait(100);
  ok.restoreTarget = /TURN 6~10/.test(out.restore) && /복원됨/.test(q('#upd-hist').textContent);
  // LIA-12 candidates -> bound(sera) draft
  q('[data-page=update] [data-subtab=full]').click(); await wait();
  out.chg = q('#chg-hint').textContent; q('#chg-go').click(); await wait(100); out.chgToast = toastT();
  window.suiteGo('shelf'); await wait();
  out.shelfDraft = shelfRow('세라 하운').textContent.replace(/\s+/g,' ').slice(0,60); ok.draftMarked = /저장하지 않은 편집/.test(out.shelfDraft);
  shelfRow('세라 하운').click(); await wait(150);
  out.speech = q('#edit-root [data-key=speech]').value + ' | ' + q('#savebar [data-save-title]').textContent;
  ok.candidateInDraft = /줄임표/.test(out.speech) && /변경/.test(out.speech);
  // LIA-13 review tab for sera then kael
  q('#edit-root [data-subtab=rev]').click(); await wait();
  out.rvSera = q('#rv-note').textContent; q('#rv-apply').click(); await wait(100);
  ok.reviewApply = q('#edit-root [data-key=hiddenSide]').value.indexOf('최종 선택은 상황')>-1;
  q('#savebar [data-revert]').click(); await wait(100);
  window.suiteGo('shelf'); await wait(); shelfRow('카엘 로웬').click(); await wait(150); q('#edit-root [data-subtab=rev]').click(); await wait();
  out.rvKael = q('#rv-note').textContent + ' acts hidden=' + q('#rv-acts').hidden; ok.reviewPerPersona = /제안이 없습니다/.test(out.rvKael) && q('#rv-acts').hidden;
  // LIA-06 assets per target
  window.suiteGo('assets'); await wait();
  out.asSera = q('#as-n').textContent + ' | ' + q('#as-state').textContent;
  var at = q('#asset-target'); var opt = qa('option',at).filter(function(o){return /길손/.test(o.textContent)})[0]; at.value=opt.value; fire(at); await wait();
  out.asW = q('#as-n').textContent + ' | ' + q('#as-state').textContent + ' | ' + q('#as-sum').textContent;
  ok.assetsPerTarget = /9 \/ 12/.test(out.asSera) && /0 \/ 12/.test(out.asW);
  // LIA-09 emo sheet todo -> no delete
  at.value=''; fire(at); await wait();
  qa('#emo-grid .emo').filter(function(b){return /jealous/.test(b.textContent)})[0].click(); await wait(100);
  var del = qa('#sheet-emo [data-act=emo-del]')[0]; out.emoTodoDel = del.hidden; ok.todoNoDelete = del.hidden===true;
  window.suiteClose('sheet-emo');
  qa('#emo-grid .emo').filter(function(b){return /happy/.test(b.textContent)})[0].click(); await wait(100);
  q('#sheet-emo [data-act=emo-del]').click(); await wait(100);
  out.afterEmoDel = q('#as-n').textContent; ok.emoDeleted = /8 \/ 12/.test(out.afterEmoDel);
  qa('#emo-grid .emo').filter(function(b){return /neutral/.test(b.textContent)})[0].click(); await wait(100);
  ok.masterNoDelete = q('#sheet-emo [data-act=emo-del]').hidden; window.suiteClose('sheet-emo');
  // LIA-10 emotion list edit
  var el = q('#emo-list'); el.value='neutral, happy, sad'; fire(el); await wait();
  out.emoList = q('#as-n').textContent; ok.emoListApplied = /\/ 3$/.test(out.emoList);
  // LIA-11 recover
  window.suiteGo('recover'); await wait();
  qa('.rc').forEach(function(c){if(c.checked)c.click();}); await wait();
  ok.recover0 = q('#rc-go').disabled;
  qa('.rc').forEach(function(c){c.click();}); await wait();
  out.rc2 = q('#rc-go').textContent + ' | ' + q('#rc-hint').textContent;
  q('#rc-go').click(); await wait(); out.rcArm = q('#rc-go').textContent; q('#rc-go').click(); await wait();
  out.rcDone = toastT(); ok.recoverCount = /2개/.test(out.rcDone) && /덮어씀/.test(out.rcDone);
  // LIA-02 edit with no cur
  window.suiteGo('shelf'); await wait(); shelfRow('카엘 로웬').click(); await wait(150);
  q('#edit-root [data-subtab=out]').click(); await wait(); q('#btn-del-vault').click(); await wait(100);
  qa('#sheet-del-vault .dialog__actions button').filter(function(b){return /삭제/.test(b.textContent)})[0].click(); await wait(150);
  window.suiteGo('edit'); await wait(100);
  out.editNoCur = q('.page.is-active').dataset.page + ' | ' + toastT(); ok.editRedirect = q('.page.is-active').dataset.page==='shelf';
  // LIA-01 proto Persona 생성
  q('[data-proxy="mk-classic"]').click(); await wait(200);
  out.protoGen = openId() + ' | ' + q('#job-gen h2').textContent; ok.protoGen = openId()==='job-gen' && !/새 Persona/.test(out.protoGen);
  await wait(5200); window.suiteClose('job-gen');
  // LIA-14 search
  window.suiteGo('shelf'); await wait(); var sq = q('[data-page=shelf] .search input'); sq.value='리오넬'; fire(sq); await wait();
  out.search = qa('#shelf-list .row').filter(function(r){return !r.hidden}).length; ok.search = out.search===1; sq.value=''; fire(sq);
  // LIA-08 image provider off
  window.suiteGo('settings'); await wait(); var ip = q('#img-provider'); ip.value='사용 안 함'; fire(ip); q('#savebar [data-save]').click(); await wait(150);
  window.suiteGo('mine'); await wait(); out.imgOff = qa('#pocket [data-go=assets]').map(function(b){return b.hidden}).join(); ok.imgHidden = /true/.test(out.imgOff);
  // LIA-16 nav marker for edit
  window.suiteGo('shelf'); await wait(); shelfRow('리오넬').click(); await wait(150);
  var nm = q('#edit-root [data-key=name]'); nm.value='리오넬 X'; fire(nm); await wait();
  window.suiteGo('mine'); await wait(); ok.navShelfMarked = q('.nav-item[data-go=shelf]').classList.contains('is-unsaved');
  out.ok=ok; out.failed=Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
