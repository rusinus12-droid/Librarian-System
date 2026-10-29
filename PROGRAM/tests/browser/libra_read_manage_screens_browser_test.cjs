'use strict';
// Read and manage are separate screens on people, world and almanac pages; the almanac has no margin form.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {artifact}=require('../fixtures/libra_unified_runtime_fixture.cjs');
const input=require('../fixtures/unified_vertical_source.json');
const program=path.resolve(__dirname,'../..');
const output=process.env.LIBRA_REVIEW_ARTIFACT_DIR||'';
const results=[],errors=[];
const check=(name,value)=>{assert.ok(value,name);results.push(name);};
(async()=>{
  const browser=await chromium.launch({executablePath:(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'),headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
    await page.route('http://localhost/libra-read-manage',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><body></body></html>'}));await page.goto('http://localhost/libra-read-manage');
    await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
    const a=artifact(),rows=structuredClone(input.sourceRows);
    await page.evaluate(({rows,a})=>{
      __writerHost.chat.message=rows.map(r=>({role:r.role,chatId:r.ref,data:r.text}));
      __writerHost.artifact=a;
      risuai.runLLMModel=async()=>{__writerHost.calls.model++;return {type:'success',result:JSON.stringify(__writerHost.artifact)};};
    },{rows,a});
    await page.addScriptTag({path:path.join(program,'plugins/LIBRA.js')});await page.waitForFunction(()=>!!window.__LIBRA__);
    await page.evaluate(async()=>{const settings=await __LIBRA__.getLibraMemorySettings();await __LIBRA__.saveLibraMemorySettings({...settings,memoryEngine:'unified'});await __LIBRA__.saveLibraProviderConfig({enableLibrarian:true});});
    check('analysis committed',(await page.evaluate(async()=>await __LIBRA__.runManualColdStart())).completed===1);
    await page.evaluate(async()=>await __LIBRA__.openSettingsGui());
    const jobDialog=page.locator('#job-memory[data-canonical-job-portal]');
    if(await jobDialog.count())await jobDialog.getByRole('button',{name:'닫기',exact:true}).click();
    const capture=async name=>{if(output){fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,name)});}};
    const open=async go=>{await page.locator(`.nav-item[data-go="${go}"]`).click();return page.locator(`.page[data-page="${go}"]`);};
    const mode=async(destination,value)=>{await destination.locator(`.page-head [data-val="${value}"]`).click();};

    for(const [go,reader] of [['people','[data-subtabs="people"]'],['world','#world-grid'],['story','[data-narrative-structure]']]){
      const destination=await open(go);
      await destination.locator(reader).first().waitFor();
      check(go+' read has no manage view',await destination.locator('.manage-view').count()===0);
      check(go+' read has no hidden management fold',await destination.locator('details[data-product-management]').count()===0);
      await capture(`${go}-read.png`);
      await mode(destination,'manage');
      const manage=destination.locator(`.manage-view[data-product-management="${go}"]`);await manage.waitFor();
      check(go+' manage replaces the reader',await destination.locator(reader).count()===0);
      check(go+' manage shows one record browser',await manage.locator('[data-world-domain-browser]').count()>=1);
      check(go+' manage toggle pressed',await destination.locator('.page-head [data-val="manage"]').getAttribute('aria-pressed')==='true');
      await capture(`${go}-manage.png`);
      await manage.getByRole('button',{name:'읽기로 돌아가기',exact:true}).click();
      await destination.locator(reader).first().waitFor();
      check(go+' back to read',await destination.locator('.manage-view').count()===0);
    }
    const story=page.locator('.page[data-page="story"]');
    check('margin form removed',await story.locator('#margin-form,[data-direction-field]').count()===0);
    check('margin heading removed',!(await story.innerText()).includes('사서의 여백'));
    check('almanac tabs kept',await story.locator('[data-subtabs="s"] [data-subtab]').count()===6);

    const people=await open('people');await mode(people,'manage');
    await people.locator('[data-people-management-page="relationships"]').click();
    await people.locator('[data-world-management-domain="relationships"],[data-world-manager-domain="relationships"]').first().waitFor();
    check('relationships manage page',await people.locator('.manage-view').count()===1);

    const memory=await open('memory');await memory.locator('[data-memory-reader-kind="micro"]').click();
    await memory.locator('[data-product-readback="micro-memory-reader"]').waitFor();
    check('micro reader offers no manage mode',await memory.locator('.page-head .page-actions').isHidden());
    await memory.locator('[data-memory-reader-kind="canonical"]').click();
    await mode(memory,'manage');await memory.locator('[data-product-memory-management]').waitFor();
    check('canonical manage hides kind tabs',await memory.locator('[data-memory-reader-kind]').count()===0);
    check('manage scope says canonical only',/관리 대상 · 정본 기억/.test(await memory.locator('[data-manage-scope="memory"]').innerText()));
    await mode(memory,'read');await memory.locator('[data-memory-reader-kind]').first().waitFor();
    check('read restores canonical kind',await memory.locator('[data-memory-reader-kind="canonical"]').getAttribute('aria-selected')==='true');

    // Navigate at desktop width (narrow layouts swap the sidebar for a tab bar), then narrow the same screen.
    for(const go of ['people','world','story']){
      await page.setViewportSize({width:1440,height:900});
      const destination=await open(go);await mode(destination,'manage');await destination.locator('.manage-view').waitFor();
      for(const width of [1024,390]){
        await page.setViewportSize({width,height:900});
        check(`${go} manage fits ${width}`,await page.evaluate(()=>[...document.querySelectorAll('.page-body')].every(n=>n.scrollWidth<=n.clientWidth+1)));
        if(width===390)await capture(`${go}-manage-${width}.png`);
      }
    }
    check('no page errors',errors.length===0);
    console.log(JSON.stringify({test:'libra_read_manage_screens_browser',ok:true,checks:results.length,boundary:'production renderer; synthetic host and controlled model response'}));
  } catch(error) { console.error(errors.join('\n')); throw error; }
  finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exit(1);});
