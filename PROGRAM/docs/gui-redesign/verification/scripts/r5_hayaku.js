(async function(){
  var out={},ok={};
  function q(s,r){return (r||document).querySelector(s);} function qa(s,r){return [].slice.call((r||document).querySelectorAll(s));}
  function fire(el){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
  function wait(ms){return new Promise(function(r){setTimeout(r,ms||90)});}
  function toastT(){var t=qa('.toast');return t.length?t[t.length-1].textContent:'';}
  function openId(){var o=qa('.overlay.is-open');return o.length?o[o.length-1].id:'none';}
  function vis(el){return !!(el&&el.offsetParent);}
  function scen(v){q('button[data-scenario="'+v+'"]').click();}
  // HY-06 ok scenario: recovery empty
  scen('ok'); await wait(); window.suiteGo('recovery'); await wait();
  out.okRecovery = 'pickerVisible=' + vis(q('#miss-picker')) + ' emptyVisible=' + qa('[data-subpanel=miss] [data-scenario-show=ok]').some(vis);
  ok.okConsistent = !vis(q('#miss-picker')) && qa('[data-subpanel=miss] [data-scenario-show=ok]').some(vis);
  // proxy in ok: no target
  q('[data-proxy="miss-go"]').click(); await wait(120);
  out.proxyOk = openId() + ' | ' + toastT(); ok.proxyOkBlocked = openId()==='none';
  // warn scenario
  scen('warn'); await wait(); window.suiteGo('overview'); await wait();
  out.warnBanner = qa('.banner--warn b').map(function(b){return b.textContent}).join('');
  ok.warnBanner2 = /누락 2턴/.test(out.warnBanner);
  // HY-04 extra=0 saved: miss flow shows no extra
  window.suiteGo('recovery'); await wait();
  out.extraText = q('.x-extra').textContent;
  q('#miss-go').click(); await wait(120);
  out.dlgMiss = openId() + ' | ' + q('#dlg-miss [data-fill=extraText]').textContent;
  ok.extraZeroInDialog = /0회/.test(q('#dlg-miss [data-fill=extraText]').textContent);
  q('#dlg-miss [data-run-job]').click(); await wait(200);
  // HY-01/02 minimize & tray
  qa('#job-repair .dialog__actions button').filter(function(b){return b.textContent.indexOf('최소화')>-1})[0].click(); await wait(100);
  out.trayRunning = q('[data-job-tray]').textContent.trim(); ok.trayRunning = /진행 중/.test(out.trayRunning);
  await wait(6200);
  out.trayDone = q('[data-job-tray]').textContent.trim(); ok.trayDone = /완료된 작업/.test(out.trayDone);
  q('[data-job-tray]').click(); await wait(120);
  out.reopened = openId() + ' | actual=' + q('#job-repair [data-fill=actual]').textContent + ' | note=' + q('#job-repair [data-fill=actualNote]').textContent;
  ok.reopenAndActual = openId()==='job-repair' && q('#job-repair [data-fill=actual]').textContent==='1회';
  qa('#job-repair [data-job-done]')[0].click(); await wait(100);
  out.trayAfterAck = q('[data-job-tray]').textContent.trim(); ok.trayIdle = /작업 없음/.test(out.trayAfterAck);
  // regen minimize -> compare reachable via tray
  window.suiteGo('packets'); await wait();
  var rg = qa('[data-open=dlg-regen]')[0]; rg.click(); await wait(120);
  q('#dlg-regen [data-run-job]').click(); await wait(200);
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await wait(100);
  out.escClosed = openId(); await wait(4200);
  q('[data-job-tray]').click(); await wait(120);
  var cmp = qa('#job-regen [data-then-open=dlg-compare]')[0]; out.cmpBtnVisible = !cmp.hidden;
  cmp.click(); await wait(150); out.compare = openId() + ' | ' + q('#dcmp-t').textContent;
  ok.compareReachable = openId()==='dlg-compare';
  window.suiteClose('dlg-compare');
  // HY-03 proxy with selection 0 in warn
  window.suiteGo('recovery'); await wait(); q('#miss-none').click(); await wait();
  q('[data-proxy="miss-go"]').click(); await wait(120);
  out.proxyZero = openId() + ' | ' + toastT(); ok.proxyZeroBlocked = openId()==='none';
  q('#miss-all').click(); await wait();
  q('[data-proxy="miss-go"]').click(); await wait(120);
  out.proxyTwo = openId() + ' | ' + q('#dlg-miss [data-fill=target]').textContent; ok.proxyTwoOpens = openId()==='dlg-miss' && /T132, T118/.test(out.proxyTwo);
  window.suiteClose('dlg-miss');
  // HY-04 set extra=1, save
  window.suiteGo('settings'); await wait(); q('[data-subtab=safe]').click(); await wait();
  var ex = q('#st-extra'); ex.value='1'; fire(ex); await wait();
  q('#savebar-hy [data-save]').click(); await wait(120);
  window.suiteGo('recovery'); await wait();
  out.extraAfter = q('.x-extra').textContent; ok.extraOne = /\+1회/.test(out.extraAfter);
  // HY-05 cold results
  q('[data-page=recovery] [data-subtab=cold]').click(); await wait();
  var cb = q('#cold-batch'); cb.value='10'; fire(cb); await wait();
  // HY-08 unrelated save keeps per-run 10
  window.suiteGo('settings'); await wait(); q('[data-subtab=basic]').click(); await wait();
  var dbg = qa('[data-subpanel=basic] input[type=checkbox]').slice(-1)[0]; dbg.click(); await wait();
  q('#savebar-hy [data-save]').click(); await wait(150);
  window.suiteGo('recovery'); await wait(); out.coldKept = q('#cold-batch').value; ok.coldKept = out.coldKept==='10';
  q('#cold-go').click(); await wait(120); q('#dlg-cold [data-run-job]').click(); await wait(5800);
  out.coldRes = q('#job-cold [data-fill=saved]').textContent + '/' + q('#job-cold [data-fill=held]').textContent + ' actual=' + q('#job-cold [data-fill=actual]').textContent;
  ok.coldResult = q('#job-cold [data-fill=saved]').textContent==='144' && q('#job-cold [data-fill=actual]').textContent==='16회';
  window.suiteClose('job-cold');
  // HY-07 defaults
  window.suiteGo('settings'); await wait(); q('[data-subtab=basic]').click(); await wait();
  var en = qa('[data-subpanel=basic] input[type=checkbox]')[0]; en.click(); await wait();
  var before = q('#savebar-hy [data-save-title]').textContent;
  qa('[data-page=settings] [data-load-defaults]').filter(function(b){return b.closest('[data-subpanel=basic]')})[0].click(); await wait();
  out.defaults = before + ' -> checked=' + en.checked + ' | ' + toastT() + ' | ' + q('#savebar-hy [data-save-title]').textContent;
  ok.defaultsApplied = en.checked===true;
  // HY-09 readonly server
  window.suiteGo('server'); await wait();
  var sv = qa('[data-page=server] .choices[data-readonly] .choice')[1]; sv.click(); await wait();
  ok.serverReadonly = !sv.classList.contains('is-on'); out.serverToast = toastT();
  // HY-11 footer
  window.suiteGo('settings'); await wait(); q('[data-subtab=adv]').click(); await wait(); q('#ax-test').click(); await wait();
  out.foot = q('#foot-ax').textContent; ok.footUpdated = /확인됨/.test(out.foot);
  // S-02 tooltip cleared
  var setNav = q('.nav-item[data-go=settings]'); out.title = setNav.getAttribute('title'); ok.noStaleTitle = !setNav.getAttribute('title') || /저장하지 않은/.test(setNav.getAttribute('title'))===false;
  // fail scenario: recovery buttons blocked
  scen('fail'); await wait(); window.suiteGo('recovery'); await wait();
  q('[data-proxy="cold-go"]').click(); await wait(120); out.failProxy = openId() + ' | ' + toastT(); ok.failBlocked = openId()==='none';
  scen('ok');
  out.ok=ok; out.failed=Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
