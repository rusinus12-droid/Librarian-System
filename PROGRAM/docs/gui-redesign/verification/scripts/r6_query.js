/* ?open= 진입 확인: 화면 데이터 준비 뒤 열림(COM-01), 대상 없는 작업·확인 생략 시작 차단(COM-03, 6차 검토 1·추가) */
(async function(){
  function q(s){return document.querySelector(s);} function wait(ms){return new Promise(function(r){setTimeout(r,ms)});}
  await wait(300);
  var page=location.pathname.split('/').pop(), open=new URLSearchParams(location.search).get('open'), key=page+'?open='+open, ok={}, out={};
  var st=function(id){var e=document.getElementById(id);return e?(e.dataset.state||'none'):'missing';};
  var notStarted=function(id){return st(id)!=='running'&&st(id)!=='done';};
  if(key==='lia.html?open=sheet-bind'){out.v=document.querySelectorAll('#bind-list [data-pid]').length;ok[key]=out.v===2;}
  else if(key==='lia.html?open=sheet-persona'){out.v=q('#spm-t').textContent;ok[key]=/선택 없음/.test(out.v)&&!q('#sheet-persona .require-note').hidden;}
  else if(key==='libra.html?open=dlg-range'){out.v=document.querySelectorAll('#seglist .segrow').length;ok[key]=q('#dlg-range').classList.contains('is-open')&&out.v===8;}
  else if(key==='hayaku.html?open=dlg-compare'){ok[key]=!q('#dlg-compare .require-note').hidden;}
  else if(key==='retrace.html?open=dlg-del'){ok[key]=q('#btn-del').disabled&&!q('#dlg-del .require-note').hidden;}
  else if(key==='gradia.html?open=dlg-skill'){ok[key]=q('#sk-save-b').disabled&&q('#sk-save-c').disabled;}
  else if(key==='flashback.html?open=dlg-del-items'){ok[key]=q('#cand-done').disabled;}
  else {var id=open;out.v=st(id);ok[key]=notStarted(id);}
  out.ok=ok; out.failed=Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
