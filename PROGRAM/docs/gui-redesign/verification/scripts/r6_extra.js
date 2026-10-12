/* 자체 감사 항목 중 자동 확인이 없던 수정의 확인. 화면은 파일 이름으로 고른다 */
(async function(){
  var out={},ok={};
  function q(s,r){return (r||document).querySelector(s);} function qa(s,r){return [].slice.call((r||document).querySelectorAll(s));}
  function fire(el){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
  function wait(ms){return new Promise(function(r){setTimeout(r,ms||90)});}
  function toastT(){var t=qa('.toast');return t.length?t[t.length-1].textContent:'';}
  function btn(root,txt){return qa('button',root).filter(function(b){return b.textContent.indexOf(txt)>-1})[0];}
  var page=location.pathname.split('/').pop();
  if(page==='lia.html'){
    function shelfRow(n){return qa('#shelf-list .row').filter(function(r){return r.textContent.indexOf(n)>-1})[0];}
    // LIA-19 버전 조사
    window.suiteGo('shelf'); await wait(); shelfRow('세라 하운').click(); await wait(150);
    q('#edit-root [data-subtab=ver]').click(); await wait(); qa('#ver-list button')[0].click(); await wait();
    out['LIA-19']=toastT(); ok['LIA-19']=/v3을 열었습니다/.test(out['LIA-19']);
    // LIA-15 잠금만 저장 → 채택 최신 유지
    window.suiteGo('shelf'); await wait(); shelfRow('이름 없는 길손').click(); await wait(150);
    q('[data-lock="age"]').click(); await wait(); q('#savebar [data-save]').click(); await wait(150);
    out['LIA-15']=q('#btn-adopt').textContent+' disabled='+q('#btn-adopt').disabled; ok['LIA-15']=/최신/.test(out['LIA-15'])&&q('#btn-adopt').disabled;
    // LIA-17 연결한 Persona의 현재 상태
    q('#edit-root [data-subtab=out]').click(); await wait(); q('#btn-bind').click(); await wait(120); q('#btn-bind-go').click(); await wait(150);
    window.suiteGo('shelf'); await wait(); shelfRow('이름 없는 길손').click(); await wait(150);
    out['LIA-17']=q('#edit-root [data-fill=liveLoc]').textContent; ok['LIA-17']=out['LIA-17']!=='북쪽 정원';
    // LIA-07 대상 Persona 정리 → 에셋 대상 select가 비지 않음
    window.suiteGo('assets'); await wait(); var at=q('#asset-target'); var o=qa('option',at).filter(function(x){return /길손/.test(x.textContent)})[0]; at.value=o.value; fire(at); await wait();
    window.suiteGo('shelf'); await wait(); shelfRow('이름 없는 길손').click(); await wait(150); q('#edit-root [data-subtab=out]').click(); await wait();
    q('#btn-del-persona').click(); await wait(120); btn(q('#sheet-del-persona .dialog__actions'),'Persona 정리').click(); await wait(150);
    window.suiteGo('assets'); await wait(); out['LIA-07']='index='+at.selectedIndex+' value='+at.value; ok['LIA-07']=at.selectedIndex===0;
    // LIA-10 묶음 폐기 → 대상 Persona의 감정 수 0
    window.suiteGo('assets'); await wait(); at.value='sera'; fire(at); await wait();
    q('[data-open="sheet-bundle-del"]').click(); await wait(120); btn(q('#sheet-bundle-del .dialog__actions'),'폐기').click(); await wait(120);
    out['LIA-10b']=q('#as-n').textContent+' | lock='+q('#as-lock').textContent; ok['LIA-10b']=/^0 \//.test(q('#as-n').textContent)&&q('#as-lock').textContent==='미확정';
    // LIA-16 에셋 화면의 미저장 변경 → '내 페르소나' 메뉴 표시
    var memo=qa('[data-page=assets] textarea').filter(function(t){return t.id!=='emo-list'})[0]; memo.value=memo.value+' 수정'; fire(memo); await wait();
    window.suiteGo('shelf'); await wait(); out['LIA-16b']=q('.nav-item[data-go=mine]').classList.contains('is-unsaved'); ok['LIA-16b']=out['LIA-16b']===true;
  }
  if(page==='libra.html'){
    // LIB-05(설정 실행 기록) 전체 기록으로 열림
    window.suiteGo('settings'); await wait(); q('[data-subtab=adv]').click(); await wait();
    qa('[data-page=settings] [data-open=drawer-versions]')[0].click(); await wait(120);
    out['LIB-05b']=q('#dv-t').textContent+' | verRows hidden='+q('#ver-rows').hidden+' runs='+qa('#run-rows .res-row').length; ok['LIB-05b']=/전체/.test(out['LIB-05b'])&&q('#ver-rows').hidden&&qa('#run-rows .res-row').length>=5;
    window.suiteClose('drawer-versions');
    // LIB-13 빈 교정 금지 · 목록 추가
    window.suiteGo('people'); await wait(); var n0=qa('#corr-list .row').length;
    btn(q('[data-page=people] [data-detail=p0]'),'교정').click(); await wait(120); var go=q('#co-go'); var d0=go.disabled;
    var ta=q('#co-in'); ta.value=ta.value+'신뢰가 한 단계 낮아짐'; fire(ta); await wait(); var d1=go.disabled; go.click(); await wait(120);
    out['LIB-13']='empty disabled='+d0+' filled disabled='+d1+' rows '+n0+'->'+qa('#corr-list .row').length; ok['LIB-13']=d0&&!d1&&qa('#corr-list .row').length===n0+1;
    // LIB-20 인물 검색
    var ps=q('[data-page=people] .rail__search input'); ps.value='정원사'; fire(ps); await wait();
    out['LIB-20b']=qa('[data-page=people] .chapter').filter(function(c){return !c.hidden}).length; ok['LIB-20b']=out['LIB-20b']===1; ps.value=''; fire(ps);
    // LIB-17 AI 프리셋 사용·삭제(두 번 눌러 확인)
    window.suiteGo('settings'); await wait(); q('[data-subtab=ai]').click(); await wait();
    q('[data-ai-use=gpt]').click(); await wait(); var useT=q('#ai-presets').textContent;
    var del=q('[data-ai-del=claude]'); del.click(); await wait(); var still=qa('#ai-presets .row').length; q('[data-ai-del=claude]').click(); await wait();
    out['LIB-17']='inUse='+/GPT-4.1 mini 사용 중/.test(useT)+' afterFirstClick='+still+' afterSecond='+qa('#ai-presets .row').length; ok['LIB-17']=/GPT-4.1 mini 사용 중/.test(useT)&&still===2&&qa('#ai-presets .row').length===1;
    // LIB-18 전달 문구 = 저장된 설정
    q('[data-subtab=mem]').click(); await wait();
    var sw=qa('[data-page=settings] .setting').filter(function(r){return /사서 모드에도 최근 대화 직접 주입/.test(r.textContent)})[0].querySelector('input'); sw.click(); await wait();
    var before=q('#foot-delivery').textContent; q('#savebar-settings [data-save]').click(); await wait(120);
    out['LIB-18']=before+' -> '+q('#foot-delivery').textContent; ok['LIB-18']=!/최근 대화/.test(before)&&/최근 대화 8턴/.test(q('#foot-delivery').textContent);
    // LIB-21 닫힌 빠른 설정 서랍의 미저장 표시
    window.suiteOpen('drawer-quick'); await wait(); var inp=qa('#drawer-quick input[type=checkbox]').filter(function(c){return !c.dataset.sync})[0]; inp.click(); await wait(); window.suiteClose('drawer-quick'); await wait();
    out['LIB-21']=qa('[data-open=drawer-quick]').filter(function(b){return !b.closest('.overlay')}).map(function(b){return b.classList.contains('is-unsaved')}).join(); ok['LIB-21']=/true/.test(out['LIB-21']);
    // LIB-16 복원 방식 '다음'은 결과를 주장하지 않음
    window.suiteOpen('dlg-restore-mode'); await wait(); btn(q('#dlg-restore-mode .dialog__actions'),'다음').click(); await wait();
    out['LIB-16']=toastT(); ok['LIB-16']=/바뀌지 않았습니다/.test(out['LIB-16']);
    // S-LIB-1 열람대 전달 근거 = 리콜 3개
    window.suiteGo('desk'); await wait(); btn(q('[data-page=desk]'),'전달 근거 보기').click(); await wait(120);
    out['S-LIB-1']=qa('#ev-cites .anno__kicker').map(function(k){return k.textContent}).join(','); ok['S-LIB-1']=/M-25/.test(out['S-LIB-1'])&&/M-23/.test(out['S-LIB-1'])&&qa('#ev-cites .anno').length===3;
    window.suiteClose('drawer-evidence');
  }
  if(page==='hayaku.html'){
    // HY-S1 후보 채택은 한 번만
    q('button[data-scenario=warn]').click(); await wait(); window.suiteGo('recovery'); await wait(); q('[data-page=recovery] [data-subtab=failed]').click(); await wait();
    q('#adopt-132').click(); await wait(); out['HY-S1']='disabled='+q('#adopt-132').disabled; ok['HY-S1']=q('#adopt-132').disabled;
    // S-03 진행 중 작업 재시작 안 함
    window.suiteGo('packets'); await wait(); var rg=qa('[data-open=dlg-regen]'); rg[0].click(); await wait(100); q('#dlg-regen [data-run-job]').click(); await wait(200);
    var t1=q('#jg-t').textContent; window.suiteClose('job-regen'); rg[1].click(); await wait(100); q('#dlg-regen [data-run-job]').click(); await wait(200);
    out['S-03']=t1+' -> '+q('#jg-t').textContent+' | '+toastT(); ok['S-03']=t1===q('#jg-t').textContent&&/진행 중인 작업/.test(toastT());
    window.suiteClose('job-regen');
    // HY-07 기본값 불러오기 (단독)
    window.suiteGo('settings'); await wait(); q('[data-subtab=basic]').click(); await wait();
    var en=qa('[data-subpanel=basic] input[type=checkbox]')[0]; en.click(); await wait();
    qa('[data-page=settings] [data-load-defaults]').filter(function(b){return b.closest('[data-subpanel=basic]')})[0].click(); await wait();
    out['HY-07']='checked='+en.checked+' | '+q('#savebar-hy [data-save-title]').textContent; ok['HY-07']=en.checked===true&&/저장되어/.test(out['HY-07']);
  }
  if(page==='gradia.html'&&location.search.indexOf('mode=rp')<0){
    // GR-S1 키 삭제는 두 번 눌러 확인
    window.suiteGo('providers'); await wait(); var kd=q('[data-prov-keydel=p1]'); kd.click(); await wait();
    var after1=q('[data-select-row=p1] .badge').textContent; kd.click(); await wait();
    out['GR-S1']=after1+' -> '+q('[data-select-row=p1] .badge').textContent; ok['GR-S1']=after1==='완료'&&q('[data-select-row=p1] .badge').textContent==='키 필요';
  }
  if(page==='gradia.html'&&location.search.indexOf('mode=rp')>-1){
    // GR-10 ?mode=rp 로 열면 그 모드가 저장된 값: 숨은 변경 없음, 되돌려도 RP 유지
    var b0=q('#savebar [data-save-title]').textContent; qa('#q-weight .choice')[1].click(); await wait(150); var b1=q('#savebar [data-save-title]').textContent;
    q('#savebar [data-revert]').click(); await wait(150);
    out['GR-10']=b0+' | '+b1+' | mode='+document.documentElement.dataset.writing; ok['GR-10']=/저장되어/.test(b0)&&/1개 변경/.test(b1)&&document.documentElement.dataset.writing==='rp';
  }
  if(page==='flashback.html'){
    out['FB-S2']=q('[data-page=settings] .card__desc').textContent; ok['FB-S2']=!/4개 값/.test(document.body.textContent)&&!/외 7개/.test(document.body.textContent);
  }
  out.ok=ok; out.failed=Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
