const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'),headless:true});
 try {
  const page=await browser.newPage({viewport:{width:900,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<html lang="ko"><body></body></html>');
  await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
  let source=fs.readFileSync(path.join(__dirname,'../../plugins/LIBRA.js'),'utf8');
  const marker='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';
  assert(source.includes(marker));source=source.replace(marker,'  globalThis.__inputTest={Gui,loadSettings,showLibraInputWriterComposer};\n'+marker);
  await page.addScriptTag({content:source});await page.waitForFunction(()=>!!globalThis.__LIBRA__);
  await page.evaluate(()=>__LIBRA__.saveLibraProviderConfig({stagePresetNames:{input_assist:'risuai_aux',ariadne:'risuai_aux'},nsfwMode:'off',nsfwGuidanceEnabled:true}));
  const open=()=>page.evaluate(()=>{globalThis.composition=__inputTest.showLibraInputWriterComposer();});
  await open();await page.getByLabel('NSFW 모드').selectOption('soft');
  await page.getByLabel('작성 모델 · LLM 프리셋').selectOption('');
  await page.getByRole('button',{name:'취소',exact:true}).click();
  assert.equal(await page.evaluate(async()=>(await __inputTest.loadSettings()).nsfwMode),'off');
  assert.equal(await page.evaluate(async()=>(await __inputTest.loadSettings()).stagePresetNames.input_assist),'risuai_aux');
  await open();await page.getByLabel('NSFW 모드').selectOption('soft');
  await page.getByLabel('작성 모델 · LLM 프리셋').selectOption('');
  await page.getByRole('button',{name:'대안 3개 만들기',exact:true}).click();await page.evaluate(()=>composition);
  let settings=await page.evaluate(()=>__inputTest.loadSettings());assert.equal(settings.nsfwMode,'soft');assert.equal(settings.nsfwGuidanceEnabled,true);assert.equal(settings.stagePresetNames.input_assist,'');assert.equal(settings.stagePresetNames.ariadne,'risuai_aux');
  for(const mode of ['rp','author'])for(const task of ['alternatives','polish']){
   const system=await page.evaluate(async({mode,task})=>(await __LIBRA__.debugBuildInputWriterPrompts({settings:{...(await __inputTest.loadSettings()),inputWriterMode:mode},originalInput:'문 앞에서 기다린다.',writerOptions:{task}})).system,{mode,task});
   assert.match(system,/NSFW GUIDANCE — SOFT/);assert.match(system,/candidate USER inputs/);assert.match(system,/LOCKED OUTPUT CONTRACT/);
  }
  {
   await page.evaluate(()=>__LIBRA__.saveLibraProviderConfig({nsfwGuidanceEnabled:false,stagePresetNames:{input_assist:'risuai_aux'}}));
   const system=await page.evaluate(async()=>(await __LIBRA__.debugBuildInputWriterPrompts({settings:await __inputTest.loadSettings()})).system);assert.doesNotMatch(system,/NSFW GUIDANCE/);
  }
  await open();assert.equal(await page.getByLabel('NSFW 모드').inputValue(),'soft');assert.equal(await page.getByLabel('NSFW 지침 적용').inputValue(),'false');assert.equal(await page.getByLabel('작성 모델 · LLM 프리셋').inputValue(),'risuai_aux');
  const out=process.env.LIBRA_INPUT_ARTIFACT_DIR;if(out){fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'composer.png')});}
  await page.getByRole('button',{name:'취소',exact:true}).click();await page.evaluate(()=>__LIBRA__.openSettingsGui());
  await page.locator('.libra-book-quick-button').click();const drawer=page.locator('.libra-book-drawer');await drawer.getByRole('tab',{name:'인풋',exact:true}).click();
  await drawer.getByText('NSFW 모드',{exact:true}).waitFor();
  const nsfw=drawer.locator('select').filter({has:page.locator('option[value="soft"]')});await nsfw.selectOption('direct');
  await drawer.locator('[data-gui-save-label="저장"]').click();await page.waitForFunction(()=>!__inputTest.Gui.dirty&&!__inputTest.Gui.bookQuickSaving);
  assert.equal(await page.evaluate(async()=>(await __inputTest.loadSettings()).nsfwMode),'direct');
  assert.equal(await page.evaluate(()=>__writerHost.calls.model),0);assert.equal(await page.evaluate(()=>__writerHost.calls.send.length),0);assert.deepEqual(errors,[]);
  console.log('PASS: composer save/cancel/reopen, model binding preservation, NSFW prompt modes/tasks/disabled, quick settings persistence, no model calls or sends');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
