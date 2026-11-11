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
  // The analyzer's model binding lives under AI connection > feature bindings since the settings cleanup.
  await page.evaluate(()=>__approved.selectBookSettingsRoomSection('ai'));
  const ai=page.locator('[data-product-settings-section="ai"]');await ai.waitFor();
  const select=ai.locator('[data-feature-binding="librarian"] select');
  const value=await select.inputValue();
  await select.selectOption(value);
  await page.evaluate(()=>__approved.selectBookSettingsRoomSection('memory'));
  await page.locator('[data-product-settings-section="memory"]').waitFor();
  assert.equal(await page.locator('#libra-live-context-settings').count(),0);
  await page.evaluate(()=>__approved.selectBookSettingsRoomSection('ai'));
  await select.waitFor();assert.equal(await select.inputValue(),value,'formal navigation keeps the same analyzer binding');
  await page.evaluate(()=>__approved.selectBookSettingsRoomSection('pipeline'));
  const fold=pipeline.locator('[data-librarian-analyzer]');await fold.waitFor();
  assert.equal(await fold.locator('[data-generation-policy]').count(),1);
  assert.equal(await fold.locator('[data-analyzer-field="timeoutMs"]').count(),1);
  await page.evaluate(()=>__approved.saveSettingsRoom());
  await page.waitForFunction(()=>!__approved.Gui.dirty);
  await page.evaluate(()=>__approved.selectBookSettingsRoomSection('agents'));
  await pipeline.waitFor();
  assert.equal(await pipeline.locator('[data-librarian-analyzer="single"]').count(),1,'legacy route still reaches the formal analyzer');
  await clean(page,errors);
  console.log('PASS: one formal analyzer, retained advanced controls, draft navigation, common save and legacy route');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
