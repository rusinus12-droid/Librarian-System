(async function(){
  var out = {}, ok = {};
  function q(s,r){ return (r||document).querySelector(s); }
  function qa(s,r){ return [].slice.call((r||document).querySelectorAll(s)); }
  function fire(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  function wait(ms){ return new Promise(function(r){setTimeout(r,ms||80)}); }
  function bars(){ return qa('.savebar').filter(function(b){return b.offsetParent!==null}).map(function(b){return b.querySelector('[data-save-title]').textContent}).join('|'); }
  out.pages = qa('.page').map(function(p){return p.dataset.page}).join(',');
  var cold = q('#st-cold'); out.coldTag = cold.tagName + ':' + cold.value;
  // Cold Start 카드
  window.suiteGo('recovery'); await wait();
  var batch = q('#cold-batch'); out.batchTag = batch.tagName + ':' + batch.value + (batch.tagName==='SELECT'? ' opts=' + qa('option',batch).map(function(o){return o.value}).join('/') : '');
  var optVals = batch.tagName==='SELECT' ? qa('option',batch).map(function(o){return o.value}) : [];
  var other = optVals.filter(function(v){return v!==batch.value})[0];
  if (other) { batch.value = other; fire(batch); await wait(); }
  q('#cold-go').click(); await wait(300);
  var ov = qa('.overlay.is-open').pop();
  var txt = ov ? ov.textContent.replace(/\s+/g,' ') : '';
  out.coldDialog = (ov?ov.id:'none') + ' :: ' + txt.slice(0,260);
  out.coldOther = other;
  ok.coldFollowsBatch = !!other && !!ov && txt.indexOf(other)>-1;
  // 5턴 고정 문구 잔존 여부 (선택값이 5가 아닐 때)
  if (other && other!=='5') ok.noFixed5 = !/5\s*턴/.test(txt);
  // 진행 중 문구
  await wait(1300);
  var ov2 = qa('.overlay.is-open').pop(); out.coldRunning = ov2 ? ov2.textContent.replace(/\s+/g,' ').slice(0,220) : 'none';
  qa('.overlay.is-open').forEach(function(o){ window.suiteClose(o.id); });
  // 설정에서 저장 전 변경 후 복구 화면 배지는 '저장된 값'을 따라야 한다
  window.suiteGo('settings'); await wait();
  var ab = q('#auto-after'), ag = q('#auto-bg');
  out.autoTags = [ab&&ab.type, ag&&ag.type];
  var beforeBadge = q('#st-after') ? 1 : 0;
  var tg = q('#st-after'); var was = tg.checked; tg.checked = !was; fire(tg); await wait();
  out.unsaved = bars();
  window.suiteGo('recovery'); await wait();
  var badgeUnsaved = (q('#auto-after') ? q('#auto-after').textContent : '').trim();
  window.suiteGo('settings'); await wait();
  qa('.savebar').filter(function(b){return b.offsetParent!==null})[0].querySelector('[data-save]').click(); await wait(100);
  window.suiteGo('recovery'); await wait();
  var badgeSaved = (q('#auto-after') ? q('#auto-after').textContent : '').trim();
  out.badge = { whileUnsaved: badgeUnsaved, afterSave: badgeSaved, toggled: !was };
  ok.badgeFollowsSaved = badgeUnsaved !== badgeSaved;
  out.ok = ok; out.failed = Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
