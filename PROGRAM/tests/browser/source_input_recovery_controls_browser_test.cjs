'use strict';
// Exact Full/Min product bytes, real browser input and layout. Host storage is
// ephemeral; no external model is used. Run once per SOURCE_INPUT_PLUGIN_DIR.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {resolveChromeExecutable}=require('../fixtures/browser_resolver.cjs');
const sources=process.env.SOURCE_INPUT_PLUGIN_DIR||path.join(__dirname,'../../plugins');
const out=process.env.SOURCE_INPUT_BROWSER_OUTPUT||path.join(os.tmpdir(),'source-input-recovery-controls');fs.mkdirSync(out,{recursive:true});
(async()=>{const browser=await chromium.launch({executablePath:resolveChromeExecutable(),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const results=[];
 try{for(const [owner,file,api] of [['hayaku','HAYAKU_Locator_Continuity.js','HAYAKU'],['flashback','Flashback_Memory.js','__FlashbackMemory']]){
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://localhost/**',route=>route.fulfill({body:'<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><body></body></html>',contentType:'text/html'}));
  await page.goto('http://localhost/controls');await page.addScriptTag({path:path.join(__dirname,'hayaku_browser_host.js')});
  await page.evaluate(()=>{__chat.message=[{role:'user',id:'u1',chatId:'u1',data:'Question'},{role:'assistant',id:'a1',chatId:'a1',data:'outside<original>keep<wrapper>wrapped</wrapper><drop>private</drop></original>'}];__chat.messages=__chat.message;window.hideCount=0;risuai.hideContainer=async()=>{hideCount++;return true;};});
  const source=path.join(sources,file);await page.addScriptTag({path:source});await page.waitForFunction(name=>!!window[name],api);
  await page.evaluate(async api=>{window.product=window[api];await product.showUi();},api);await page.locator('.topbar').waitFor();
  const close=page.locator(owner==='hayaku'?'#closeHayakuViewer':'#closeBtn');
  const measurements=[];
  for(const [width,height] of [[2556,1363],[1280,900],[900,1024],[641,900],[390,844],[320,640],[844,390]]){
   await page.setViewportSize({width,height});await page.waitForTimeout(30);
   const m=await page.locator('.topbar').evaluate(top=>{const rect=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};const close=top.querySelector('#closeHayakuViewer,#closeBtn'),app=top.closest('.app');return{app:rect(app),top:rect(top),close:rect(close),last:top.lastElementChild===close,hasIcon:!!close.querySelector('svg path,svg use'),overflow:top.scrollWidth-top.clientWidth};});
   assert.ok(m.last&&m.hasIcon,owner+': rightmost dedicated close has an actual icon');assert.ok(m.close.right<=m.top.right+1&&m.close.x>=m.top.x&&m.close.bottom<=m.top.bottom+1,owner+': close is in the header');assert.ok(m.overflow<=1,owner+': header fits '+width+': '+JSON.stringify(m));
   assert.ok(Math.abs(m.app.x+m.app.width/2-width/2)<=1&&Math.abs(m.app.y+m.app.height/2-height/2)<=1,owner+': centered window');
   const point=await close.evaluate(node=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});assert.ok(point,owner+': close accepts pointer input');measurements.push({width,height,...m});
  }
  await page.setViewportSize({width:390,height:844});
  if(owner==='hayaku'){await page.locator('.tabbar [data-go="recovery"]').click();await page.locator('[data-recovery-view="reanalysis"]').click();}
  else await page.locator('.tabbar [data-go="care"]').click();
  const controls=page.locator('[data-source-input-controls]:visible');await controls.locator('[data-source-input-add]').waitFor();await controls.locator('[data-source-input-add]').isEnabled();
  const before=await page.evaluate(()=>({...__hostCalls,raw:JSON.stringify(__chat)}));
  async function add(value,action){await controls.locator('[data-source-input-add]').click();const input=page.locator('[data-rule-value]:focus');await input.fill(value);const row=input.locator('xpath=ancestor::*[@data-source-input-row]');await row.locator('select').selectOption(action);return row;}
  await add('original','sourceTags');await add('wrapper','unwrapTags');const removed=await add('drop','ignoredTags');await removed.locator('[data-rule-delete]').click();
  await controls.locator('[data-source-input-undo]').click();
  assert.ok((await controls.locator('[data-rule-value]').evaluateAll(nodes=>nodes.map(n=>n.value))).includes('drop'));
  await controls.locator('[data-source-input-preview]').click();await page.waitForFunction(()=>[...document.querySelectorAll('[data-source-input-output]')].some(n=>!n.hidden&&n.textContent==='keepwrapped'));
  assert.equal(await page.evaluate(()=>__hostCalls.writes),before.writes,'draft and local preview do not save');
  await controls.locator('[data-source-input-apply]').click();await page.waitForFunction(()=>product.getSourceEditRules().sourceTags.includes('original'));
  const after=await page.evaluate(()=>({...__hostCalls,raw:JSON.stringify(__chat)}));assert.equal(after.llm,before.llm);assert.equal(after.network,before.network);assert.equal(after.raw,before.raw);assert.ok(after.writes>before.writes);
  await controls.locator('[data-source-input-defaults]').click();assert.ok(await page.evaluate(()=>product.getSourceEditRules().sourceTags.includes('original')),'factory reset remains draft');
  await controls.locator('[data-source-input-apply]').click();await page.waitForFunction(()=>!product.getSourceEditRules().sourceTags.length&&product.getSourceEditRules().ignoredTags.includes('thoughts'));
  await page.screenshot({path:path.join(out,owner+'-rules-mobile.png'),fullPage:true});
  if(owner==='flashback'){
   await page.evaluate(async()=>{await product.saveSettings({...await product.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',embeddingEnabled:true,autoEpisodeIndex:false});await product.ingestLiveChatColdStart({scope:'current',canonical:true});});
   await page.locator('#fbReanalysisRefresh').click();const range=page.locator('#fbReanalysisRanges input');await range.waitFor();await range.check();
   await page.locator('#fbReanalysisRun').click();let dialog=page.getByRole('dialog').filter({hasText:'원문 재분석 확인'});await dialog.waitFor();
   assert.match(await dialog.innerText(),/LLM·임베딩 호출은 0회/);assert.ok(await dialog.getByRole('button',{name:'취소',exact:true}).evaluate(n=>document.activeElement===n));
   await page.screenshot({path:path.join(out,'flashback-reanalysis-confirm-mobile.png'),fullPage:true});
   await dialog.getByRole('button',{name:'취소',exact:true}).click();await dialog.waitFor({state:'detached'});assert.match(await page.locator('#fbSourceEditStatus').innerText(),/취소/);
   await page.evaluate(()=>{__chat.message[1].data='Current original after explicit edit.';window.beforeReanalysisCalls={...__hostCalls};});
   await page.locator('#fbReanalysisRun').click();dialog=page.getByRole('dialog').filter({hasText:'원문 재분석 확인'});await dialog.waitFor();await dialog.getByRole('button',{name:'선택한 원문 교체',exact:true}).click();
   await page.waitForFunction(()=>/원문을 저장했습니다/.test(document.querySelector('#fbSourceEditStatus').textContent));assert.match(await page.locator('#fbSourceEditStatus').innerText(),/임베딩은 별도/);
   assert.ok(await page.evaluate(()=>__hostCalls.llm===beforeReanalysisCalls.llm&&__hostCalls.network===beforeReanalysisCalls.network));
  }
  const more=page.locator(owner==='hayaku'?'.topbar [data-menu]':'#topMoreBtn');await more.click();assert.ok(await page.locator('.topbar .menu__panel').isVisible());await more.click();
  const hides=await page.evaluate(()=>hideCount);await close.click();await page.waitForFunction(n=>hideCount===n+1,hides);assert.deepEqual(errors,[]);
  results.push({owner,sha256:crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),checks:measurements.length*5+10,measurements,pageErrors:errors});
  await page.evaluate(()=>__dispose());await page.close();
 }console.log(JSON.stringify({passed:results.reduce((sum,r)=>sum+r.checks,0),products:results.map(({measurements,...r})=>r)}));
 }finally{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
