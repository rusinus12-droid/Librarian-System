'use strict';
// Full production renderer with synthetic persisted evidence, not a live RisuAI host.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {fixture,artifact}=require('../fixtures/libra_unified_runtime_fixture.cjs');
const {waitFor}=require('../fixtures/libra_vm_harness.cjs');
(async()=>{
 const f=await fixture();let seed,calls=0;
 const rename=value=>value.replaceAll('민아','김민아').replaceAll('지호','한지호').replaceAll('준호','이준호');
 f.chat.message.push(...f.chat.message.map((row,i)=>({...row,chatId:`t${6+Math.floor(i/2)}-${i%2?'a':'u'}`,data:rename(row.data)})));
 f.control.onCall=()=>{
  let a=artifact();if(calls++>0){a=JSON.parse(rename(JSON.stringify(a)));for(const row of [...a.entities,...a.facts])for(const span of row.evidenceSpans)span.ref=span.ref.replace(/^t(\d+)/,(_,n)=>'t'+(Number(n)+5));}
  return {type:'success',result:JSON.stringify(a)};
 };
 try{assert.equal((await f.run()).completed,2);await waitFor(()=>[1,6].every(start=>f.getMemory(start).embedding.status!=='pending'));assert.equal((await f.r.api.listWorldManagerIdentityLinkReviews()).rows.filter(r=>r.status==='review').length,3);seed={chat:f.chat,character:f.character,values:[...f.r.values]};}finally{await f.r.cleanup();}
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

  await page.locator('.nav-item[data-go="people"]').click();await page.locator('[data-open-identity-link-review]').click();
  const panel=page.getByRole('dialog',{name:'자동 연결 검토',exact:true}),checks=panel.locator('[data-select-identity-link]'),bulk=panel.locator('[data-confirm-identity-links]');
  await checks.nth(2).waitFor();assert.equal(await checks.count(),3);assert.equal(await bulk.isEnabled(),false);
  await checks.nth(0).check();await checks.nth(1).check();assert.match(await bulk.textContent(),/선택한 2개/);
  await panel.getByRole('button',{name:'선택 해제',exact:true}).click();assert.equal(await checks.locator(':checked').count(),0);assert.equal(await bulk.isEnabled(),false);
  // A changed target must be reviewed again rather than accepted under a fresh digest.
  await page.evaluate(()=>{const api=__LIBRA__;window.__bulkApi=api;window.__bulkCalls=0;window.__LIBRA__={...api,async listWorldManagerIdentityLinkReviews(){const p=await api.listWorldManagerIdentityLinkReviews();p.rows[0].currentTargetId='changed-target';return p;},async confirmWorldManagerIdentityLink(request){window.__bulkCalls++;return api.confirmWorldManagerIdentityLink(request);}};});
  await checks.first().check();await bulk.click();await panel.getByRole('status').filter({hasText:'연결 확정 중단 · 0 / 1개 완료'}).waitFor();assert.equal(await page.evaluate(()=>__bulkCalls),0);
  await page.evaluate(()=>window.__LIBRA__=window.__bulkApi);
  // Fail the second real API call: completed items must remain confirmed, others selected.
  await page.evaluate(()=>{const api=__LIBRA__;window.__bulkApi=api;window.__bulkCalls=0;window.__LIBRA__={...api,async confirmWorldManagerIdentityLink(request){window.__bulkCalls++;if(window.__bulkCalls===1)await new Promise(resolve=>window.__bulkRelease=resolve);if(window.__bulkCalls===2)throw Error('synthetic second-item failure');return api.confirmWorldManagerIdentityLink(request);}};});
  await panel.getByRole('button',{name:'검토 대상 전체 선택',exact:true}).click();
  if(process.env.LIBRA_REVIEW_ARTIFACT_DIR){fs.mkdirSync(process.env.LIBRA_REVIEW_ARTIFACT_DIR,{recursive:true});await page.setViewportSize({width:390,height:1000});assert.ok(await panel.locator('[data-identity-link-review]').evaluate(n=>n.scrollWidth<=n.clientWidth+1));await page.screenshot({path:path.join(process.env.LIBRA_REVIEW_ARTIFACT_DIR,'bulk-selected-mobile.png')});await page.setViewportSize({width:1600,height:1100});}
  await bulk.click();
  await page.waitForFunction(()=>!!window.__bulkRelease);assert.equal(await bulk.isEnabled(),false);assert.equal(await checks.first().isEnabled(),false);assert.equal(await panel.locator('[data-confirm-identity-link]:enabled').count(),0);
  await page.evaluate(()=>window.__bulkRelease());
  await panel.getByRole('status').filter({hasText:'연결 확정 중단 · 1 / 3개 완료'}).waitFor();
  assert.equal(await page.evaluate(()=>__bulkCalls),2);assert.equal(await checks.count(),2);assert.equal(await panel.locator('[data-select-identity-link]:checked').count(),2);
  assert.equal((await page.evaluate(()=>__bulkApi.listWorldManagerIdentityLinkReviews())).rows.filter(r=>r.status==='confirmed').length,1);
  await page.evaluate(()=>window.__LIBRA__=window.__bulkApi);await bulk.click();await panel.getByText('선택한 연결 2개를 확정하고 다시 읽었습니다.',{exact:true}).waitFor();
  const result=await page.evaluate(()=>__LIBRA__.listWorldManagerIdentityLinkReviews());assert.equal(result.rows.filter(r=>r.status==='confirmed').length,3);
  assert.equal((await page.evaluate(()=>__LIBRA__.rebuildWorldManagerState())).ok,true);assert.equal((await page.evaluate(()=>__LIBRA__.listWorldManagerIdentityLinkReviews())).rows.filter(r=>r.status==='confirmed').length,3);
  await panel.getByLabel('확정된 연결도 보기',{exact:true}).check();assert.equal(await checks.count(),0);assert.equal(await panel.locator('[data-identity-link]').count(),3);
  assert.equal(await bulk.isEnabled(),false);assert.equal(await panel.locator('[data-confirm-identity-link]:enabled').count(),0);
  await page.setViewportSize({width:390,height:1000});assert.ok(await panel.locator('[data-identity-link-review]').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
  if(process.env.LIBRA_REVIEW_ARTIFACT_DIR){fs.mkdirSync(process.env.LIBRA_REVIEW_ARTIFACT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.LIBRA_REVIEW_ARTIFACT_DIR,'bulk-confirmed-mobile.png')});}
  await panel.getByRole('button',{name:'닫기',exact:true}).click();assert.equal(await panel.count(),0);
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>__writerHost.calls.model),0);
  console.log('PASS multiple identity selection, select/clear all, sequential fresh previews, partial failure and retry, persisted confirmation, confirmed exclusion, mobile bounds; synthetic host');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
