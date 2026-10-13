(async function(){
  var out = {}, ok = {};
  function q(s,r){ return (r||document).querySelector(s); }
  function qa(s,r){ return [].slice.call((r||document).querySelectorAll(s)); }
  function fire(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  function wait(ms){ return new Promise(function(r){setTimeout(r,ms||80)}); }
  out.pages = qa('.page').map(function(p){return p.dataset.page}).join(',');

  /* 타이핑 확인창: 열 때마다 초기화 (B04) */
  var openers = qa('[data-open]').filter(function(b){ var t = document.getElementById(b.dataset.open); return t && t.querySelector('[data-typed]'); });
  out.typedOpeners = openers.map(function(b){return b.dataset.open});
  var firstOpener = openers.filter(function(b){return b.dataset.open==='dlg-reset'})[0] || openers[0];
  firstOpener.click(); await wait();
  var ov = qa('.overlay.is-open').pop(); var ti = q('[data-typed]', ov); var btn = document.getElementById(ti.dataset.typedTarget);
  out.typed0 = { id: ov.id, disabled: btn.disabled };
  ti.value = ti.dataset.typed; fire(ti); await wait();
  out.typedFilled = { disabled: btn.disabled };
  window.suiteClose(ov.id); await wait();
  firstOpener.click(); await wait();
  out.typedReopened = { value: ti.value, disabled: btn.disabled };
  ok.typedResetOnReopen = ti.value==='' && btn.disabled===true;
  window.suiteClose(ov.id);

  /* 취소(job-cancel)는 진행을 멈춘다 (B06) */
  var jobs = ['job-backup','job-reset','job-next'];
  for (var i=0;i<jobs.length;i++){
    var id = jobs[i]; window.suiteOpen(id);
  }
  window.suiteClose('job-backup'); window.suiteClose('job-reset'); window.suiteClose('job-next');
  var jb = qa('[data-run-job="job-backup"]')[0]; 
  jb.click(); await wait(200);
  out.backupJobOpen = !!q('#job-backup.is-open') + ' state=' + q('#job-backup').dataset.state;
  var cancel = q('#job-backup [data-job-cancel]'); cancel.click(); await wait(1400);
  out.backupAfterCancel = 'state=' + q('#job-backup').dataset.state + ' open=' + !!q('#job-backup.is-open');
  ok.cancelStops = q('#job-backup').dataset.state==='cancelled';

  /* 완료까지 */
  jb.click(); await wait(6600);
  out.backupDone = 'state=' + q('#job-backup').dataset.state;
  ok.jobCompletes = q('#job-backup').dataset.state==='done';
  window.suiteClose('job-backup');
  out.ok = ok; out.failed = Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
