'use strict';
// Production GUI/engine, controlled RisuAI boundary and synthetic stored records.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {fixture}=require('../fixtures/libra_unified_runtime_fixture.cjs');
(async()=>{
 const f=await fixture();let seed;try{await f.run();seed={chat:f.chat,character:f.character,values:[...f.r.values]};}finally{await f.r.cleanup();}
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const errors=[];try{
  const page=await browser.newPage({viewport:{width:1600,height:1100}});page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost/libra-identity-ui',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><body></body></html>'}));await page.goto('http://localhost/libra-identity-ui');
  await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
  await page.evaluate(seed=>{Object.assign(__writerHost.chat,seed.chat);Object.assign(__writerHost.character,seed.character);__writerHost.values.clear();for(const[k,v]of seed.values)__writerHost.values.set(k,v);__writerHost.values.set('libra.firstSetupSeen.v1','1');},seed);
  let source=fs.readFileSync(path.join(__dirname,'../../plugins/LIBRA.js'),'utf8'),needle='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';assert.ok(source.includes(needle));
  source=source.replace(needle,'  globalThis.__identityUiAudit={Gui,renderSettingsGui,bookSelectPeopleSection,worldManagerSnapshotView,buildWorldManagerIdentityMerge};\n'+needle);
  await page.addScriptTag({content:source});await page.waitForFunction(()=>!!window.__LIBRA__);await page.evaluate(async()=>{await __LIBRA__.openSettingsGui();__identityUiAudit.bookSelectPeopleSection('characters');});
  const actions=page.locator('[data-world-correction-action="characters"]').first();await actions.waitFor();
  assert.equal(await actions.locator('[data-open-identity-manager]').count(),1);assert.equal(await page.locator('[data-world-identity-split]').count(),0);
  if(process.env.LIBRA_REVIEW_ARTIFACT_DIR){fs.mkdirSync(process.env.LIBRA_REVIEW_ARTIFACT_DIR,{recursive:true});await actions.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.LIBRA_REVIEW_ARTIFACT_DIR,'identity-controls.png'),fullPage:true});}
  await actions.locator('[data-open-identity-manager]').click();const manager=page.locator('#dlg-merge');
  assert.equal(await page.getByRole('dialog').count(),1);assert.equal(await manager.locator('[data-identity-mode="merge"]').getAttribute('aria-pressed'),'true');
  if(process.env.LIBRA_REVIEW_ARTIFACT_DIR)await page.screenshot({path:path.join(process.env.LIBRA_REVIEW_ARTIFACT_DIR,'identity-manager-merge.png'),fullPage:true});
  await manager.locator('[data-identity-mode="split"]').click();await manager.locator('[data-split-occurrence]').first().waitFor();
  assert.equal(await page.locator('[data-world-identity-split]').count(),1);assert.equal(await manager.locator('[data-world-identity-split]').count(),1);
  await manager.getByLabel('분리 인물 2 이름',{exact:true}).fill('분리 초안');const form=await manager.locator('[data-world-identity-split]').evaluate(node=>{window.__identityForm=node;return true;});assert.equal(form,true);
  await manager.locator('[data-identity-mode="merge"]').click();await manager.locator('[data-identity-mode="split"]').click();
  assert.equal(await manager.getByLabel('분리 인물 2 이름',{exact:true}).inputValue(),'분리 초안');
  await page.setViewportSize({width:390,height:900});assert.equal(await manager.evaluate(node=>node.getBoundingClientRect().right<=innerWidth+1&&node.scrollWidth<=node.clientWidth+1),true);
  await page.setViewportSize({width:1600,height:1100});
  await page.evaluate(async()=>{__identityUiAudit.Gui.invalidations.add('body');await __identityUiAudit.renderSettingsGui();});
  assert.equal(await manager.locator('[data-world-identity-split]').evaluate(node=>node===window.__identityForm),true);
  assert.equal(await manager.getByLabel('분리 인물 2 이름',{exact:true}).inputValue(),'분리 초안');
  if(process.env.LIBRA_REVIEW_ARTIFACT_DIR){fs.mkdirSync(process.env.LIBRA_REVIEW_ARTIFACT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.LIBRA_REVIEW_ARTIFACT_DIR,'identity-manager-split.png'),fullPage:true});}
  await manager.getByRole('button',{name:'닫기',exact:true}).click();assert.equal(await page.locator('[data-world-identity-split]').count(),0);
  await actions.locator('[data-open-identity-manager]').click();assert.equal(await page.locator('#dlg-merge').count(),1);await manager.getByRole('button',{name:'닫기',exact:true}).click();
  // Same manager supports world merging without exposing an unsupported person split.
  await page.evaluate(()=>{const view=__identityUiAudit.worldManagerSnapshotView(),row=view.world.find(r=>r.kind==='location');const button=__identityUiAudit.buildWorldManagerIdentityMerge('world',row,view);document.body.appendChild(button);button.click();button.remove();});
  assert.equal(await manager.locator('[data-identity-mode="split"]').isVisible(),false);assert.equal(await manager.locator('[data-world-identity-split]').count(),0);
  await manager.getByRole('button',{name:'닫기',exact:true}).click();assert.equal(await page.evaluate(()=>__writerHost.calls.model),0);assert.deepEqual(errors,[]);
  console.log('PASS one identity manager: no inline duplicate, one split form, stable draft across modes/render, clean close and world merge scope');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
