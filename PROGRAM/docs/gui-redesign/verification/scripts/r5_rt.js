(async function(){
  var out={},ok={};
  function q(s,r){return (r||document).querySelector(s);} function qa(s,r){return [].slice.call((r||document).querySelectorAll(s));}
  function fire(el){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
  function wait(ms){return new Promise(function(r){setTimeout(r,ms||90)});}
  function toastT(){var t=qa('.toast');return t.length?t[t.length-1].textContent:'';}
  function openId(){var o=qa('.overlay.is-open');return o.length?o[o.length-1].id:'none';}
  window.suiteGo('server'); await wait();
  out.kinds = qa('#kinds .kind').map(function(k){return k.textContent.trim()}).join(','); ok.kindCounts = /전체 7/.test(out.kinds) && /고아 메모리 후보 3/.test(out.kinds);
  out.elig = q('#elig-n').textContent; ok.activeExcluded = q('.scope-card.k-active .sel').disabled;
  q('#btn-sel-all').click(); await wait();
  out.selAll = qa('.scope-card .sel:checked').map(function(c){return c.getAttribute('aria-label')}).join(',');
  ok.selAllNoActive = !/에피소드 42/.test(out.selAll) && /에피소드 40/.test(out.selAll);
  // RT-01 0 selection: ctx removed, direct open blocked
  qa('.scope-card .sel:checked').forEach(function(c){c.click();}); await wait();
  ok.ctxCleared = !q('#btn-sel-del').hasAttribute('data-ctx');
  window.suiteOpen('dlg-del'); await wait(100);
  out.del0 = 'note=' + !q('#dlg-del .require-note').hidden; ok.del0Blocked = !q('#dlg-del .require-note').hidden;
  window.suiteClose('dlg-del');
  // RT-02 pin active
  var act = q('.scope-card.k-active'); act.querySelector('[data-pin]').click(); await wait();
  out.pin = act.textContent.indexOf('삭제 차단')>-1 && act.querySelector('[data-open="dlg-del"]').hidden; ok.pinBlocks = out.pin;
  act.querySelector('[data-pin]').click(); await wait(); ok.unpin = !act.querySelector('[data-open="dlg-del"]').hidden;
  // unpin 바닷가 마을 -> selectable
  var sea = qa('.scope-card').filter(function(c){return /바닷가 마을/.test(c.textContent)})[0]; sea.querySelector('[data-pin]').click(); await wait();
  ok.seaSelectable = !sea.querySelector('.sel').disabled && !sea.querySelector('[data-open="dlg-del"]').hidden;
  // RT-07 filter
  qa('#kinds .kind')[3].click(); await wait(80);
  out.filter = qa('.scope-card').filter(function(c){return !c.hidden}).length; ok.filter = out.filter===3;
  qa('#kinds .kind')[0].click(); await wait(80);
  // RT-04 backup
  q('[data-run-job="job-backup"]').click(); await wait(4800);
  out.bk = q('#bk-when').textContent + ' | ' + q('#bk-badge').textContent + ' | ' + q('#rs-bk').value + ' | ' + q('#bk-check-t').textContent.slice(0,30);
  ok.backupReflected = q('#bk-when').textContent==='방금' && /방금/.test(q('#rs-bk').value); window.suiteClose('job-backup');
  // RT-05 retry
  window.suiteGo('next'); await wait();
  qa('[data-open=dlg-retry]')[0].click(); await wait(100); q('#retry-go').click(); await wait(100);
  out.retry = document.documentElement.dataset.scenario + ' | ' + toastT(); ok.retryOk = document.documentElement.dataset.scenario==='ok';
  window.suiteOpen('dlg-retry'); await wait(80); ok.retryNoneInOk = q('#retry-go').disabled; window.suiteClose('dlg-retry');
  // RT-06 josa
  window.suiteGo('server'); await wait();
  qa('.rs-ns').forEach(function(c){ if(c.value==='LIA'||c.value==='RE:TRACE'){ if(!c.checked) c.click(); } else if(c.checked) c.click(); }); await wait();
  out.preview = q('#btn-rs-preview').dataset.toast; ok.noBadJosa = !/Flashback는|없음는/.test(out.preview);
  out.ok=ok; out.failed=Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
