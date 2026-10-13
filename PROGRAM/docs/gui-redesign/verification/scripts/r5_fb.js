(async function(){
  var out={},ok={};
  function q(s,r){return (r||document).querySelector(s);} function qa(s,r){return [].slice.call((r||document).querySelectorAll(s));}
  function fire(el){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
  function wait(ms){return new Promise(function(r){setTimeout(r,ms||90)});}
  function toastT(){var t=qa('.toast');return t.length?t[t.length-1].textContent:'';}
  function openId(){var o=qa('.overlay.is-open');return o.length?o[o.length-1].id:'none';}
  function bar(){return qa('.savebar').filter(function(b){return b.offsetParent!==null})[0];}
  out.counts=[q('#nav-scope-n').textContent,q('#tab-scope-n').textContent,q('#nav-log-n').textContent].join('/'); ok.counts=out.counts==='4/4/2';
  // FB-01 proto maint without consent
  q('[data-proxy="btn-maint"]').click(); await wait(150);
  out.maintProxy = openId()+' | page='+q('.page.is-active').dataset.page+' | '+toastT(); ok.maintBlocked = openId()==='none' && q('.page.is-active').dataset.page==='care';
  // consent -> run -> status
  q('#consent').click(); await wait(); q('[data-proxy="btn-maint"]').click(); await wait(150); ok.maintOpensAfterConsent = openId()==='job-maint';
  await wait(5600); window.suiteClose('job-maint'); await wait();
  out.maintStatus = q('#maint-hint').textContent+' | '+q('#maint-badge').textContent+' | plan='+q('#plan-badge').textContent+' | consent='+q('#consent').checked;
  ok.maintStatus = /방금 완료/.test(out.maintStatus) && !q('#consent').checked && q('#btn-maint').disabled;
  // FB-04
  out.re0 = q('#re-go').disabled+' '+q('#re-go').textContent; ok.re0Disabled = q('#re-go').disabled;
  q('#re-t98').click(); await wait(); ok.re1Enabled = !q('#re-go').disabled; q('#re-go').click(); await wait();
  out.reAfter = q('#re-badge').textContent+' | '+toastT(); ok.reApplied = /재분석됨/.test(out.reAfter) && q('#re-go').disabled;
  // FB-02 del-items with 0 candidates via direct open
  window.suiteOpen('dlg-del-items'); await wait(100);
  out.del0 = q('#di-t').innerText+' | btn='+q('#cand-done').disabled; ok.del0Blocked = q('#cand-done').disabled && /없습니다/.test(q('#di-t').innerText);
  window.suiteClose('dlg-del-items');
  // add candidate & delete -> marked deleted
  window.suiteGo('vault'); await wait();
  var ci = q('[data-cand-item="T146 · 응답 #841 (chunk 2/2)"]'); ci.click(); await wait();
  q('#cand-apply').click(); await wait(120);
  out.del1 = q('#di-t').innerText+' | btn='+q('#cand-done').disabled; ok.del1Opens = !q('#cand-done').disabled && /1개/.test(out.del1);
  q('#cand-done').click(); await wait(150);
  out.afterDel = ci.textContent+' disabled='+ci.disabled+' | '+toastT(); ok.deletedMarked = ci.disabled && /삭제됨/.test(ci.textContent);
  // FB-12 categories
  qa('[data-subpanel=resp] [data-select-row]')[1].click(); await wait();
  out.cat = qa('[data-subpanel=resp] [data-detail]').map(function(d){return d.dataset.detail+':'+(d.hidden?'h':'v')}).join(','); ok.catSwitch = out.cat==='a:h,b:v,c:h';
  // FB-10 log clear
  window.suiteGo('log'); await wait(); q('#log-clear').click(); await wait();
  ok.logCleared = q('#nav-log-n').textContent==='0';
  // FB-09 embedding off
  window.suiteGo('connect'); await wait();
  q('#emb-on').click(); await wait(); bar().querySelector('[data-save]').click(); await wait(150);
  out.embOff = q('#emb-badge').textContent+' | '+q('#foot-meta').textContent+' | lab='+q('#lab-model').textContent; ok.embOff = /꺼짐/.test(q('#emb-badge').textContent);
  q('#emb-on').click(); await wait(); bar().querySelector('[data-save]').click(); await wait(150);
  // key delete
  window.suiteOpen('dlg-key-del'); await wait(); q('#dlg-key-del [data-act=key-del]').click(); await wait(150);
  out.keyDel = q('#emb-badge').textContent+' | ph='+q('#emb-key').placeholder; ok.keyNone = /키 없음/.test(q('#emb-badge').textContent);
  q('#btn-emb-test').click(); await wait(); out.testNoKey = toastT(); ok.testFailsNoKey = /실패/.test(out.testNoKey);
  // enter key, test, save -> connected
  var k=q('#emb-key'); k.value='sk-test'; fire(k); await wait();
  q('#btn-emb-test').click(); await wait(); bar().querySelector('[data-save]').click(); await wait(200);
  out.keySaved = q('#emb-badge').textContent+' | val='+k.value+' | bar='+bar().querySelector('[data-save-title]').textContent; ok.keySavedOk = /연결 확인됨/.test(q('#emb-badge').textContent) && k.value==='' && /저장되어/.test(out.keySaved);
  // FB-05 ML
  out.ml0 = q('#ml-state').textContent;
  q('#ml-run').click(); await wait(300); ok.mlStopEnabled = !q('#ml-stop').disabled; await wait(4300); window.suiteClose('job-ml'); await wait(500);
  out.ml1 = q('#ml-state').textContent; ok.mlDone = /확인됨/.test(out.ml1);
  var md=q('#emb-model'); md.value='text-embedding-3-large'; fire(md); bar().querySelector('[data-save]').click(); await wait(200);
  out.ml2 = q('#ml-state').textContent; ok.mlExpired = /만료/.test(out.ml2);
  out.lab = q('#lab-model').textContent; ok.labModel = /large/.test(out.lab);
  // FB-06 defaults
  q('[data-load-defaults]').click(); await wait(150);
  out.defaults = md.value+' | '+toastT(); ok.defaultsModel = md.value==='text-embedding-3-small';
  // FB-08 readonly
  q('[data-page=connect] [data-subtab=srv]').click(); await wait();
  var srv = qa('[data-subpanel=srv] .choice')[1]; srv.click(); await wait(); ok.srvReadonly = !srv.classList.contains('is-on');
  // FB-S3 restore typed
  window.suiteOpen('dlg-restore'); await wait(); ok.restoreLocked = q('#btn-fb-restore').disabled; window.suiteClose('dlg-restore');
  out.ok=ok; out.failed=Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
