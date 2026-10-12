/* 4차 이후 검토의 4개 경로 재현. PAGE 전역으로 화면을 고른다 */
(async function(){
  var out={},ok={};
  function q(s,r){return (r||document).querySelector(s);} function qa(s,r){return [].slice.call((r||document).querySelectorAll(s));}
  function fire(el){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
  function wait(ms){return new Promise(function(r){setTimeout(r,ms||90)});}
  function toastT(){var t=qa('.toast');return t.length?t[t.length-1].textContent:'';}
  var page=location.pathname.split('/').pop();
  if(page==='flashback.html'){
    /* ?open=job-maint 로 열린 상태 (페이지를 ?open=job-maint 로 연다) */
    out.qOpen = q('#job-maint').dataset.state + ' | open=' + q('#job-maint').classList.contains('is-open') + ' | ' + toastT();
    ok.qOpenBlocked = q('#job-maint').dataset.state!=='running' && q('#job-maint').dataset.state!=='done';
    window.suiteClose('job-maint');
    /* 스크립트로 직접 시작해도 같은 조건 */
    q('[data-run-job="job-maint"]') && 0;
    var bmaint=q('#btn-maint'); out.btn=bmaint.disabled;
    /* 동의 후 정식 버튼 */
    q('#consent').click(); await wait(); bmaint.click(); await wait(200);
    ok.consentStarts = q('#job-maint').dataset.state==='running'; window.suiteClose('job-maint');
    /* 복원: 입력 확인 없이 직접 시작 불가, 입력 후 가능, 한 번 쓰면 다시 잠김 */
    var fr=q('#job-restore'); var before=fr.dataset.state;
    document.dispatchEvent(new CustomEvent('x'));
    out.restoreDirect = toastT();
  }
  if(page==='retrace.html'){
    window.suiteGo('server'); await wait();
    /* 무대상 삭제창 열기 → 닫기 */
    window.suiteOpen('dlg-del'); await wait(80); out.noTarget = q('#btn-del').disabled; window.suiteClose('dlg-del'); await wait();
    /* 정상 대상 삭제창 */
    var b = qa('.scope-card [data-open="dlg-del"]').filter(function(x){return !x.hidden && /에피소드 40/.test(x.dataset.ctx||'')})[0]; b.click(); await wait(100);
    out.withTarget = 'btn disabled=' + q('#btn-del').disabled + ' note hidden=' + q('#dlg-del .require-note').hidden;
    ok.typedStillRequired = q('#btn-del').disabled===true && q('#dlg-del .require-note').hidden;
    var ti = q('#dlg-del [data-typed]'); ti.value='정리'; fire(ti); await wait();
    ok.typedUnlocks = !q('#btn-del').disabled;
    q('#btn-del').click(); await wait(200); ok.jobStarts = q('#job-del').dataset.state==='running';
    /* 같은 확인을 재사용해 다시 시작할 수 없음 */
    window.suiteClose('job-del');
  }
  if(page==='lia.html'){
    window.suiteGo('assets'); await wait();
    var at=q('#asset-target'); at.value='sera'; fire(at); await wait();
    out.seraBefore = q('#as-n').textContent;
    q('[data-run-job="job-emo"]:not(.proto-bar *)') ? q('.page.is-active [data-run-job="job-emo"]').click() : 0; await wait(200);
    out.jobTitle = q('#je-t').textContent; window.suiteClose('job-emo');
    var opt=qa('option',at).filter(function(o){return /길손/.test(o.textContent)})[0]; at.value=opt.value; fire(at); await wait();
    await wait(5200);
    out.wanderer = q('#as-n').textContent;
    at.value='sera'; fire(at); await wait(); out.seraAfter = q('#as-n').textContent;
    ok.resultToStartTarget = /0 \/ 12/.test(out.wanderer) && /12 \/ 12/.test(out.seraAfter);
    /* 개별 감정: 길손에서 시작 → 세라로 전환 → 길손에 반영 */
    at.value=opt.value; fire(at); await wait();
    qa('#emo-grid .emo').filter(function(b){return /happy/.test(b.textContent)})[0].click(); await wait(100);
    qa('#sheet-emo .big-choice').filter(function(b){return b.dataset.runJob==='job-neutral'})[0].click(); await wait(200);
    out.neutralTitle = q('#jn-t').textContent; window.suiteClose('job-neutral');
    at.value='sera'; fire(at); await wait(); await wait(5200);
    at.value=opt.value; fire(at); await wait(); out.wHappy = qa('#emo-grid .emo').filter(function(b){return /happy/.test(b.textContent)})[0].className;
    ok.singleToStartTarget = /is-done/.test(out.wHappy);
    /* ?open=job-emo 같은 대상 없는 시작은 막힘 */
  }
  if(page==='libra.html'){
    window.suiteGo('memory'); await wait();
    window.suiteOpen('dlg-range'); await wait(100);
    var miss=qa('#seglist input').filter(function(i){return i.getAttribute('aria-label')==='T91–95 선택'})[0]; miss.checked=true; fire(miss); await wait();
    q('#range-go').click(); await wait(6300); window.suiteClose('job-memory'); await wait();
    var ch = q('#memory-root .chapter[data-select-row="m19"]'); out.rail = ch ? ch.textContent : 'NONE';
    ok.memoryAdded = !!ch;
    ch.click(); await wait();
    var art=q('#memory-root [data-detail="m19"]'); out.detail = art && !art.hidden ? art.querySelector('.eyebrow').textContent : 'hidden';
    ok.detailShown = !!art && !art.hidden;
    out.pagerM21 = q('#memory-root [data-detail="m21"] .pager button').textContent;
    ok.pagerLinked = /M-19/.test(out.pagerM21);
    /* 이어서 재생성: 카드 버튼 → 결과 → 후보 비교 */
    q('#seg-mode button[data-val=manage]').click(); await wait();
    qa('button',art).filter(function(b){return /재생성 후보/.test(b.textContent)})[0].click(); await wait(120);
    out.regenSel = qa('#seglist input:checked').map(function(i){return i.getAttribute('aria-label')}).join(',');
    q('#range-go').click(); await wait(6300);
    qa('#job-memory [data-then-open]').filter(function(b){return !b.hidden&&!b.closest('[hidden]')})[0].click(); await wait(200);
    out.compare = q('#dv-t').textContent + ' | ' + qa('#ver-rows .row__title').map(function(r){return r.textContent}).join(',');
    ok.compareHasCandidate = /M-19/.test(out.compare) && /재생성 후보/.test(out.compare);
    window.suiteClose('drawer-versions');
    /* 버전 기록에 생성 실행도 남음 */
    out.nav = q('#nav-mem-n').textContent;
  }
  out.ok=ok; out.failed=Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
