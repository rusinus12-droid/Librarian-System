(async function(){
  var out = [];
  function qa(s,r){ return [].slice.call((r||document).querySelectorAll(s)); }
  function wait(ms){ return new Promise(function(r){setTimeout(r,ms)}); }
  var ovs = qa('.overlay[id^="job-"]');
  for (var i=0;i<ovs.length;i++){
    var ov = ovs[i], id = ov.id;
    var btns = qa('[data-run-job="'+id+'"]');
    if (!btns.length) { out.push(id+': NO-OPENER'); continue; }
    btns[0].click(); await wait(150);
    var steps = qa('.step', ov).filter(function(s){return !s.closest('[hidden]')}).length;
    var labels = (ov.dataset.jobLabels||'').split('|').length;
    var total = steps || Math.max(labels-1,1);
    await wait((total+1)*1100 + 400);
    var done = ov.dataset.state==='done';
    var doneBtns = qa('[data-job-done]', ov).filter(function(b){return !b.hidden}).length;
    var cancelVisible = qa('[data-job-cancel]', ov).filter(function(b){return !b.hidden}).length;
    var stepsDone = qa('.step.is-done', ov).length;
    var msg = (ov.querySelector('[data-job-msg]')||{}).textContent || '';
    out.push(id+': '+(done?'done':'NOT-DONE:'+ov.dataset.state)+' steps='+stepsDone+'/'+steps+' doneBtns='+doneBtns+' cancelVisible='+cancelVisible+' msg='+msg.slice(0,28));
    window.suiteClose(id);
  }
  return JSON.stringify(out);
})()
