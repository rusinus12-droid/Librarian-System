'use strict';
// Full deployed UI and actual analysis/commit; controlled RisuAI and model response.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {artifact}=require('../fixtures/libra_unified_runtime_fixture.cjs');
const input=require('../fixtures/unified_vertical_source.json');
const program=path.resolve(__dirname,'../..');
const output=path.resolve(process.argv[2]||path.join(program,'../../review_artifacts/libra_character_profile_20260909/browser'));
const results=[],errors=[];
const check=(name,value)=>{assert.ok(value,name);results.push(name);};
(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({executablePath:(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'),headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1100}});
    page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
    await page.route('http://localhost/libra-synthetic-host',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><body></body></html>'}));await page.goto('http://localhost/libra-synthetic-host');await page.setContent('<html lang="ko"><body></body></html>');
    await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
    const a=artifact(), rows=structuredClone(input.sourceRows);
    for(const [kind,field,value] of [
      ['character_appearance','appearance',['짙은 갈색 눈']],['character_background','background',['해안 마을에서 자람']],
      ['character_personality','personality',['꾸준하고 신중함']],['character_speech','speech',['상대에게 존댓말을 사용함']],
      ['character_habit','habits',['매일 여행 일지를 씀']],['character_ability','abilities',['배의 항로를 계산할 수 있음']],
      ['character_goal','goal','등대에 지도 전달'],['character_state','condition','긴 여행을 마치고 휴식 중']
    ]){
      const text=`민아의 ${field}: ${Array.isArray(value)?value.join(', '):value}.`;
      rows.find(r=>r.ref==='t5-a').text+=' '+text;
      const tempFactId='profile_'+a.facts.length;
      a.facts.push({tempFactId,domain:'character',subjectTempRef:'mina',claimKind:kind,values:{[field]:value},text,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t5-a',quote:text}]});
      a.stateBindings.push({factTempId:tempFactId});
    }
    await page.evaluate(({rows,a})=>{
      __writerHost.chat.message=rows.map(r=>({role:r.role,chatId:r.ref,data:r.text}));
      __writerHost.artifact=a;
      risuai.runLLMModel=async()=>{__writerHost.calls.model++;return {type:'success',result:JSON.stringify(__writerHost.artifact)};};
    },{rows,a});
    let source=fs.readFileSync(process.env.LIBRA_TEST_PLUGIN||path.join(program,'plugins/LIBRA.js'),'utf8');
    const needle='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';
    check('audit injection marker found',source.includes(needle));
    source=source.replace(needle,'  globalThis.__audit={Gui,LibraMemoryCore,bookNavigate,renderSettingsGui,worldManagerSnapshotView,buildApprovedMockupPeople};\n'+needle);
    await page.addScriptTag({content:source});await page.waitForFunction(()=>!!window.__LIBRA__);await page.evaluate(async()=>{const settings=await __LIBRA__.getLibraMemorySettings();await __LIBRA__.saveLibraMemorySettings({...settings,memoryEngine:'unified'});await __LIBRA__.saveLibraProviderConfig({enableLibrarian:true});});
    const job=await page.evaluate(async()=>await __LIBRA__.runManualColdStart());
    check('analysis committed',job.completed===1);
    await page.evaluate(async()=>await __LIBRA__.openSettingsGui());
    const jobDialog=page.locator('#job-memory[data-canonical-job-portal]');
    if(await jobDialog.count())await jobDialog.getByRole('button',{name:'닫기',exact:true}).click();
    await page.evaluate(()=>__audit.bookNavigate('people'));
    await page.locator('[data-subpanel="intro"]').waitFor();
    const profile=page.locator('.sheet-page');
    for(const key of ['appearance','background','personality','speech','habits','abilities','goal','condition','locationRef','knowledge'])
      check('visible '+key,await profile.locator(`[data-character-field="${key}"]`).count()===1);
    check('no obsolete missing-summary notice',!(await profile.innerText()).includes('별도 소개 요약은'));
    await profile.locator('[data-subtab="now"]').click();check('current tab uses actual condition and goal',/휴식 중/.test(await profile.locator('[data-subpanel="now"]').innerText())&&/지도 전달/.test(await profile.locator('[data-subpanel="now"]').innerText()));
    check('reference is resolved to place name',/서재/.test(await profile.locator('[data-character-field="locationRef"]').innerText()));
    check('empty affiliations group hidden',await profile.locator('[data-subpanel="own"] [data-character-field]').count()===0);
    for(const width of [1440,1024,390]){
      await page.setViewportSize({width,height:1100});
      await page.screenshot({path:path.join(output,`character-${width}.png`),fullPage:true});
      check('profile fits '+width,await profile.evaluate(n=>n.scrollWidth<=n.clientWidth+1));
      check('page fits '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
    const compatibility=await page.evaluate(()=>{
      const before=__audit.LibraMemoryCore.state.snapshot;
      try {
        const snapshot=structuredClone(before);
        snapshot.continuityState.characters=[{id:'legacy',name:'예전 인물',state:{summary:'기존 소개',appearance:'회색 눈',customNote:'기존 추가 정보'}}];
        __audit.LibraMemoryCore.state.snapshot=snapshot;
        const legacy=__audit.buildApprovedMockupPeople().textContent;
        snapshot.continuityState.characters=[{id:'identity',name:'이름만 확인된 인물',state:{}}];
        const identity=__audit.buildApprovedMockupPeople();
        return {legacy,emptyGroups:identity.querySelectorAll('[data-character-field]').length,emptyText:identity.textContent};
      } finally {__audit.LibraMemoryCore.state.snapshot=before;}
    });
    check('legacy scalar and extra fields remain readable',/기존 소개/.test(compatibility.legacy)&&/회색 눈/.test(compatibility.legacy)&&/기존 추가 정보/.test(compatibility.legacy));
    check('identity-only card has no empty profile warning',compatibility.emptyGroups===0&&!/별도 소개 요약/.test(compatibility.emptyText));
    check('view makes no additional model calls',await page.evaluate(()=>__writerHost.calls.model)===1);
    check('no uncaught browser errors',errors.length===0);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({results,errors,boundary:'Chromium full production plugin; controlled host/provider, not live RisuAI'},null,2));
  }
  console.log(JSON.stringify({test:'libra_character_profile_browser',passed:results.length,errors}));
})().catch(error=>{console.error(error);process.exitCode=1;});
