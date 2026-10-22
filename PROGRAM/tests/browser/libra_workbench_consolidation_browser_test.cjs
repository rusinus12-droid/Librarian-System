'use strict';
const assert=require('node:assert/strict');
const {boot,clean}=require('./libra_approved_browser.cjs');
(async()=>{
 const {browser,page,errors}=await boot();
 try{
  await page.evaluate(()=>__approved.selectBookSettingsRoomSection('pipeline'));
  const pipeline=page.locator('[data-product-settings-section="pipeline"]');await pipeline.waitFor();
  assert.equal(await pipeline.locator('[data-librarian-analyzer="single"]').count(),1);
  assert.equal(await page.locator('#drawer-quick,.libra-agent-workspace,[data-book-gradia-advanced]').count(),0);
  const select=pipeline.locator('[data-analyzer-field="presetName"]');
  const value=await select.inputValue();
  await select.selectOption(value);
  await page.evaluate(()=>__approved.selectBookSettingsRoomSection('memory'));
  await page.locator('[data-product-settings-section="memory"]').waitFor();
  assert.equal(await page.locator('#libra-live-context-settings').count(),0);
  await page.evaluate(()=>__approved.selectBookSettingsRoomSection('pipeline'));
  await select.waitFor();assert.equal(await select.inputValue(),value,'formal navigation keeps the same analyzer binding');
  const fold=pipeline.locator('[data-librarian-analyzer] > details');await fold.locator(':scope > summary').click();
  assert.equal(await fold.locator('[data-generation-policy]').count(),1);
  assert.equal(await fold.locator('[data-analyzer-field="maxChars"]').count(),1);
  await page.evaluate(()=>__approved.saveSettingsRoom());
  await page.waitForFunction(()=>!__approved.Gui.dirty);
  await page.evaluate(()=>__approved.selectBookSettingsRoomSection('agents'));
  await pipeline.waitFor();
  assert.equal(await pipeline.locator('[data-librarian-analyzer="single"]').count(),1,'legacy route still reaches the formal analyzer');
  await clean(page,errors);
  console.log('PASS: one formal analyzer, retained advanced controls, draft navigation, common save and legacy route');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
