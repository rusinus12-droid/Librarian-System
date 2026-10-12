(async function(){
  var out = {}, ok = {};
  function q(s,r){ return (r||document).querySelector(s); }
  function qa(s,r){ return [].slice.call((r||document).querySelectorAll(s)); }
  function fire(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  function wait(ms){ return new Promise(function(r){setTimeout(r,ms||80)}); }
  function checked(){ return qa('#seglist input:checked').map(function(i){return i.getAttribute('aria-label')}); }
  function regenBtn(seg){ return qa('[data-open=dlg-range]').filter(function(b){ return b.dataset.ctx && b.dataset.ctx.indexOf(seg)>-1; })[0]; }

  /* 이슈 1: M-25 재생성 -> 취소 -> M-23 재생성 */
  window.suiteGo('memory'); await wait();
  regenBtn('T121').click(); await wait();
  out.firstOpen = { kind: q('#kind-sel').value, checked: checked(), n: q('#range-n').textContent, calls: q('#range-calls').textContent.slice(0,6), go: q('#range-go').disabled };
  ok.firstOnlyM25 = checked().join()==='T121–125 선택';
  // 사용자가 추가로 하나 더 체크한 상태에서 취소
  var extra = qa('#seglist input').filter(function(i){return i.getAttribute('aria-label')==='T106–110 선택'})[0]; extra.checked = true; fire(extra); await wait();
  out.afterExtra = checked();
  q('#dlg-range [data-close]').click(); await wait();
  regenBtn('T111').click(); await wait();
  out.secondOpen = { kind: q('#kind-sel').value, checked: checked(), n: q('#range-n').textContent };
  ok.secondOnlyM23 = checked().join()==='T111–115 선택' && q('#range-n').textContent==='1';
  // 실행 -> 작업 대상/결과 문구
  q('#range-go').click(); await wait(300);
  var job = q('#job-memory');
  out.job = job.textContent.replace(/\s+/g,' ').slice(0,260);
  ok.jobMentionsM23 = /T111/.test(job.textContent) && !/T121/.test(job.textContent);
  window.suiteClose('job-memory');
  // 다른 모드로 열기(헤더 버튼 등)
  var plain = qa('[data-open=dlg-range]').filter(function(b){return !b.dataset.ctx})[0];
  plain.click(); await wait();
  out.plainOpen = { kind: q('#kind-sel').value, checked: checked() };
  ok.plainOpenEmpty = checked().length===0;
  window.suiteClose('dlg-range');

  /* 최근 대화 설정 서랍 ↔ 설정 화면 동기화 */
  var peers = qa('[data-sync=recent_use]'); out.syncPeers = peers.length;
  var a = peers[0], b2 = peers[1]; var before = a.checked;
  a.checked = !before; fire(a); await wait();
  ok.syncMirrored = b2.checked === a.checked;
  a.checked = before; fire(a);
  out.ok = ok; out.failed = Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
