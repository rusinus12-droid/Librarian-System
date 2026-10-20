'use strict';
// Actual product bytes (including Min) with owner-produced handoff state. All
// source turns/storage are synthetic and every external model call is blocked.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');const {lensFixture}=require('../fixtures/libra_lens_handoff_fixture.cjs');
(async()=>{
 const f=await lensFixture();let seed;
 try{const lens=await f.add();await f.api.updateLens(lens.lensId,{instruction:{goal:'이후 지침으로 변경'}});
  await f.api.prepareSessionHandoff({transferId:'browser-lens'});const chat=f.target();await f.api.adoptSessionHandoff({transferId:'browser-lens',targetChatId:chat.id});
  seed={values:[...f.r.values],chat,character:f.character,index:f.character.chatPage};
 }finally{await f.close();}
 const source=process.env.LIBRA_TEST_PLUGIN||path.join(__dirname,'../../plugins/LIBRA.js');
 const out=process.env.LIBRA_LENS_BROWSER_OUTPUT||path.join(os.tmpdir(),'libra-lens-handoff-browser');fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:width<600?844:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><body></body></html>');
  await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
  await page.evaluate(data=>{
   for(const [k,v]of data.values)__writerHost.values.set(k,v);
   Object.assign(__writerHost.chat,data.chat);Object.assign(__writerHost.character,data.character);
   risuai.getCurrentChatIndex=async()=>data.index;
   risuai.getChatFromIndex=async(_c,i)=>structuredClone(__writerHost.character.chats[i]);
   risuai.runLLMModel=async()=>{throw Error('Reading inherited lens notes must not call a provider');};
  },seed);
  await page.addScriptTag({path:source});await page.waitForFunction(()=>!!window.__LIBRA__);await page.evaluate(()=>__LIBRA__.openSettingsGui());await page.locator('.app[data-response-family="libra"]').waitFor();
  await page.locator('[data-go="memory"]:visible').first().click();await page.locator('[data-memory-reader-kind="lens"]').click();
  const group=page.locator('[data-lens-inherited-group]');await group.locator('.lens-item').waitFor();
  assert.match(await group.innerText(),/이전 대화에서 넘어온 기록/);assert.match(await group.innerText(),/이전 지침으로 생성/);
  assert.equal(await group.getByRole('button',{name:/항목 삭제/}).count(),0,'inherited items are read-only');
  await group.locator('.lens-prov summary').click();await group.locator('.lens-source mark').waitFor();await group.locator('.lens-diff').waitFor();
  assert.match(await group.locator('.lens-source').innerText(),/오늘 돌려주겠다고 약속했다/,'provenance uses the archived source even when the successor is empty');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(out,'inherited-'+width+'.png'),fullPage:true});assert.deepEqual(errors,[]);
  await page.evaluate(async()=>{for(const dispose of __writerHost.unload.slice().reverse())await dispose();});await page.close();
  console.log(JSON.stringify({test:'libra_lens_handoff_browser',width,readOnly:true,archivedProvenance:true,instructionDiff:true,pageErrors:errors}));
 }}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
