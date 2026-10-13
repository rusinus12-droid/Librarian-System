'use strict';
// Public product GUI regression for owner-scoped source rules. The retired
// observer modes, private controller source marker, modal, and floating dock
// are intentionally absent under explicit_only; this exercises the current
// inline user-authored rule editor and durable owner readback instead.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {resolveChromeExecutable}=require('../fixtures/browser_resolver.cjs');
const output=path.resolve(process.argv[2]||process.env.SOURCE_RULES_GUI_ARTIFACTS||path.join(os.tmpdir(),'source-rules-gui-browser'));
fs.mkdirSync(output,{recursive:true});
(async()=>{const browser=await chromium.launch({executablePath:resolveChromeExecutable(),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});try{
 for(const [owner,file,api] of [['libra','LIBRA.js','__LIBRA__'],['hayaku','HAYAKU_Locator_Continuity.js','HAYAKU'],['flashback','Flashback_Memory.js','__FlashbackMemory']]){
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://localhost/**',route=>route.fulfill({body:'<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><body></body></html>',contentType:'text/html'}));
  await page.goto('http://localhost/source-rules');await page.addScriptTag({path:path.join(__dirname,'hayaku_browser_host.js')});
  const source=path.join(__dirname,'../../plugins',file),sourceSha=require('node:crypto').createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  await page.addScriptTag({path:source});await page.waitForFunction(name=>!!window[name],api);
  await page.evaluate(async({owner,api})=>{window.product=window[api];window.originalChat=JSON.stringify(__chat);if(owner==='libra')await product.openSettingsGui();else await product.showUi();},{owner,api});
  if(owner==='libra'){
   await page.waitForFunction(()=>!!document.querySelector('.sidebar [data-go="settings"]'));await page.evaluate(()=>document.querySelector('.sidebar [data-go="settings"]').click());
   await page.locator('.setnav button').filter({hasText:'참고 자료'}).click();await page.locator('.page[data-page="settings"] .tabs button').filter({hasText:'분석할 내용'}).click();
  }else if(owner==='hayaku'){
   await page.locator('.tabbar [data-go="recovery"]').click();await page.locator('[data-recovery-view="reanalysis"]').click();
  }else await page.locator('.tabbar [data-go="care"]').click();
  const controls=page.locator('[data-source-input-controls]:visible');await controls.waitFor();
  assert.equal(await controls.locator('select option[value="auto"],select option[value="off"],select option[value="notify"]').count(),0,owner+': no retired automatic mode selector');
  assert.equal(await page.locator('[data-source-tracking-controls],#memorySuiteSourceReview,[x-memory-suite-source-review-dock],[x-memory-suite-source-edit-dialog]').count(),0,owner+': retired observer/dock/dialog UI absent');
  assert.equal(await controls.locator('[data-source-input-preview]').count(),1,owner+': explicit local preview remains available');
  const before=await page.evaluate(()=>JSON.parse(JSON.stringify(product.getSourceEditRules()))),hostBefore=await page.evaluate(()=>({...__hostCalls}));
  const addRule=async(action,label)=>{const rowIndex=await controls.locator('[data-source-input-row]').count()-1,row=controls.locator('[data-source-input-row]').nth(rowIndex);await row.locator('[data-rule-action]').selectOption(action);await row.locator('[data-rule-custom]').check();await row.locator('[data-rule-open]').fill('['+label+' '+owner.toUpperCase()+' START]');await row.locator('[data-rule-close]').fill('['+label+' '+owner.toUpperCase()+' END]');return row;};
  await addRule('sourceTags','SOURCE');await addRule('unwrapTags','UNWRAP');await addRule('ignoredTags','IGNORE');
  const disposable=await addRule('ignoredTags','REMOVE');await disposable.locator('[data-rule-delete]').click();
  await controls.locator('[data-source-input-apply]').click();await page.waitForFunction(({api,owner})=>window[api].getSourceEditRules().sourceTags.some(rule=>rule.open==='[SOURCE '+owner.toUpperCase()+' START]'),{api,owner});
  const after=await page.evaluate(()=>JSON.parse(JSON.stringify(product.getSourceEditRules())));
  assert.ok(after.sourceTags.some(rule=>rule.open==='[SOURCE '+owner.toUpperCase()+' START]'&&rule.close==='[SOURCE '+owner.toUpperCase()+' END]'),owner+': owner include-only rule readback');
  assert.ok(after.unwrapTags.some(rule=>rule.open==='[UNWRAP '+owner.toUpperCase()+' START]'&&rule.close==='[UNWRAP '+owner.toUpperCase()+' END]'),owner+': owner unwrap rule readback');
  assert.ok(after.ignoredTags.some(rule=>rule.open==='[IGNORE '+owner.toUpperCase()+' START]'&&rule.close==='[IGNORE '+owner.toUpperCase()+' END]'),owner+': owner exclusion rule readback');
  assert.equal(after.ignoredTags.some(rule=>typeof rule==='object'&&rule.open==='[REMOVE '+owner.toUpperCase()+' START]'),false,owner+': removed draft rule is not saved');
  for(const value of before.ignoredTags)assert.ok(after.ignoredTags.includes(value),owner+': unrelated ignore rule preserved: '+value);for(const value of before.unwrapTags)assert.ok(after.unwrapTags.includes(value),owner+': unrelated unwrap rule preserved: '+value);
  assert.equal(await page.evaluate(()=>JSON.stringify(__chat)),await page.evaluate(()=>originalChat),owner+': rule changes do not mutate chat data');
  const hostAfter=await page.evaluate(()=>({...__hostCalls}));assert.equal(hostAfter.llm,hostBefore.llm,owner+': rule edit has no model calls');assert.equal(hostAfter.network,hostBefore.network,owner+': rule edit has no network calls');assert.ok(hostAfter.writes>hostBefore.writes,owner+': explicit Apply persists owner settings');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,owner+': mobile GUI has no horizontal overflow');assert.deepEqual(errors,[],owner+': no browser errors');
  await page.screenshot({path:path.join(output,owner+'-390x844.png'),fullPage:true});
  console.log(JSON.stringify({owner,sourceSha256:sourceSha,storageWrites:hostAfter.writes-hostBefore.writes,checks:['actual public route','explicit_only UI','sourceTags/unwrapTags/ignoredTags draft/apply/readback','removed draft absent after save','unrelated rules preserved','chat unchanged','no model/network','mobile overflow','no page errors']}));
  await page.evaluate(()=>__dispose());await page.close();
 }
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
