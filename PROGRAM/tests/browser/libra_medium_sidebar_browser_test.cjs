const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');const {chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({executablePath:(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'),headless:true});try{
const page=await browser.newPage({viewport:{width:833,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.setContent('<html lang="ko"><body></body></html>');await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});await page.addScriptTag({path:path.join(__dirname,'../../plugins/LIBRA.js')});await page.waitForFunction(()=>!!globalThis.__LIBRA__);
for(const family of ['libra','gradia']){
await page.evaluate(f=>__LIBRA__.saveLibraProviderConfig({responseFamily:f}),family);await page.evaluate(()=>__LIBRA__.openSettingsGui());
await page.locator('.libra-book-brand-button').click();await page.getByRole('menuitem').filter({has:page.locator('strong',{hasText:family==='gradia'?'GRADIA':'LIBRA'})}).click();await page.waitForFunction(f=>document.querySelector('.libra-book-app')?.dataset.responseFamily===f,family);
for(const width of [761,833,980]){
 await page.setViewportSize({width,height:1100});
 await page.waitForTimeout(200);
 const sidebar=page.locator('.libra-book-sidebar'),shell=page.locator('.sga-shell');await sidebar.waitFor({state:'visible'});
 const b=await sidebar.boundingBox(),s=await shell.boundingBox();assert(b.width>s.width*.9,JSON.stringify({width,b,s}));
 const buttons=sidebar.locator('nav>button[data-book-page]');assert((await buttons.count())>=6);
 for(const button of await buttons.all()){const box=await button.boundingBox();assert(box.width>=130&&box.height>=44);assert(box.x>=b.x&&box.x+box.width<=b.x+b.width+1);}
 assert(await sidebar.evaluate(n=>n.scrollWidth<=n.clientWidth+1),'no horizontal sidebar overflow');
 await sidebar.locator('[data-book-page="settings"]').click();await sidebar.locator('[data-book-page="settings"][aria-current="page"]').waitFor();
 assert(await sidebar.evaluate(n=>n.scrollWidth<=n.clientWidth+1),'settings menu has no horizontal overflow');
 const first=sidebar.locator('nav>button[data-book-page]').first();const firstPage=await first.getAttribute('data-book-page');await first.click();await sidebar.locator(`[data-book-page="${firstPage}"][aria-current="page"]`).waitFor();
 if(width===833&&family==='gradia'&&process.env.LIBRA_MEDIUM_SCREENSHOT)await page.screenshot({path:process.env.LIBRA_MEDIUM_SCREENSHOT});
}
await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('.libra-book-sidebar').isVisible(),false);assert(await page.locator('.libra-book-mobile-nav').isVisible());
await page.setViewportSize({width:1440,height:1000});const side=await page.locator('.libra-book-sidebar').boundingBox();assert(side.width>=180&&side.width<=260);
await page.getByRole('button',{name:'설정 화면 닫기',exact:true}).click();
}
assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>__writerHost.calls.model),0);console.log('PASS: LIBRA/GRADIA 761/833/980px full-width wrapping navigation, settings and return, 390px mobile, 1440px desktop');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
