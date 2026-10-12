(function(){
  var out = {};
  function q(s){ return document.querySelector(s); }
  function qa(s){ return [].slice.call(document.querySelectorAll(s)); }
  function fire(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  function vals(){ return qa('[data-preset-field="perf"]').map(function(i){return i.value}).join('/'); }
  function label(){ return q('[data-preset-label="perf"]').textContent; }
  function on(){ return qa('[data-preset-group="perf"] .choice').map(function(c){return c.classList.contains('is-on')?'1':'0'}).join(''); }
  function sb(){ var b = q('#savebar-settings [data-save-title]'); return b ? b.textContent : 'nosavebar'; }
  window.suiteGo('settings'); q('[data-subtab=mem]') && q('[data-subtab=mem]').click();
  var d = q('[data-preset-field="perf"]').closest('details'); if (d) d.open = true;
  out.init = { vals: vals(), label: label(), on: on(), save: sb() };
  // 가벼운 클릭
  var ch = qa('[data-preset-group="perf"] .choice');
  ch[0].click();
  out.light = { vals: vals(), label: label(), on: on(), save: sb() };
  // 세부 값 직접 변경 -> 직접 조정
  var f = q('[data-preset-field="perf"][data-preset-key="rerank"]'); f.value = '50'; fire(f);
  out.manual = { vals: vals(), label: label(), on: on(), save: sb() };
  // 무거운
  ch[2].click();
  out.heavy = { vals: vals(), label: label(), on: on(), save: sb() };
  // 되돌리기
  var rv = q('#savebar-settings [data-revert]'); rv.click();
  out.revert = { vals: vals(), label: label(), on: on(), save: sb() };
  // 직접 값을 프리셋값과 일치하게 -> 프리셋 선택 복원
  ch[0].click(); f.value='48'; fire(f);
  var m = q('[data-preset-field="perf"][data-preset-key="max"]'); m.value='12'; fire(m);
  var dn = q('[data-preset-field="perf"][data-preset-key="dense"]'); dn.value='0.42'; fire(dn);
  var sp = q('[data-preset-field="perf"][data-preset-key="sparse"]'); sp.value='0.18'; fire(sp);
  out.backToMid = { vals: vals(), label: label(), on: on(), save: sb() };
  // 저장 후 기준값
  ch[2].click(); out.pre = sb();
  q('#savebar-settings [data-save]').click();
  out.saved = { vals: vals(), label: label(), on: on(), save: sb() };
  ch[0].click(); q('#savebar-settings [data-revert]').click();
  out.afterRevertToSaved = { vals: vals(), label: label(), on: on(), save: sb() };
  var ok={};
  ok.init=out.init.label==='적당한'&&/저장되어/.test(out.init.save);
  ok.lightApplies=out.light.vals==='6/24/0.50/0.25'&&out.light.label==='가벼운';
  ok.manualDetaches=out.manual.label==='직접 조정'&&out.manual.on==='000';
  ok.oneChange=/1개 변경/.test(out.heavy.save);
  ok.revert=out.revert.vals==='12/48/0.42/0.18'&&/저장되어/.test(out.revert.save);
  ok.rematch=out.backToMid.label==='적당한';
  ok.saved=out.saved.label==='무거운'&&/저장되어/.test(out.saved.save);
  out.ok=ok;out.failed=Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
