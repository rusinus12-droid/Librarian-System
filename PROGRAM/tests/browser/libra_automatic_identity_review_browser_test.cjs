'use strict';
// Full production renderer with synthetic persisted evidence, not a live RisuAI host.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {automaticIdentityFixture}=require('../fixtures/libra_automatic_identity_fixture.cjs');
const {waitFor}=require('../fixtures/libra_vm_harness.cjs');
(async()=>{
 const f=await automaticIdentityFixture();let seed;
 try{assert.equal((await f.run()).completed,2);await waitFor(()=>[1,6].every(start=>f.getMemory(start).embedding.status!=='pending'));seed={chat:f.chat,character:f.character,values:[...f.r.values]};}finally{await f.r.cleanup();}
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const errors=[];
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1100}});page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost/libra-synthetic-host',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><body></body></html>'}));await page.goto('http://localhost/libra-synthetic-host');
  await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
  await page.evaluate(seed=>{
   Object.assign(__writerHost.chat,seed.chat);Object.assign(__writerHost.character,seed.character);
   __writerHost.values.clear();for(const [k,v] of seed.values)__writerHost.values.set(k,v);__writerHost.values.set('libra.firstSetupSeen.v1','1');
   risuai.runLLMModel=async()=>{__writerHost.calls.model++;throw Error('review must not call a model');};
  },seed);
  await page.addScriptTag({path:path.join(__dirname,'../../plugins/LIBRA.js')});await page.waitForFunction(()=>!!window.__LIBRA__);
  await page.evaluate(()=>__LIBRA__.openSettingsGui());
  // Use the actual app navigation and review entry point.
  await page.locator('.nav-item[data-go="people"]').click();
  await page.locator('[data-open-identity-link-review]').click();const panel=page.getByRole('dialog',{name:'자동 연결 검토',exact:true});
  await panel.locator('[data-identity-link]').waitFor();assert.equal(await panel.locator('[data-identity-link]').count(),1);
  await panel.getByText('연결 근거 · 원문 보기',{exact:true}).click();await panel.getByText('김민아는 민아와는 다른 사람이다. 김민아가 서재에 도착했다.',{exact:true}).waitFor();
  if(process.env.LIBRA_REVIEW_ARTIFACT_DIR){fs.mkdirSync(process.env.LIBRA_REVIEW_ARTIFACT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.LIBRA_REVIEW_ARTIFACT_DIR,'automatic-link-review.png'),fullPage:true});}
  await panel.locator('[data-split-identity-link]').click();const manager=page.locator('#dlg-merge');
  assert.equal(await panel.count(),0);assert.equal(await page.getByRole('dialog').count(),1);
  await manager.locator('[data-split-occurrence]').first().waitFor();
  await manager.getByRole('button',{name:'닫기',exact:true}).click();await panel.locator('[data-split-identity-link]').click();
  await manager.locator('select[data-split-occurrence]').first().waitFor();assert.equal(await manager.getByLabel('분리 인물 1 이름',{exact:true}).inputValue(),'김민아');assert.equal(await manager.getByLabel('분리 인물 2 이름',{exact:true}).inputValue(),'민아');
  assert.equal(await manager.locator('select[data-split-occurrence]').count(),2);
  const select=manager.locator('select[data-split-occurrence]');
  // Origin IDs prefill both roles; saving requires no individual approval.
  for(let i=0;i<await select.count();i++){const row=select.nth(i),turn=await row.locator('..').innerText();assert.equal(await row.inputValue(),turn.includes('T1–5')?'person_2':'person_1');}
  assert.equal(await manager.getByRole('button',{name:'현재 배정으로 분리 저장',exact:true}).isEnabled(),true);
  await manager.getByRole('button',{name:'현재 배정으로 분리 저장',exact:true}).scrollIntoViewIfNeeded();
  if(process.env.LIBRA_REVIEW_ARTIFACT_DIR)await page.screenshot({path:path.join(process.env.LIBRA_REVIEW_ARTIFACT_DIR,'automatic-link-split.png'),fullPage:true});
  await select.first().selectOption('person_1');await select.first().selectOption('person_2');
  await manager.getByRole('button',{name:'현재 배정으로 분리 저장',exact:true}).click();
  await page.waitForFunction(()=>[...__writerHost.values.values()].some(v=>{try{const o=JSON.parse(v);return o.schema==='libra.continuity_state.v2'&&o.characters.length===2;}catch{return false;}}));
  const split=await page.evaluate(()=>__LIBRA__.listWorldManagerIdentityLinkReviews());assert.equal(split.rows[0].status,'split');
  await panel.getByText('서로 다른 인물로 분리하고 저장 결과를 다시 읽었습니다.',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-character-search]').count(),2);
  await panel.getByRole('button',{name:'닫기',exact:true}).click();
  // Restore the reviewed original via the correction journal, then exercise confirmation in the UI.
  await page.evaluate(async()=>{const journal=await __LIBRA__.listWorldManagerCorrections();await __LIBRA__.setWorldManagerCorrectionStatus(journal.items.at(-1).correctionId,'suspended');await __LIBRA__.openSettingsGui();});
  await page.locator('.nav-item[data-go="people"]').click();await page.locator('[data-open-identity-link-review]').click();await panel.locator('[data-confirm-identity-link]').click();
  await panel.getByText('연결 확정을 저장하고 다시 읽었습니다.',{exact:true}).waitFor();assert.equal((await page.evaluate(()=>__LIBRA__.listWorldManagerIdentityLinkReviews())).rows[0].status,'confirmed');
  await panel.getByLabel('확정된 연결도 보기',{exact:true}).check();await panel.getByText('연결 확정됨',{exact:true}).waitFor();
  await panel.getByRole('button',{name:'닫기',exact:true}).click();assert.equal(await panel.count(),0);
  assert.equal(await page.evaluate(()=>__writerHost.calls.model),0);assert.deepEqual(errors,[]);console.log('PASS automatic identity review: evidence, fact-role split, durable confirmation and close through production UI');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
