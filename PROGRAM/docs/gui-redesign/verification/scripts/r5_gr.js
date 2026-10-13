(async function(){
  var out={},ok={};
  function q(s,r){return (r||document).querySelector(s);} function qa(s,r){return [].slice.call((r||document).querySelectorAll(s));}
  function fire(el){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
  function wait(ms){return new Promise(function(r){setTimeout(r,ms||90)});}
  function toastT(){var t=qa('.toast');return t.length?t[t.length-1].textContent:'';}
  function openId(){var o=qa('.overlay.is-open');return o.length?o[o.length-1].id:'none';}
  function bar(){return q('#savebar [data-save-title]').textContent;}
  out.start = bar() + ' | prov=' + q('#n-prov').textContent + ' nav=' + q('#nav-prov-n').textContent;
  ok.provCount = q('#n-prov').textContent==='2 / 3';
  // GR-01
  qa('#q-quality .choice')[1].click(); await wait(120); out.qbadge = q('#q-badge').textContent; ok.qBadge = out.qbadge==='현재: 균형 있게';
  // GR-02
  qa('#q-input .choice')[1].click(); await wait(120);
  out.inp = 'pipe=' + qa('#inp-mode .choice').map(function(c){return c.classList.contains('is-on')?1:0}).join('') + ' sub=' + q('#lb-inp-sub').textContent + ' | ' + bar();
  ok.inputSynced = /pipe=01/.test(out.inp) && q('#lb-inp-sub').textContent==='사용' && /2개 변경/.test(bar());
  window.suiteGo('pipeline'); await wait();
  qa('[data-select-row=inp]')[0].click(); await wait();
  qa('#inp-mode .choice')[0].click(); await wait(120);
  ok.inputBack = q('#q-input .choice').classList.contains('is-on');
  // GR-03 stage switch
  var c0 = q('#foot-calls').textContent;
  qa('[data-select-row=char]')[0].click(); await wait(); q('#on-s2').click(); await wait(120);
  out.calls = c0 + ' -> ' + q('#foot-calls').textContent + ' mini=' + q('#mini-s2').style.textDecoration; ok.stageSwitch = c0!==q('#foot-calls').textContent && /line-through/.test(out.calls);
  qa('[data-select-row=shadow]')[0].click(); await wait(); q('#on-s1').click(); await wait(120);
  out.shadowOff = q('#foot-calls').textContent; ok.shadowOff = /0회/.test(out.shadowOff);
  q('#on-s1').click(); q('#on-s2').click(); await wait(120);
  // GR-04 rename + stage preset
  window.suiteGo('providers'); await wait();
  var nm = qa('[data-detail=p2] .input')[0]; nm.value='새 이름 프리셋'; fire(nm); await wait();
  out.rename = q('[data-select-row=p2] .row__title').textContent + ' | opt=' + qa('option[data-prov=p2]').map(function(o){return o.textContent}).slice(0,1).join() + ' | meta=' + q('[data-select-row=p2] .row__meta').textContent;
  ok.renamePropagates = /새 이름 프리셋/.test(out.rename) && /opt=새 이름 프리셋/.test(out.rename);
  window.suiteGo('pipeline'); await wait(); qa('[data-select-row=shadow]')[0].click(); await wait();
  var shSel = q('[data-detail=shadow] select'); shSel.selectedIndex=1; fire(shSel); await wait();
  window.suiteGo('sources'); await wait(); out.shModel = q('#src-shadow-model').textContent; ok.shadowModel = out.shModel==='gpt-4.1';
  // GR-05 test ollama
  window.suiteGo('providers'); await wait(); q('[data-prov-test=p3]').click(); await wait(); out.ollama = toastT(); ok.ollamaFails = /실패/.test(out.ollama);
  // GR-06 import diff
  window.suiteGo('manage'); await wait();
  out.imp = q('#imp-diff').textContent; ok.impCurrent = /1,000~2,000자/.test(out.imp) && /경량/.test(out.imp);
  q('#imp-replace').click(); await wait(120); out.impAfter = q('#imp-none').hidden + ' ' + toastT(); ok.impApplied = !q('#imp-none').hidden;
  // GR-07 close dialog with changes
  var n = window.suiteDirty('gradia'); q('[data-open=dlg-close].btn').click(); await wait(120);
  out.close = q('#r4').innerText + ' n=' + n; ok.closeCount = new RegExp(n+'개').test(q('#r4').innerText);
  qa('#dlg-close [data-act=close-save]')[0].click(); await wait(150); out.afterSave = bar(); ok.closeSaved = /저장되어/.test(bar());
  q('[data-open=dlg-close].btn').click(); await wait(120); out.closeClean = q('#r4').innerText; ok.closeClean = /없습니다/.test(out.closeClean); window.suiteClose('dlg-close');
  // GR-08 OOC
  window.suiteGo('pipeline'); await wait(); qa('[data-select-row=plot]')[0].click(); await wait();
  qa('[data-detail=plot] [data-open=dlg-ooc]')[0].click(); await wait(120);
  qa('#dlg-ooc [data-act=ooc-gen]')[0].click(); await wait(120);
  out.ooc = q('[data-stage-ins="플롯 AIDE"]').value.slice(0,20) + ' | ' + bar(); ok.oocFilled = q('[data-stage-ins="플롯 AIDE"]').value.length>0 && /1개 변경/.test(bar());
  // GR-09 skill no ctx
  window.suiteOpen('dlg-skill'); await wait(100); q('#sk-name').value='x'; fire(q('#sk-name')); await wait();
  ok.skillNoCtxLocked = q('#sk-save-b').disabled && q('#sk-save-c').disabled; window.suiteClose('dlg-skill');
  // GR-11 sources
  window.suiteGo('sources'); await wait(); qa('[data-page=sources] [data-subtab=char]')[0].click(); await wait();
  var lc = q('#lib-char input'); lc.click(); await wait();
  out.src = q('#sum-char').textContent + ' badge=' + q('#lib-char .badge').textContent; ok.srcCount = /11 \/ 14/.test(out.src) && /제외/.test(out.src);
  qa('[data-page=sources] [data-subtab=sum]')[0].click(); await wait();
  qa('#sum-char')[0].closest('.choice').click(); await wait(); ok.sumReadonly = q('#sum-char').closest('.choice').classList.contains('is-on');
  // GR-12 URL change
  var u = q('#lib-url'); u.value='http://10.0.0.5:9999'; fire(u); await wait();
  out.lib = q('#lib-chip').textContent + ' | ' + q('#lib-state').textContent; ok.libStale = /다시 연결/.test(out.lib);
  q('#lib-connect').click(); await wait(); out.lib2 = q('#lib-chip').textContent; 
  q('#lib-disconnect').click(); await wait(); ok.libOff = /연결 안 됨/.test(q('#lib-chip').textContent);
  // GR-13 reco already
  window.suiteGo('home'); await wait(); qa('#q-quality .choice')[1].click(); qa('#q-length .choice')[1].click(); qa('#q-runmode .choice')[2].click(); await wait(150);
  ok.recoDisabled = q('#btn-reco-apply').disabled;
  out.ok=ok; out.failed=Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
