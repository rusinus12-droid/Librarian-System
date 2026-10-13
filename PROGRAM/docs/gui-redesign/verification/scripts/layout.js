/* 모든 화면의 가로 넘침 검사 (?device= 폭). 의도된 가로 스크롤 영역(탭, 노선도, 표)은 제외 */
(async function(){
  function wait(ms){return new Promise(function(r){setTimeout(r,ms)});}
  var ok={},out={};
  /* 조상 중 가로 스크롤 컨테이너(overflow-x:auto|scroll) 안에 있으면 의도된 스크롤 영역 */
  function inScroller(e,root){for(var p=e.parentElement;p&&p!==root;p=p.parentElement){var x=getComputedStyle(p).overflowX;if(x==='auto'||x==='scroll')return true;}return false;}
  var pages=[].slice.call(document.querySelectorAll('.page')).map(function(p){return p.dataset.page;});
  for(var i=0;i<pages.length;i++){
    window.suiteGo(pages[i]); await wait(150);
    var pg=document.querySelector('.page.is-active'),pb=document.querySelector('.page-body'),r=pb.getBoundingClientRect().right;
    var bad=[].slice.call(pg.querySelectorAll('*')).filter(function(e){var b=e.getBoundingClientRect();return b.width>0&&b.right>r+1&&!inScroller(e,pg);}).slice(0,3).map(function(e){return e.tagName+'.'+e.className;});
    out[pages[i]]={sw:pb.scrollWidth,w:pb.clientWidth,bad:bad};ok[pages[i]]=pb.scrollWidth<=pb.clientWidth&&!bad.length;
  }
  out.ok=ok;out.failed=Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
