'use strict';
// Production reader and APIs with synthetic records; no live RisuAI/provider.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {fixture}=require('../fixtures/libra_unified_runtime_fixture.cjs');
const {waitFor}=require('../fixtures/libra_vm_harness.cjs');
(async()=>{
 const f=await fixture();let seed,canonical,expectedText,evidence;
 try{assert.equal((await f.run()).completed,1);await waitFor(()=>f.getMemory(1).embedding.status!=='pending');const memory=f.getMemory(1);expectedText=memory.text;evidence=memory.canonicalArtifact;assert.match(expectedText,/\n## 시간순 사건/);assert.match(expectedText,/\(근거:/);canonical=Object.values(f.getManifest().memories).map(ref=>[ref.key,f.r.values.get(ref.key)]);seed={chat:f.chat,character:f.character,values:[...f.r.values]};}finally{await f.r.cleanup();}
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const errors=[];try{
  const page=await browser.newPage({viewport:{width:1600,height:1100}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost/libra-canonical-reader',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><body></body></html>'}));await page.goto('http://localhost/libra-canonical-reader');await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
  await page.evaluate(seed=>{Object.assign(__writerHost.chat,seed.chat);Object.assign(__writerHost.character,seed.character);__writerHost.values.clear();for(const[k,v]of seed.values)__writerHost.values.set(k,v);__writerHost.values.set('libra.firstSetupSeen.v1','1');},seed);
  let source=fs.readFileSync(path.join(__dirname,'../../plugins/LIBRA.js'),'utf8'),needle='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';assert.ok(source.includes(needle));source=source.replace(needle,'  globalThis.__readingAudit={buildBookMemoryReadingBody};\n'+needle);
  await page.addScriptTag({content:source});await page.waitForFunction(()=>!!window.__LIBRA__);await page.evaluate(()=>__LIBRA__.openSettingsGui());await page.locator('.nav-item[data-go="memory"]').click();await page.locator('[data-canonical-reader="book"] .chapter[data-memory-id]').first().click();
  const reader=page.locator('[data-canonical-reading]');await reader.waitFor();assert.equal(await reader.locator('[data-canonical-reading-section]').count(),7);assert.equal(await reader.locator('details,[role="tablist"]').count(),0);
  assert.doesNotMatch(await page.locator('[data-canonical-chapter] > h2').innerText(),/^#{1,6}\s/);
  const visibleText=await reader.innerText();assert.doesNotMatch(visibleText,/\(근거\s*:/);assert.doesNotMatch(visibleText,/^#{1,3}\s/m);
  for(const fact of evidence.facts)assert.ok(visibleText.includes(fact.text),'the reader keeps fact '+fact.tempFactId);
  const detail=await page.evaluate(async()=>{const chapters=await __LIBRA__.listCanonicalReaderChapters();return __LIBRA__.getCanonicalReaderChapter(chapters.items[0]);});assert.equal(detail.text,expectedText);assert.deepEqual(detail.canonicalArtifact,evidence);
  if(process.env.LIBRA_REVIEW_ARTIFACT_DIR){fs.mkdirSync(process.env.LIBRA_REVIEW_ARTIFACT_DIR,{recursive:true});await reader.locator('section').first().scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.LIBRA_REVIEW_ARTIFACT_DIR,'canonical-reader-sections-top.png'),fullPage:true});await reader.locator('[data-canonical-reading-section="world_scene"]').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.LIBRA_REVIEW_ARTIFACT_DIR,'canonical-reader-sections-bottom.png'),fullPage:true});}
  await page.setViewportSize({width:390,height:1000});await reader.locator('section').first().scrollIntoViewIfNeeded();assert.equal(await reader.evaluate(n=>n.scrollWidth<=n.clientWidth+1&&n.getBoundingClientRect().right<=innerWidth+1),true);
  if(process.env.LIBRA_REVIEW_ARTIFACT_DIR)await page.screenshot({path:path.join(process.env.LIBRA_REVIEW_ARTIFACT_DIR,'canonical-reader-sections-narrow.png'),fullPage:true});
  // User-derived text is rendered as text nodes, never executable HTML.
  assert.deepEqual(await page.evaluate(()=>{const node=__readingAudit.buildBookMemoryReadingBody({text:'# 종합 기억\n## 추가 메모\n- <img src=x onerror="window.readerUnsafe=true">'});document.body.appendChild(node);const result={images:node.querySelectorAll('img').length,literal:node.textContent.includes('<img'),executed:!!window.readerUnsafe};node.remove();return result;}),{images:0,literal:true,executed:false});
  assert.deepEqual(await page.evaluate(keys=>keys.map(key=>[key,__writerHost.values.get(key)]),canonical.map(([key])=>key)),canonical);assert.equal(await page.evaluate(()=>__writerHost.calls.model),0);assert.deepEqual(errors,[]);
  console.log('PASS canonical reading: seven visible areas, fact text retained, inline refs hidden, raw text/evidence/bytes unchanged, narrow view and safe text rendering');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
