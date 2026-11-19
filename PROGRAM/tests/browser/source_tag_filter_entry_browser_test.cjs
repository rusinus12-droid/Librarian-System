'use strict';
// Each memory plugin has a 원문 태그 필터 entry button on its main view (LIBRA 세계선 · 기억 연속성,
// Flashback 필름 보관함 → 응답 원문, HAYAKU 연속성 노선도) that opens the tag editor directly.
const path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {resolveChromeExecutable}=require('../fixtures/browser_resolver.cjs');
(async()=>{const browser=await chromium.launch({executablePath:resolveChromeExecutable(),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});try{
 for(const [owner,file,api] of [['libra','LIBRA.js','__LIBRA__'],['hayaku','HAYAKU_Locator_Continuity.js','HAYAKU'],['flashback','Flashback_Memory.js','__FlashbackMemory']]){
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://localhost/**',route=>route.fulfill({body:'<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><body></body></html>',contentType:'text/html'}));
  await page.goto('http://localhost/tag-filter');await page.addScriptTag({path:path.join(__dirname,'hayaku_browser_host.js')});
  await page.addScriptTag({path:path.join(__dirname,'../../plugins',file)});await page.waitForFunction(name=>!!window[name],api);
  await page.evaluate(async({owner,api})=>{if(owner==='libra')await window[api].openSettingsGui();else await window[api].showUi();},{owner,api});
  if(owner==='libra'){await page.waitForFunction(()=>!!document.querySelector('.sidebar [data-go="desk"]'));await page.evaluate(()=>document.querySelector('.sidebar [data-go="desk"]').click());}
  if(owner==='flashback'){await page.locator('.sidebar [data-go="vault"]').click();}
  const entry=page.locator(({libra:'[data-libra-open-tag-filter]',hayaku:'[data-hayaku-open-tag-filter]',flashback:'[data-fb-open-tag-filter]'})[owner]+':visible').first();
  await entry.waitFor({timeout:15000});assert.equal((await entry.textContent()).trim(),'원문 태그 필터',owner+': entry label');
  await entry.click();
  const controls=page.locator('[data-source-input-controls]:visible');await controls.locator('[data-source-input-add]').waitFor({timeout:15000});
  assert.equal(await controls.count(),1,owner+': one editor opened');
  assert.deepEqual(errors,[],owner+': no page errors');
  console.log(JSON.stringify({owner,ok:true}));await page.close();
 }
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
