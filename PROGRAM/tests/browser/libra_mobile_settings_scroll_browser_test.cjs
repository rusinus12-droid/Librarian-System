const path=require('path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({executablePath:(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'),headless:true});try{
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>');
 await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});await page.addScriptTag({path:path.join(__dirname,'../../plugins/LIBRA.js')});await page.waitForFunction(()=>!!globalThis.__LIBRA__);
 await page.evaluate(()=>__LIBRA__.openSettingsGui());await page.locator('.libra-book-settings-button').click();
 const cdp=await page.context().newCDPSession(page);
 for(const height of [844,667,568,390]){
  await page.setViewportSize({width:390,height});
  for(const section of ['ai','embedding','memory_analysis','server','recovery','transfer','logs']){
   await page.locator('.libra-book-settings-mobile-picker select').selectOption(section);await page.waitForTimeout(220);
   const dims=await page.locator('.libra-book-settings-native-content').evaluate(n=>({h:n.clientHeight,sh:n.scrollHeight,overflow:getComputedStyle(n).overflowY}));
   assert.equal(dims.overflow,'visible');assert(dims.h>=dims.sh-2,JSON.stringify({height,section,dims}));
  }
  await page.locator('.libra-book-settings-mobile-picker select').selectOption('server');await page.locator('.mscx-scope-root').waitFor();await page.waitForTimeout(200);
  const main=page.locator('.libra-book-app .sga-main');await main.evaluate(n=>n.scrollTop=0);
  const box=await main.boundingBox(),start=Math.min(height-100,box.y+box.height-100),end=Math.max(box.y+25,start-180);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:180,y:start}]});
  for(let y=start-15;y>=end;y-=15){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:180,y}]});await page.waitForTimeout(25);}
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(200);
  assert(await main.evaluate(n=>n.scrollTop)>20,'touch must scroll main at '+height);
  const apply=page.locator('.mscx-scope-root button').filter({hasText:'설정 적용'});await apply.scrollIntoViewIfNeeded();
  assert(await apply.evaluate(n=>{const r=n.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===n;}),'apply button reachable at '+height);
  assert(await page.getByRole('button',{name:'설정 화면 닫기',exact:true}).isVisible());
 }
 await page.setViewportSize({width:1440,height:1000});await page.waitForTimeout(200);
 assert.equal(await page.locator('.libra-book-settings-native-content').evaluate(n=>getComputedStyle(n).overflowY),'auto','desktop unchanged');
 assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>__writerHost.calls.model),0);
 console.log('PASS: seven settings sections, 390x844/667/568/390, real touch scroll, server apply hit target, desktop scroll preserved; zero model calls');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
