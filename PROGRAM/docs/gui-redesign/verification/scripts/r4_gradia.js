(async function(){
  var out = {}, ok = {};
  function q(s,r){ return (r||document).querySelector(s); }
  function qa(s,r){ return [].slice.call((r||document).querySelectorAll(s)); }
  function fire(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  function wait(ms){ return new Promise(function(r){setTimeout(r,ms||80)}); }
  function bar(){ return qa('.savebar').filter(function(b){return b.offsetParent!==null})[0]; }
  function stitle(){ var b=bar(); return b ? b.querySelector('[data-save-title]').textContent : 'nobar'; }
  window.suiteGo('manage'); await wait();
  out.start = stitle();
  // 새 Skill 추가
  var addBtn = qa('[data-open="dlg-skill"]').filter(function(b){ return b.dataset.ctx && /"variant": ?"new"/.test(b.dataset.ctx); })[0];
  out.addBtn = addBtn ? addBtn.textContent.trim() : 'NONE';
  addBtn.click(); await wait();
  q('#sk-name').value = '새 테스트 Skill'; fire(q('#sk-name')); q('#sk-body').value = '본문'; fire(q('#sk-body')); await wait();
  q('#sk-save-c').click(); await wait(120);
  var row = qa('.skill-row').filter(function(r){return r.textContent.indexOf('새 테스트 Skill')>-1})[0];
  out.rowAdded = !!row; out.afterAdd = stitle();
  // G2 GR-S3: product Skill edits are a draft until the shared savebar commits.
  ok.addIsDraft = /1개 변경/.test(stitle());
  bar().querySelector('[data-save]').click(); await wait();
  ok.addSaved = /저장되어/.test(stitle());
  // 처음 끄기 → 1개 변경
  var sw = row.querySelector('input[type=checkbox]'); sw.click(); await wait();
  out.firstOff = 'checked=' + sw.checked + ' / ' + stitle();
  ok.firstToggleCounts = !sw.checked && /1개 변경/.test(stitle());
  // 되돌리기 → 다시 켜짐
  bar().querySelector('[data-revert]').click(); await wait();
  // Revert reconstructs rows; read the current control, not the detached old node.
  row = qa('.skill-row').filter(function(r){return r.textContent.indexOf('새 테스트 Skill')>-1})[0];
  sw = row.querySelector('input[type=checkbox]');
  out.reverted = 'checked=' + sw.checked + ' / ' + stitle();
  ok.revertRestoresOn = sw.checked && /저장되어/.test(stitle());
  // 끄고 저장 → 다시 켜면 변경
  sw.click(); await wait(); bar().querySelector('[data-save]').click(); await wait();
  out.savedOff = 'checked=' + sw.checked + ' / ' + stitle();
  sw.click(); await wait();
  out.onAgain = 'checked=' + sw.checked + ' / ' + stitle();
  ok.saveRebases = sw.checked && /1개 변경/.test(stitle());
  out.ok = ok; out.failed = Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
