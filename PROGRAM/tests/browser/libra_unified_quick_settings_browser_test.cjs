'use strict';
const assert=require('node:assert/strict');
const {boot,clean}=require('./libra_approved_browser.cjs');
(async()=>{
 const {browser,page,errors}=await boot();
 try{
  assert.equal(await page.locator('[data-open="drawer-quick"],#drawer-quick,[data-libra-quick-dialog]').count(),0);
  await page.evaluate(()=>__approved.selectBookSettingsRoomSection('ai'));
  await page.locator('[data-product-settings-section="ai"]').waitFor();
  assert.equal(await page.locator('[data-libra-quick-connect]').count(),0,'duplicate setup form is gone');
  await page.getByRole('button',{name:'프리셋 추가',exact:true}).click();
  const model=page.locator('[data-provider-field="model"]');await model.waitFor();
  await model.fill('retained-preset-test-model');
  await page.locator('[data-settings-room-save]').click();
  await page.waitForFunction(()=>!__approved.Gui.settingsRoomSaving&&!__approved.Gui.dirty);
  const config=await page.evaluate(()=>__LIBRA__.getLibraProviderConfig());
  assert.ok(Object.values(config.providerPresets).some(p=>p.model==='retained-preset-test-model'),'retained preset editor saves without connecting');
  await page.evaluate(()=>__approved.selectBookSettingsRoomSection('memory'));
  await page.locator('[data-product-settings-section="memory"]').waitFor();
  assert.equal(await page.locator('#libra-live-context-settings').count(),0,'retired recent-dialogue settings are gone');
  await page.evaluate(()=>__approved.selectBookSettingsRoomSection('embedding'));
  const enabled=page.getByRole('checkbox',{name:'임베딩 사용',exact:true});await enabled.uncheck();
  await page.evaluate(()=>__approved.selectBookSettingsRoomSection('ai'));
  await page.locator('[data-settings-room-save]').click();
  await page.waitForFunction(()=>!__approved.Gui.settingsRoomSaving&&!__approved.Gui.dirty);
  assert.equal(await page.evaluate(async()=>(await __LIBRA__.getLibraProviderConfig()).embedding.enabled),false);
  for(const width of [1280,900,390]){
   await page.setViewportSize({width,height:900});await page.waitForFunction(()=>!__approved.Gui.renderFrame);
   assert.ok(await page.locator('.app').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
  }
  await clean(page,errors);
  console.log('PASS: redundant forms and recent-dialogue UI absent; preset edit/save and cross-tab embedding save preserved; 3 widths; no model calls');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
