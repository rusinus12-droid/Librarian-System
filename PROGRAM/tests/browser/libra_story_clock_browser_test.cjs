'use strict';
// The almanac's story clock card: current day, anchor date and a per-pair correction that re-counts
// the later pairs, through the real GUI (docs/gradia/STATE-AIDE-DESIGN-20261114.md §10).
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
    for(const [label,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
      const page=await browser.newPage({viewport});
      page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
      await page.route('http://localhost/libra-story-clock',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><body></body></html>'}));await page.goto('http://localhost/libra-story-clock');
      await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
      const a=artifact(),rows=structuredClone(input.sourceRows);
      await page.evaluate(({rows,a})=>{
        __writerHost.chat.message=rows.map(r=>({role:r.role,chatId:r.ref,data:r.text}));
        __writerHost.artifact=a;
        risuai.runLLMModel=async()=>{__writerHost.calls.model++;return {type:'success',result:JSON.stringify(__writerHost.artifact)};};
      },{rows,a});
      await page.addScriptTag({path:path.join(program,'plugins/LIBRA.js')});await page.waitForFunction(()=>!!window.__LIBRA__);
      await page.evaluate(async()=>{const settings=await __LIBRA__.getLibraMemorySettings();await __LIBRA__.saveLibraMemorySettings({...settings,memoryEngine:'unified'});await __LIBRA__.saveLibraProviderConfig({enableLibrarian:true});});
      check(label+': analysis committed',(await page.evaluate(async()=>await __LIBRA__.runManualColdStart())).completed===1);
      await page.evaluate(async()=>await __LIBRA__.openSettingsGui());
      const jobDialog=page.locator('#job-memory[data-canonical-job-portal]');
      if(await jobDialog.count())await jobDialog.getByRole('button',{name:'닫기',exact:true}).click();
      const capture=async name=>{if(output){fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,label+'-'+name),fullPage:false});}};
      // The mobile drawer hides the nav; the page switch is the same button either way.
      await page.evaluate(()=>document.querySelector('.nav-item[data-go="story"]').click());
      const card=page.locator('.page[data-page="story"] [data-story-clock]');
      await card.waitFor();
      await card.scrollIntoViewIfNeeded();
      await page.waitForFunction(()=>document.querySelector('[data-story-clock] [data-story-clock-current]')?.textContent.includes('아직 시간 진행'));
      check(label+': pairs before the clock are unknown',(await card.innerText()).includes('일차 모름'));
      await capture('story-clock-empty.png');

      // Correct the first pair: it starts the count and every later pair follows.
      await card.locator('[data-story-clock-turns] summary').click();
      await card.locator('[data-story-clock-turn="1"]').click();
      const editor=card.locator('[data-story-clock-editor="1"]');
      await editor.getByLabel('정정할 일차').fill('3');
      await editor.getByLabel('정정할 시간대').selectOption('evening');
      await editor.getByRole('button',{name:'정정 저장',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('[data-story-clock] [data-story-clock-current]')?.textContent.includes('이야기 3일째'));
      check(label+': correction shown on the pair',(await card.locator('[data-story-clock-turn="1"]').innerText()).includes('이야기 3일째 · 저녁'));
      check(label+': later pairs follow the corrected day',(await card.locator('[data-story-clock-turn="2"]').innerText()).includes('이야기 3일째(추정)'));

      // Anchor date: day 1 is 2026-04-01, so day 3 is 2026-04-03.
      await card.getByLabel('이야기 1일째의 날짜').fill('2026-04-01');
      await card.locator('[data-story-clock-anchor]').getByRole('button',{name:'저장',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('[data-story-clock] [data-story-clock-current]')?.textContent.includes('2026-04-03'));
      const saved=await page.evaluate(async()=>await __LIBRA__.getStoryClock());
      check(label+': anchor stored',saved.anchorDate==='2026-04-01');
      check(label+': correction stored',saved.corrections['1']?.day===3&&saved.corrections['1']?.timeOfDay==='evening');
      await card.scrollIntoViewIfNeeded();
      await capture('story-clock-corrected.png');
      // No horizontal overflow in the card at this width.
      check(label+': card fits its width',await card.evaluate(node=>node.scrollWidth<=node.clientWidth+1));

      await card.locator('[data-story-clock-turn="1"]').click();
      await card.locator('[data-story-clock-editor="1"]').getByRole('button',{name:'정정 지우기',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('[data-story-clock] [data-story-clock-current]')?.textContent.includes('아직 시간 진행'));
      check(label+': removing the correction returns to unknown',true);
      await page.close();
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({ok:true,results},null,2));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
