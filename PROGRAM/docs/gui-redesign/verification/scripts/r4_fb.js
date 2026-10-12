(async function(){
  var out = {}, ok = {};
  function q(s,r){ return (r||document).querySelector(s); }
  function qa(s,r){ return [].slice.call((r||document).querySelectorAll(s)); }
  function fire(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  function wait(ms){ return new Promise(function(r){setTimeout(r,ms||80)}); }
  function bar(){ return qa('.savebar').filter(function(b){return b.offsetParent!==null})[0]; }
  function st(){ return q('#emb-badge').textContent + ' // ' + q('#foot-meta').textContent; }
  function openOv(){ var o=qa('.overlay.is-open'); return o.length?o[o.length-1].id:'none'; }
  function lastToast(){ var t=qa('.toast'); return t.length?t[t.length-1].textContent:''; }

  /* Endpoint 변경 */
  window.suiteGo('connect'); await wait();
  out.init = st();
  var url = q('#emb-url'); url.value = 'https://emb.example.net/v1'; fire(url); await wait();
  out.urlDirty = st();
  bar().querySelector('[data-save]').click(); await wait();
  out.urlSaved = st();
  ok.urlNeedsTest = /연결 테스트 필요/.test(q('#emb-badge').textContent);
  q('#btn-emb-test').click(); await wait();
  out.testToast = lastToast(); out.afterTest = st();
  ok.testClears = /연결 확인됨/.test(q('#emb-badge').textContent);
  // 고급: 정확한 Endpoint
  var ep = qa('label').filter(function(l){return /정확한 Endpoint/.test(l.textContent)})[0].parentElement.querySelector('input');
  ep.value = 'https://emb.example.net/v1/embeddings'; fire(ep); await wait();
  bar().querySelector('[data-save]').click(); await wait();
  out.exactSaved = st();
  ok.exactEndpointNeedsTest = /연결 테스트 필요/.test(q('#emb-badge').textContent);
  // 원래 조합으로 되돌려 저장 → 이전에 확인된 조합이면 확인됨
  ep.value = ''; fire(ep); await wait(); bar().querySelector('[data-save]').click(); await wait();
  out.backToTested = st();
  ok.knownComboOk = /연결 확인됨/.test(q('#emb-badge').textContent);

  /* 선택 0개 삭제 경로 */
  window.suiteGo('lab'); await wait();
  qa('.sc-sel:checked').forEach(function(c){ c.checked=false; fire(c); }); await wait();
  out.selCount = qa('.sc-sel:checked').length + ' sc-del disabled=' + q('#sc-del').disabled;
  q('[data-proxy="sc-del"]').click(); await wait();
  out.proxy0 = 'open=' + openOv() + ' page=' + q('.page.is-active').dataset.page + ' toast=' + lastToast();
  ok.proxyBlocked = openOv()==='none';
  // 다른 경로로 열려도(?open= 등) 선택 0이면 실행 불가
  window.suiteOpen('dlg-del-scope'); await wait();
  out.direct0 = q('#ds-t').innerText + ' / go disabled=' + q('#ds-go').disabled + ' / empty shown=' + !q('#ds-empty').hidden;
  ok.directBlocked = q('#ds-go').disabled && !q('#ds-empty').hidden && /선택하지 않았습니다/.test(q('#ds-t').innerText);
  window.suiteClose('dlg-del-scope');
  // 선택 2개 → 열기
  var sel = qa('.sc-sel').filter(function(c){return !c.disabled}).slice(0,2); sel.forEach(function(c){ c.checked=true; fire(c); }); await wait();
  q('[data-proxy="sc-del"]').click(); await wait();
  out.proxy2 = openOv() + ' / ' + q('#ds-t').innerText + ' / ' + q('#dlg-del-scope [data-fill="name"]').textContent + ' / go disabled=' + q('#ds-go').disabled;
  ok.proxy2Opens = openOv()==='dlg-del-scope' && /2개/.test(q('#ds-t').innerText) && !q('#ds-go').disabled;
  window.suiteClose('dlg-del-scope');
  out.ok = ok; out.failed = Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
