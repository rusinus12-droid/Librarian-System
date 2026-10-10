// Actual plugin UI with isolated host/storage; no real RisuAI or model calls.
const fs=require('fs'),path=require('path'),assert=require('assert/strict');const {chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({executablePath:(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'),headless:true});const errors=[];
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<html lang="ko"><body></body></html>');await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
 let src=fs.readFileSync(path.join(__dirname,'../../plugins/LIBRA.js'),'utf8');const marker='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';assert(src.includes(marker));src=src.replace(marker,'  globalThis.__header={Gui,bookNavigate};\n'+marker);
 await page.addScriptTag({content:src});await page.waitForFunction(()=>!!__LIBRA__);await page.evaluate(()=>__LIBRA__.openSettingsGui());await page.locator('[data-book-memory-create]').waitFor();
 const choose=async family=>{await page.locator('.libra-book-brand-button').click();await page.getByRole('menuitem').filter({has:page.locator('strong',{hasText:family==='gradia'?'GRADIA':'LIBRA'})}).click();await page.locator('.libra-book-family-menu').waitFor({state:'detached'});await page.waitForFunction(f=>__header.Gui.state.runtime.responseFamily===f,family);};
 const noOtherSelector=async()=>assert.equal(await page.locator('.libra-book-writing-content select,.libra-book-drawer select').evaluateAll(nodes=>nodes.filter(n=>[...n.options].some(o=>o.value==='libra')&&[...n.options].some(o=>o.value==='gradia')).length),0,'header is the only family selector');
 await page.locator('.libra-book-sidebar [data-book-page="writing"]').click();
 await page.getByRole('tab',{name:'인풋 작성',exact:true}).click();await page.locator('[data-book-quick-native="input-writer"] button').filter({has:page.locator('strong',{hasText:'소설 모드'})}).click();
 await choose('gradia');assert.equal(await page.evaluate(()=>__header.Gui.bookWritingTab),'input');assert.equal(await page.evaluate(()=>__header.Gui.state.runtime.inputWriterMode),'author');assert.equal(await page.evaluate(()=>__header.Gui.dirty),true);await noOtherSelector();
 await page.getByRole('tab',{name:'응답 작성',exact:true}).click();await page.locator('[data-book-response-settings="gradia"]').waitFor();await noOtherSelector();
 await page.locator('[data-book-quick-native="gradia-response"] button').filter({has:page.locator('strong',{hasText:/^RP 모드$/})}).click();
 await page.locator('[data-settings-room-save]').click();await page.waitForFunction(()=>!__header.Gui.settingsRoomSaving&&!__header.Gui.dirty);
 await choose('libra');await page.locator('[data-book-response-settings="libra"]').waitFor();assert.equal(await page.evaluate(()=>__header.Gui.state.runtime.gradiaWritingMode),'rp');
 await page.locator('[data-settings-room-revert]').click();await page.waitForFunction(()=>!__header.Gui.dirty&&__header.Gui.state.runtime.responseFamily==='gradia');await page.waitForFunction(()=>document.querySelector('.libra-book-brand-copy strong')?.textContent==='GRADIA');
 await page.locator('.libra-book-quick-button').click();await page.locator('.libra-book-drawer [data-book-response-settings="gradia"]').waitFor();await noOtherSelector();await page.locator('[data-book-quick-close]').click();await page.locator('.libra-book-drawer').waitFor({state:'detached'});
 await choose('libra');await page.locator('.libra-book-quick-button').click();await page.locator('.libra-book-drawer [data-book-response-settings="libra"]').waitFor();await noOtherSelector();await page.locator('[data-book-quick-close]').click();
 await page.locator('.libra-book-sidebar [data-book-page="world"]').click();await choose('gradia');assert.equal(await page.evaluate(()=>__header.Gui.bookPage),'world','family changes preserve common page');
 await page.setViewportSize({width:390,height:844});await choose('libra');await choose('gradia');await choose('gradia');await page.locator('.libra-book-quick-button').click();await page.locator('.libra-book-drawer [data-book-response-settings="gradia"]').waitFor();await noOtherSelector();
 assert.equal(await page.evaluate(()=>__header.Gui.state.runtime.inputWriterMode),'author');assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>__writerHost.calls.model),0);
 console.log('PASS header-only family selection, shared views, independent modes, save/revert, common page retention, mobile and menu close; zero model calls');
}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1});
