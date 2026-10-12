(function(){
  var out = {};
  function qa(s,r){ return [].slice.call((r||document).querySelectorAll(s)); }
  // 중복 id
  var ids = {}, dups = [];
  qa('[id]').forEach(function(e){ if (ids[e.id]) dups.push(e.id); ids[e.id] = 1; });
  out.dupIds = dups;
  // 끊어진 참조
  var miss = [];
  ['data-open','data-then-open','data-run-job','data-typed-target','data-out','data-proxy'].forEach(function(a){
    qa('['+a+']').forEach(function(e){ var v=e.getAttribute(a); if (!document.getElementById(v)) miss.push(a+'='+v); });
  });
  ['data-go','data-then-go'].forEach(function(a){
    qa('['+a+']').forEach(function(e){ var v=e.getAttribute(a); if (!document.querySelector('.page[data-page="'+v+'"]')) miss.push(a+'='+v); });
  });
  qa('label[for]').forEach(function(l){ if(!document.getElementById(l.htmlFor)) miss.push('for='+l.htmlFor); });
  out.missingRefs = miss;
  // data-ctx JSON
  var badJson = [];
  ['data-ctx','data-preset'].forEach(function(a){ qa('['+a+']').forEach(function(e){ try { JSON.parse(e.getAttribute(a)); } catch(x){ badJson.push(a+':'+e.getAttribute(a).slice(0,40)); } }); });
  out.badJson = badJson;
  // 라벨 없는 컨트롤
  var unl = qa('input,select,textarea').filter(function(c){
    if (c.type==='hidden') return false;
    if (c.getAttribute('aria-label') || c.getAttribute('aria-labelledby')) return false;
    if (c.labels && c.labels.length && c.labels[0].textContent.trim()) return false;
    return true;
  }).map(function(c){ return c.tagName+'#'+(c.id||'')+'.'+c.className; });
  out.unlabeled = unl;
  // 이름 없는 버튼
  out.unnamedButtons = qa('button').filter(function(b){ return !(b.textContent.trim() || b.getAttribute('aria-label') || b.getAttribute('title')); }).map(function(b){return b.className}).slice(0,5);
  // data-sync 짝 확인
  var sy = {}; qa('[data-sync]').forEach(function(e){ sy[e.dataset.sync]=(sy[e.dataset.sync]||0)+1; });
  out.syncSingles = Object.keys(sy).filter(function(k){return sy[k]<2});
  // data-preset-field 그룹 존재
  out.presetOrphans = qa('[data-preset-field]').filter(function(f){ return !document.querySelector('[data-preset-group="'+f.dataset.presetField+'"]'); }).length;
  return JSON.stringify(out);
})()
