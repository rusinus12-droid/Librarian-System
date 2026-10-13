(async function(){
  function qa(s,r){return [].slice.call((r||document).querySelectorAll(s));}
  function wait(ms){return new Promise(function(r){setTimeout(r,ms)});}
  var bad=[], checked=0, errs=[];
  window.addEventListener('error',function(e){errs.push(String(e.message));});
  var ovs = qa('.overlay').filter(function(o){return o.id!=='sheet-more';});
  for (var i=0;i<ovs.length;i++){
    var ov = ovs[i];
    qa('.overlay.is-open').forEach(function(o){window.suiteClose(o.id);});
    window.suiteOpen(ov.id); await wait(60);
    var btns = qa('button', ov).filter(function(b){ return !b.disabled && (b.dataset.toast || b.dataset.act || b.dataset.runJob) && !b.hasAttribute('data-job-cancel') && b.offsetParent!==null; });
    for (var j=0;j<btns.length;j++){
      var before = qa('.toast').length;
      try { btns[j].click(); } catch(e){ errs.push(ov.id+':'+e.message); }
      await wait(40); checked++;
      qa('.toast').slice(before).forEach(function(t){ if (/\{\w+\}/.test(t.textContent)) bad.push(ov.id+' → '+t.textContent.slice(0,60)); });
      if (!ov.classList.contains('is-open')) { window.suiteOpen(ov.id); await wait(40); }
    }
  }
  qa('.overlay.is-open').forEach(function(o){window.suiteClose(o.id);});
  return JSON.stringify({overlays:ovs.length, clicks:checked, rawPlaceholders:bad, errors:errs.slice(0,5)});
})()
