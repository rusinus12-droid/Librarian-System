'use strict';
// Production renderer and variant API; synthetic storage and paginated receipt responses.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {fixture}=require('../fixtures/libra_unified_runtime_fixture.cjs');
const {waitFor}=require('../fixtures/libra_vm_harness.cjs');
(async()=>{
 const f=await fixture();let seed;
 try{
  assert.equal((await f.run()).completed,1);await waitFor(()=>f.getMemory(1).embedding.status!=='pending');
  await f.r.api.listCanonicalVariants({startTurn:1});
  for(const [key,value] of f.r.values){
   let index;try{index=JSON.parse(value);}catch{continue;}
   if(index?.schema!=='libra.canonical_variant_index.v1')continue;
   const slot=index.slots['1'],original=slot.variants[0];
   slot.variants.push(...Array.from({length:14},(_,i)=>({...original,variantId:`historical-${i}-${'long-id-'.repeat(15)}`,key:`historical-key-${i}`,revision:i+2,status:'inactive',updatedAt:`2026-10-28T12:${String(i).padStart(2,'0')}:00Z`})));
   f.r.values.set(key,JSON.stringify(index));
  }
  seed={chat:f.chat,character:f.character,values:[...f.r.values]};
 }finally{await f.r.cleanup();}
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const errors=[];
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
  await page.route('http://localhost/libra-versions-scroll',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><body></body></html>'}));
  await page.goto('http://localhost/libra-versions-scroll');await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
  await page.evaluate(seed=>{Object.assign(__writerHost.chat,seed.chat);Object.assign(__writerHost.character,seed.character);__writerHost.values.clear();for(const[k,v]of seed.values)__writerHost.values.set(k,v);__writerHost.values.set('libra.firstSetupSeen.v1','1');},seed);
  await page.evaluate(()=>{
   window.__fixtureListReceipts=async({kind,expectedScopeKey,cursor})=>({scopeKey:expectedScopeKey,kind,items:Array.from({length:kind==='state'?1:20},(_,i)=>({id:`${kind}-${cursor?'next':'first'}-${i}-${'receipt'.repeat(15)}`,kind,status:'complete',provider:'provider-model-'.repeat(20),finishedAt:'2026-10-28T12:00:00Z',usage:{totalTokens:123}})),hasMore:kind!=='state'&&!cursor,nextCursor:cursor?'':'page-2'});
  });
  const source=fs.readFileSync(process.env.LIBRA_TEST_PLUGIN||path.join(__dirname,'../../plugins/LIBRA.js'),'utf8');
  const receiptApi='async listExecutionReceipts(options = {}) { return safeClone(await LibraMemoryCore.listExecutionReceipts(options)); },';
  assert.ok(source.includes(receiptApi));
  await page.addScriptTag({content:source.replace(receiptApi,'async listExecutionReceipts(options = {}) { return globalThis.__fixtureListReceipts(options); },')});
  await page.waitForFunction(()=>!!window.__LIBRA__);await page.evaluate(()=>__LIBRA__.openSettingsGui());
  await page.locator('.nav-item[data-go="memory"]').click();await page.locator('.page[data-page="memory"] .page-head [data-val="manage"]').click();
  await page.getByRole('button',{name:'버전 · 실행 기록',exact:true}).click();
  const drawer=page.locator('[data-canonical-variant-dialog]'),versions=drawer.locator('#ver-rows'),body=drawer.locator('.drawer__body');
  await versions.locator('.ver-row').nth(9).waitFor();
  for(const width of [1600,768,390]){
   await page.setViewportSize({width,height:1000});
   const geometry=()=>versions.evaluate(n=>({height:n.clientHeight,scroll:n.scrollTop,overflow:n.scrollHeight-n.clientHeight}));
   assert.ok((await geometry()).overflow>0,'version list is scrollable');
   await versions.hover();
   const wheelTarget=await versions.evaluate(n=>Math.min(n.scrollTop+240,n.scrollHeight-n.clientHeight));
   await page.mouse.wheel(0,240);await page.waitForFunction(target=>document.querySelector('[data-canonical-variant-dialog] #ver-rows').scrollTop>=target-1,wheelTarget);
   const before=await geometry();
   for(const kind of ['state','memory']){
    await drawer.locator(`[data-execution-kind="${kind}"]`).click();
    await drawer.locator(`[data-normalized-execution-receipts="${kind}"] [data-execution-receipt-id]`).first().waitFor();
    const after=await geometry();assert.equal(after.height,before.height,'run tabs preserve the version viewport height');assert.equal(after.scroll,before.scroll,'run tabs preserve the version scroll position');
   }
   if(await drawer.getByRole('button',{name:'기록 더 보기',exact:true}).count())await drawer.getByRole('button',{name:'기록 더 보기',exact:true}).click();
   await page.waitForFunction(()=>document.querySelectorAll('[data-canonical-variant-dialog] #run-rows [data-execution-receipt-id]').length===40).catch(async error=>{console.log({width,rows:await drawer.locator('[data-execution-receipt-id]').count(),text:(await drawer.locator('#run-rows').innerText()).slice(-600)});throw error;});
   assert.equal((await geometry()).height,before.height);assert.equal((await geometry()).scroll,before.scroll);
   await body.evaluate(n=>n.scrollTop=n.scrollHeight);
   assert.ok(await body.evaluate(n=>n.scrollTop>0),'drawer can scroll to the final run');
   assert.ok(await drawer.locator('[data-execution-receipt-id]').last().isVisible());
   assert.ok(await body.evaluate(n=>n.scrollWidth<=n.clientWidth+1),'no horizontal overflow');
   const outliers=await body.evaluate(n=>{const b=n.getBoundingClientRect();return [...n.querySelectorAll('.ver-row,.card,.tabs,.tab,.res-row')].filter(c=>{const r=c.getBoundingClientRect();return r.left<b.left-1||r.right>b.right+1;}).map(c=>c.className);});
   assert.deepEqual(outliers,[],'rows, cards, and tabs stay inside drawer');
   if(process.env.LIBRA_REVIEW_ARTIFACT_DIR){fs.mkdirSync(process.env.LIBRA_REVIEW_ARTIFACT_DIR,{recursive:true});await body.evaluate(n=>n.scrollTop=0);await page.screenshot({path:path.join(process.env.LIBRA_REVIEW_ARTIFACT_DIR,`versions-runs-${width}.png`)});}
  }
  await drawer.getByRole('button',{name:'다음 페이지',exact:true}).click();await drawer.getByText('2 / 2 · 15개',{exact:true}).waitFor();assert.equal(await versions.locator('.ver-row').count(),5);
  assert.deepEqual(errors,[]);console.log('PASS versions scroll, run tab and pagination preserve version viewport, narrow drawer bounds, variant pagination (synthetic host/receipts; no live RisuAI)');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
