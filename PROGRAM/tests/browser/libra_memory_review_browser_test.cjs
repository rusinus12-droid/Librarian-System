'use strict';
// Actual producer/owner review APIs and production renderer; synthetic RisuAI storage/model boundary.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {conflictingClaims}=require('../libra_memory_review_runtime_test.cjs');
(async()=>{
 let seed;await conflictingClaims(async f=>{seed=structuredClone({character:await f.host.getCharacter(),chat:await f.host.getChat(),values:[...f.values]});});
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true}),errors=[];
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost/memory-review',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><body></body></html>'}));await page.goto('http://localhost/memory-review');
  await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
  await page.evaluate(seed=>{Object.assign(__writerHost.chat,seed.chat);Object.assign(__writerHost.character,seed.character);__writerHost.character.chats=[__writerHost.chat];__writerHost.values.clear();for(const[k,v]of seed.values)__writerHost.values.set(k,v);__writerHost.values.set('libra.firstSetupSeen.v1','1');},seed);
  await page.addScriptTag({path:path.join(__dirname,'../../plugins/LIBRA.js')});await page.waitForFunction(()=>!!window.__LIBRA__);await page.evaluate(()=>__LIBRA__.openSettingsGui());
  await page.getByRole('button',{name:'기억·상태 자동 반영 검토',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'기억·상태 자동 반영 검토',exact:true}),rows=panel.locator('[data-memory-review-id]');
  await rows.first().waitFor().catch(async error=>{console.log('REVIEW PANEL',await panel.innerText());console.log('API',await page.evaluate(()=>__LIBRA__.listMemoryReviews()));throw error;});assert.equal(await rows.count(),1);assert.equal(await rows.first().getAttribute('data-memory-review-risk'),'high');
  await panel.getByLabel('위험도',{exact:true}).selectOption('low');assert.equal(await rows.count(),0);await panel.getByLabel('위험도',{exact:true}).selectOption('high');assert.equal(await rows.count(),1);
  await panel.getByLabel('검증 수준',{exact:true}).selectOption('rules_verified');assert.equal(await rows.count(),0);await panel.getByLabel('검증 수준',{exact:true}).selectOption('additional_verification_pending');assert.equal(await rows.count(),1);
  for(const width of [1280,390,320]){await page.setViewportSize({width,height:1000});assert.ok(await panel.locator('[data-memory-review]').evaluate(n=>n.scrollWidth<=n.clientWidth+1));}
  assert.equal(await panel.getByRole('button',{name:'선택 확정',exact:true}).isDisabled(),true,'decision buttons wait for a selection');
  const card=await rows.first().innerText();assert.equal(card.split('추가 검증 미완').length,1,'risk and validation level are not repeated on the card');assert.doesNotMatch(card,/보류했습니다/,'auto-applied rows never claim to be held');
  await rows.first().locator('input').check();await panel.getByRole('button',{name:'선택 확정',exact:true}).click();await panel.getByRole('status').filter({hasText:'1개를 확정했습니다'}).waitFor();
  await panel.getByLabel('검토 상태',{exact:true}).selectOption('confirmed');assert.equal(await rows.count(),1);assert.equal(await rows.first().getAttribute('data-memory-review-risk'),'high');
  await rows.first().locator('input').check();assert.equal(await panel.getByRole('button',{name:'선택 확정',exact:true}).isDisabled(),true,'confirming an already confirmed row is a no-op');
  await panel.getByRole('button',{name:'선택 반려',exact:true}).click();await panel.getByRole('status').filter({hasText:'1개를 반려했습니다'}).waitFor();
  await panel.getByLabel('검토 상태',{exact:true}).selectOption('rejected');assert.equal(await rows.count(),2);
  await panel.getByRole('button',{name:'표시 항목 전체 선택',exact:true}).click();await panel.getByRole('button',{name:'자동 반영으로 되돌리기',exact:true}).click();await panel.getByRole('status').filter({hasText:'2개를 자동 반영으로 되돌렸습니다'}).waitFor();
  await panel.getByLabel('검토 상태',{exact:true}).selectOption('automatic');assert.equal(await rows.count(),2);
  if(process.env.LIBRA_REVIEW_ARTIFACT_DIR){fs.mkdirSync(process.env.LIBRA_REVIEW_ARTIFACT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.LIBRA_REVIEW_ARTIFACT_DIR,'memory-review-mobile.png')});}
  assert.equal(await page.evaluate(()=>__writerHost.calls.model),0);assert.deepEqual(errors,[]);
  await panel.getByRole('button',{name:'닫기',exact:true}).click();assert.equal(await panel.count(),0);
  console.log('PASS review entry, risk/state filters, selected confirm/reject/restore, saved risk, mobile bounds and no provider calls');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
