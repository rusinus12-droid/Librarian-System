const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{const b=await chromium.launch({executablePath:(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'),headless:true});try{
for(const [owner,file,api,getter,controllerVar]of [['libra','LIBRA.js','__LIBRA__','getLibraSourceEdits','libraSourceEdits'],['hayaku','HAYAKU_Locator_Continuity.js','HAYAKU','getHayakuSourceEdits','hayakuSourceEdits'],['flashback','Flashback_Memory.js','__FlashbackMemory','getFlashbackSourceEdits','flashbackSourceEdits']]){
 const p=await b.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.setContent('<html><meta name="viewport" content="width=device-width,initial-scale=1"><body></body></html>');await p.addScriptTag({path:path.join(__dirname,'hayaku_browser_host.js')});
 let source=fs.readFileSync(path.join(__dirname,'../../plugins',file),'utf8');
 const marker=`return ${controllerVar};`;
 assert.equal(source.split(marker).length,2);source=source.replace(marker,`globalThis.__trackingTest={controller:${controllerVar}};`+marker);
 await p.addScriptTag({content:source});await p.waitForFunction(a=>!!window[a],api);
 await p.evaluate(async({owner,api})=>{window.product=window[api];product.getSourceEditSyncStatus();if(owner==='libra')await product.openSettingsGui();else await product.showUi();},{owner,api});
 if(owner==='libra'){await p.locator('.libra-book-settings-button').click();await p.locator('.libra-book-settings-mobile-picker select').selectOption('debug');}
 if(owner==='hayaku')await p.locator('[data-hayaku-viewer-goto=recovery]').click();
 if(owner==='flashback')await p.locator('#tab-advanced').click();
 const select=p.locator('[data-source-tracking-controls] select:visible').first();await select.waitFor();
 const modes=await select.locator('option').evaluateAll(nodes=>nodes.map(node=>node.value));assert.deepEqual(modes,['auto','off'],owner+': GUI exposes only automatic processing and off');
 assert.equal(await select.inputValue(),'auto');
 await select.selectOption('off');await p.waitForFunction(()=>product.getSourceEditSyncStatus().mode==='off');
 await select.selectOption('auto');await p.waitForFunction(()=>product.getSourceEditSyncStatus().mode==='auto');
 await p.evaluate(async()=>{await __trackingTest.controller.beforeRequest();__trackingTest.controller.afterRequest();});
 const outcomes=await p.evaluate(async()=>({manual:await product.reviewSourceEdits(),direct:await __trackingTest.controller.review(),mode:product.getSourceEditSyncStatus().mode,
   modal:!!document.querySelector('#memorySuiteSourceReview'),dock:!!document.querySelector('[x-memory-suite-source-review-dock]'),dialog:!!document.querySelector('[x-memory-suite-source-edit-dialog]')}));
 assert.equal(outcomes.mode,'auto');assert.equal(outcomes.manual.reason,'automatic_before_request_only');assert.equal(outcomes.direct.reason,'automatic_before_request_only');
 assert.equal(outcomes.modal,false);assert.equal(outcomes.dock,false);assert.equal(outcomes.dialog,false);
 await p.evaluate(async()=>product.setSourceEditTrackingMode('notify'));
 assert.equal(await p.evaluate(()=>product.getSourceEditSyncStatus().mode),'auto','legacy notification modes normalize to automatic');
 assert.equal(await p.evaluate(()=>__hostCalls.llm),0);assert.deepEqual(errors,[]);
 console.log('PASS '+owner+': mobile GUI exposes auto/off only; public review is inert and beforeRequest creates no consent UI or model work');await p.close();
}
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
