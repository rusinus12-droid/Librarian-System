'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const out=process.env.GRADIA_MANUAL_SKILL_CAPTURES||'/tmp/gradia-style-cards';fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 try{
  await page.goto('about:blank');await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'gradia_browser_host.js'),'utf8')});
  await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../../plugins/GRADIA.js'),'utf8')});
  await page.waitForFunction(()=>!!window.__SerialGradationAgentsForRP);
  const open=async()=>{await page.evaluate(async()=>{await __SerialGradationAgentsForRP.openSettingsGui();await __SerialGradationAgentsForRP.debugNavigateGui('skills','flow');});await page.locator('[data-subtab="skill"]').click();};
  const save=async()=>{await page.locator('#savebar [data-save]').click();await page.waitForFunction(()=>!__SerialGradationAgentsForRP.debugGuiStateInfo().dirty);};
  const cancel=async()=>{await page.locator('#savebar [data-revert]').click();await page.waitForFunction(()=>!__SerialGradationAgentsForRP.debugGuiStateInfo().dirty);};
  await open();const panel=page.locator('[data-subpanel="skill"]'),manual=panel.locator('[data-skill-customize]');
  const openManual=async()=>{if(!await manual.evaluate(el=>el.open))await manual.locator(':scope > summary').click();};
  assert.equal(await panel.locator('[data-skill-genre-card]').count(),9);
  assert.equal(await page.locator('#lib-connect').isVisible(),false,'memory connection controls are outside the style view');
  assert.ok(!/10%|프레이밍|컴파일러|문맥 크기 미확인|자동 장르 판별/.test(await panel.innerText()));
  const presets=await page.evaluate(()=>__SerialGradationAgentsForRP.getSkillGenrePresets());
  for(const preset of presets){
   const button=panel.locator(`[data-skill-genre-details="${preset.id}"]`);await button.click();
   const dialog=page.locator('.skill-preset-dialog');assert.equal(await dialog.locator('h2').innerText(),preset.label);
   assert.equal(await dialog.locator('[data-genre-detail-skill]').count(),Object.values(preset.selections).reduce((n,ids)=>n+ids.length,0));
   assert.equal(await page.evaluate(()=>__SerialGradationAgentsForRP.debugGuiStateInfo().dirty),false,'viewing details does not select a style');
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await button.evaluate(el=>el===document.activeElement),true);
  }
  await openManual();const ids=['physical-conflict','quiet-interior-beat'];
  for(const id of ids)await panel.locator(`[data-skill-selected="${id}"]`).check();
  const refId=await page.evaluate(()=>__SerialGradationAgentsForRP.getSkillLibrary()['physical-conflict'].references[0].id);
  const row=panel.locator('[data-skill-id="physical-conflict"]').first();await row.locator('details summary').click();await row.locator(`[data-skill-reference="${refId}"]`).check();await save();
  await page.evaluate(()=>__SerialGradationAgentsForRP.closeSettingsGui());await open();await openManual();
  for(const id of ids)assert.equal(await panel.locator(`[data-skill-selected="${id}"]`).isChecked(),true);
  assert.equal(await panel.locator(`[data-skill-id="physical-conflict"] [data-skill-reference="${refId}"]`).isChecked(),true);
  await page.locator('#skill-stage-filter').selectOption('aide_world');assert.equal(await panel.locator('[data-skill-selected="physical-conflict"]').isChecked(),false);
  await panel.locator('[data-skill-selected="physical-conflict"]').check();await cancel();await page.locator('#skill-stage-filter').selectOption('shadow_act');
  await panel.locator('[data-skill-genre-details="mystery"]').click();await page.locator('.skill-preset-dialog [data-skill-genre-apply="stage"]').click();
  assert.equal(await panel.locator('[data-skill-selected="genre-lens"]').isChecked(),true);
  assert.equal(await panel.locator('[data-skill-reference="mystery-deduction-lens"]').isChecked(),true);await cancel();
  await panel.locator('[data-skill-genre-card="mystery"] [data-skill-genre-apply="all"]').click();await save();
  const saved=await page.evaluate(()=>__SerialGradationAgentsForRP.getRuntimeSettings());assert.deepEqual(saved.skill_stage_selections.shadow_act,['genre-lens','information-exchange']);
  assert.equal(await panel.locator('[data-skill-genre-card="mystery"]').evaluate(el=>el.classList.contains('is-selected')),true);
  await panel.locator('[data-skill-genre-card="everyday"] [data-skill-genre-apply="all"]').click();await save();
  for(const [width,height,label]of [[1440,1000,'desktop'],[820,1000,'tablet'],[390,844,'mobile'],[320,640,'narrow'],[844,390,'landscape']]){
   await page.setViewportSize({width,height});await openManual();await panel.locator('#skill-search').scrollIntoViewIfNeeded();
   const search=await panel.locator('#skill-search').boundingBox();assert.ok(search.width>=120,`${label}: search remains usable`);
   const fit=await panel.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,rows:[...el.querySelectorAll('.skill-row')].map(row=>({width:row.clientWidth,scroll:row.scrollWidth}))}));
   assert.ok(fit.scroll<=fit.width+2,JSON.stringify({label,...fit}));assert.ok(fit.rows.every(row=>row.scroll<=row.width+2));
   await manual.locator(':scope > summary').click();await panel.locator('.skill-style-heading').evaluate(el=>el.scrollIntoView({block:'start'}));
   const cards=await panel.locator('.skill-presets-grid').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,columns:getComputedStyle(el).gridTemplateColumns.split(' ').length}));
   assert.ok(cards.scroll<=cards.width+2);assert.equal(cards.columns,label==='desktop'?2:1,`${label}: responsive genre cards`);
   if(['desktop','tablet','mobile'].includes(label))await page.screenshot({path:path.join(out,`genre-presets-${label}.png`)});
   await panel.locator('[data-skill-genre-details="mystery"]').click();const dialog=page.locator('.skill-preset-dialog');
   await page.waitForFunction(()=>document.activeElement?.classList.contains('genre-dialog-close'));
   const titleBounds=await dialog.locator('h2').boundingBox();const bounds=await dialog.boundingBox();assert.ok(titleBounds.y>=bounds.y&&titleBounds.y+titleBounds.height<=bounds.y+bounds.height,'popup opens at its title');assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=width+1&&bounds.y+bounds.height<=height+1);
   assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+2),`${label}: popup fits without clipping`);
   if(['desktop','mobile'].includes(label))await page.screenshot({path:path.join(out,`genre-details-${label}.png`)});
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  }
  assert.equal(await page.evaluate(()=>__networkCalls),0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({test:'gradia_genre_cards_mounted_browser',passed:true,captures:out}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
