const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({executablePath:(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'),headless:true});try{
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.setContent('<html lang="ko"><body></body></html>');await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
let s=fs.readFileSync(path.join(__dirname,'../../plugins/LIBRA.js'),'utf8');const marker='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';assert(s.includes(marker));s=s.replace(marker,'  globalThis.__closeTest={Gui};\n'+marker);await page.addScriptTag({content:s});await page.waitForFunction(()=>!!globalThis.__LIBRA__);
for(const family of ['libra','gradia'])for(const width of [320,390,610,1440]){
await page.setViewportSize({width,height:844});await page.evaluate(f=>__LIBRA__.saveLibraProviderConfig({responseFamily:f}),family);await page.evaluate(()=>__LIBRA__.openSettingsGui());
const close=page.getByRole('button',{name:'설정 화면 닫기',exact:true});await close.waitFor({state:'visible'});const box=await close.boundingBox();assert(box.x>=0&&box.x+box.width<=width,JSON.stringify({width,box}));assert(box.y>=0&&box.y+box.height<844);
if(width<=760)assert(box.width>=44&&box.height>=44);
const before=await page.evaluate(()=>__writerHost.calls.hide);await close.click();await page.waitForFunction(()=>!__closeTest.Gui.visible);assert((await page.evaluate(()=>__writerHost.calls.hide))>before);
}
assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>__writerHost.calls.model),0);console.log('PASS: LIBRA/GRADIA close visible and clickable at 320/390/610/1440px; host hide called; zero model calls');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
