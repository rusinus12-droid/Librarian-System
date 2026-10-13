(async function(){
  var out = [];
  function q(s,r){ return (r||document).querySelector(s); }
  function qa(s,r){ return [].slice.call((r||document).querySelectorAll(s)); }
  function fire(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  function wait(ms){ return new Promise(function(r){setTimeout(r,ms)}); }
  async function finish(id){
    var ov = document.getElementById(id);
    for (var t=0;t<14 && ov.dataset.state!=='done';t++) await wait(700);
    var res = qa('[data-job-result]', ov).filter(function(r){return !r.hidden}).length;
    out.push(id+': state='+ov.dataset.state+' doneBtns='+qa('[data-job-done]',ov).filter(function(b){return !b.hidden}).length+' resultsShown='+res+' msg='+((ov.querySelector('[data-job-msg]')||{}).textContent||'').slice(0,30));
    window.suiteClose(id);
  }
  if (document.getElementById('range-go')) {
    window.suiteGo('memory'); await wait(80);
    var rb = qa('[data-open=dlg-range]').filter(function(b){return b.dataset.ctx && b.dataset.ctx.indexOf('T106')>-1})[0]; rb.click(); await wait(100);
    q('#range-go').click(); await finish('job-memory');
  } else {
    var map = {'btn-del':'dlg-del','btn-restore':'dlg-restore','btn-reset':'dlg-reset'};
    for (var b in map) {
      var op = qa('[data-open="'+map[b]+'"]')[0]; op.click(); await wait(100);
      var ov = document.getElementById(map[b]); var ti = q('[data-typed]', ov); ti.value = ti.dataset.typed; fire(ti); await wait(60);
      var go = document.getElementById(b); out.push(b+' enabled='+!go.disabled);
      go.click(); await wait(150);
      var jid = go.dataset.runJob || (go.closest('[data-run-job]')||{dataset:{}}).dataset.runJob;
      await finish(jid);
    }
  }
  return JSON.stringify(out);
})()
