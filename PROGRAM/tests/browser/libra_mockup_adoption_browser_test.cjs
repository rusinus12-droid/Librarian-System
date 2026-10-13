'use strict';
// LIBRA product source mounted in the approved mockup shell. Synthetic host only.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');const crypto=require('node:crypto'),vm=require('node:vm');
const {serverFixture}=require('../fixtures/libra_server_runtime_fixture.cjs');
const root=path.resolve(__dirname,'../..');
const outputs=process.argv[2]||'/tmp/libra-mockup-adoption';
const mockPath=path.join(root,'docs/gui-redesign/libra.html');
const css=[path.join(root,'docs/gui-redesign/assets/suite.css'),path.join(root,'docs/gui-redesign/assets/themes.css')].map(p=>fs.readFileSync(p,'utf8')).join('\n');
const inline=fs.readFileSync(mockPath,'utf8').match(/<style>([\s\S]*?)<\/style>/)?.[1]||'';
const pages=['desk','memory','people','world','story','settings'];
async function syntheticPortableEnvelope(){
  const snapshot=await serverFixture({mode:'plugin_only'});
  try{
    await snapshot.f.r.api.runManualColdStart({});
    const api=snapshot.f.r.context.__LIBRAPortableMemoryBackup;
    assert.ok(api,'synthetic fixture exposes the production portable backup API');
    for(let attempt=0;attempt<40;attempt++){
      try{return await api.exportCurrentScope();}
      catch(error){if(!/BUSY/.test(String(error?.code||'')))throw error;await new Promise(resolve=>setTimeout(resolve,250));}
    }
    throw new Error('synthetic portable backup stayed busy');
  }finally{await snapshot.cleanup();}
}
(async()=>{
  const envelope=await syntheticPortableEnvelope();
  fs.mkdirSync(outputs,{recursive:true});
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const reference=await browser.newPage({viewport:{width:1280,height:900}});
    let markup=fs.readFileSync(mockPath,'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link rel="stylesheet" href="assets\/(?:suite|themes)\.css">/g,'');
    markup=markup.replace('</head>',`<style>${css}\n${inline}</style></head>`).replace('<body class="t-libra">','<body class="t-libra">').replace(/<div class="proto-bar">[\s\S]*?<\/div>/,'');
    await reference.setContent(markup);await reference.waitForSelector('.app');
    const iconLiteral=fs.readFileSync(path.join(root,'docs/gui-redesign/assets/suite.js'),'utf8').match(/var ICONS = (\{[\s\S]*?\n  \});/)[1];
    await reference.evaluate(icons=>{document.querySelectorAll('[data-i]').forEach(node=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('class','ic'+(node.dataset.size?' ic--'+node.dataset.size:''));svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.innerHTML=icons[node.dataset.i]||'';node.replaceWith(svg);});},vm.runInNewContext('('+iconLiteral+')'));

    // Reproduce only the original view navigation builder; no demo handlers/timers.
    await reference.evaluate(()=>{const primary=[...document.querySelectorAll('.sidebar .nav-item[data-go]')].filter(n=>n.dataset.tab!=='top'),cap=primary.length>5?4:primary.length,bar=document.querySelector('.tabbar');bar.replaceChildren();primary.slice(0,cap).forEach(node=>{const button=document.createElement('button');button.type='button';button.dataset.go=node.dataset.go;button.setAttribute('aria-current',node.dataset.go==='desk'?'page':'false');button.append(node.querySelector('svg').cloneNode(true),document.createTextNode(node.dataset.short||node.querySelector('.nav-text').textContent));bar.appendChild(button);});});
    const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<html lang="ko"><body></body></html>');await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
    let source=fs.readFileSync(path.join(root,'plugins/LIBRA.js'),'utf8');
    const sourceSha256=crypto.createHash('sha256').update(source).digest('hex');
    const needle='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';
    assert.ok(source.includes(needle));source=source.replace(needle,'  globalThis.__mockupAudit={Gui,LibraMemoryCore,renderCanonicalJobSurface,openApprovedPromptDialog,openWorldManagerCorrectionEditor,promptStudioEnsureDraft,savePromptStudioDraft,easyPromptUseDefault,promptStudioProfiles,loadSettings,runStateReplayMaintenance,renderSettingsGui,bookSelectPeopleSection,bookSelectWorldSection,bookSelectStorySection,selectBookSettingsRoomSection,confirmApprovedOperation,openApprovedRecoveryDialog,openApprovedCorrectionsDialog,buildApprovedRecoveryActions};\n'+needle);
    await page.addScriptTag({content:source});await page.waitForFunction(()=>!!window.__LIBRA__);await page.evaluate(async()=>__LIBRA__.openSettingsGui());
    const bodyComparisons=[];
    const shell=(ctx)=>ctx.evaluate(()=>{const r=s=>document.querySelector(s)?.getBoundingClientRect().toJSON();const app=document.querySelector('.app'),g=getComputedStyle(app);return{app:r('.app'),top:r('.topbar'),side:r('.sidebar'),main:r('.main'),tokens:{accent:g.getPropertyValue('--accent').trim(),surface:g.getPropertyValue('--surface').trim(),side:g.getPropertyValue('--side-bg').trim(),type:g.getPropertyValue('--font-display').trim()}}});
    for(const width of [1280,1024,900,820,640,390]){
      await page.setViewportSize({width,height:900});await reference.setViewportSize({width,height:900});
      await page.waitForTimeout(80);
      const actual=await shell(page),expected=await shell(reference);
      assert.ok(actual.app.width>0&&actual.app.height>0,`app visible at ${width}`);
      for(const key of ['accent','surface','side','type'])assert.equal(actual.tokens[key],expected.tokens[key],`${key} token at ${width}`);
      assert.ok(Math.abs(actual.app.width-expected.app.width)<=2,`mockup frame width at ${width}: ${actual.app.width} vs ${expected.app.width}`);
      await page.screenshot({path:path.join(outputs,`desk-${width}.png`),fullPage:true});
      await reference.screenshot({path:path.join(outputs,`reference-desk-${width}.png`),fullPage:true});
    }
    const initialText=await page.locator('.app').textContent();for(const sample of ['북쪽 정원 기록실','북쪽 정원의 기록실','M-25','(표본)','(시안)'])assert.ok(!initialText.includes(sample),`all mounted shell and modal content excludes sample ${sample}`);
    // The approved sidebar is intentionally replaced by the mobile tabbar at 640px.
    // Return to desktop before using sidebar-only selectors for destination traversal.
    await page.setViewportSize({width:1280,height:900});
    for(const dest of pages){
      await reference.evaluate(value=>{document.querySelectorAll('.page[data-page]').forEach(node=>{node.classList.toggle('is-active',node.dataset.page===value);node.hidden=node.dataset.page!==value;});document.querySelectorAll('.sidebar [data-go],.tabbar [data-go]').forEach(node=>node.setAttribute('aria-current',node.dataset.go===value?'page':'false'));},dest);
      await page.locator(`.sidebar [data-go="${dest}"]`).click();
      await page.waitForFunction(value=>window.__mockupAudit.Gui.bookPage===value,dest);
      await page.locator(`.page[data-page="${dest}"] [data-libra-product-detail="${dest}"]`).waitFor();
      assert.equal(await page.locator('.page.is-active').getAttribute('data-page'),dest);
      const required={desk:['.spread','.banner'],memory:['.rail','.sheet-page'],people:['.rail','.sheet-page'],world:['.grid.g3'],story:['.grid.g-side.g-side--r','.card.card--accent'],settings:['.settings-layout','.setnav']}[dest];
      for(const selector of required)assert.ok(await page.locator(`.page[data-page="${dest}"] ${selector}`).count()>0,`${dest} mockup structure ${selector}`);
      const visibleText=await page.locator(`.page[data-page="${dest}"]`).innerText();
      for(const sample of ['북쪽 정원 기록실','은색 열쇠','M-25','보름달 개방 조건'])assert.ok(!visibleText.includes(sample),`${dest} contains no mockup sample ${sample}`);
      for(const width of [1280,1024,900,820,640,390]){
        await page.setViewportSize({width,height:900});await reference.setViewportSize({width,height:900});
        await page.waitForTimeout(60);
        const productFrame=await shell(page),mockupFrame=await shell(reference);
        assert.ok(Math.abs(productFrame.app.width-mockupFrame.app.width)<=2,`${dest} frame width at ${width}`);
        const geometry=ctx=>ctx.evaluate(()=>{const page=document.querySelector('.page.is-active');const el=selector=>{const n=page?.querySelector(selector);if(!n)return null;const r=n.getBoundingClientRect(),g=getComputedStyle(n);return{width:r.width,height:r.height,gap:g.gap,columns:g.gridTemplateColumns,font:g.fontFamily,background:g.backgroundColor}};return{page:el(':scope'),head:el('.page-head'),primary:el('.spread,.grid.g-side,.settings-layout,.stack'),rail:el('.rail,.setnav'),sheet:el('.sheet-page,.leaf,.card')};});
        bodyComparisons.push({destination:dest,width,product:await geometry(page),reference:await geometry(reference),state:'production synthetic empty/readback vs source mockup demo; body geometry comparison, not matched-state pixel parity'});
        await page.screenshot({path:path.join(outputs,`${dest}-${width}.png`),fullPage:true});
        await reference.screenshot({path:path.join(outputs,`reference-${dest}-${width}.png`),fullPage:true});
      }
      await page.setViewportSize({width:1280,height:900});
    }
    for(const [dest,section] of [['people','characters'],['world','details'],['story','structure']]){
      await page.evaluate(([dest,section])=>{const audit=__mockupAudit;if(dest==='people')audit.bookSelectPeopleSection(section);else if(dest==='world')audit.bookSelectWorldSection(section);else audit.bookSelectStorySection(section);},[dest,section]);
      const fold=page.locator(`[data-product-management="${dest}"]`);await fold.waitFor();await fold.locator(':scope > summary').click();
      await fold.locator('[data-world-detail-management]').waitFor();
      assert.ok(await fold.locator('.fold__body').count(),'management builds canonical folded controls');
    }
    await page.locator('.sidebar [data-go="desk"]').click();
    await page.locator('.page[data-page="desk"] [data-open="dlg-range"]').click();
    const range=page.locator('[data-canonical-range-drawer]');await range.waitFor();
    assert.ok(await range.locator('.dialog[aria-label="기억 생성 구간 선택"]').count()>0,'range selector uses approved mockup dialog');
    assert.ok(await range.locator('.seglist').count()>0,'range selector uses approved mockup segment rows');
    const matched=[];
    const scalar=await range.evaluate(node=>Object.fromEntries(['dg-t','kind-hint','range-n','range-calls','range-effect'].map(id=>[id,node.querySelector('#'+id).textContent])));
    const segments=await range.locator('.segrow').evaluateAll(nodes=>nodes.map(node=>({title:node.querySelector('b').textContent,small:node.querySelector('small').textContent,badge:node.querySelector('.badge').textContent,badgeClass:node.querySelector('.badge').className,disabled:node.querySelector('input').disabled})));
    await reference.evaluate(({scalar,segments})=>{const overlay=document.querySelector('#dlg-range');overlay.classList.add('is-open');overlay.setAttribute('aria-hidden','false');for(const[id,value]of Object.entries(scalar))overlay.querySelector('#'+id).textContent=value;const list=overlay.querySelector('#seglist'),seed=list.querySelector('.segrow').cloneNode(true);list.replaceChildren();for(const data of segments){const row=seed.cloneNode(true);row.querySelector('b').textContent=data.title;row.querySelector('small').textContent=data.small;row.querySelector('.badge').textContent=data.badge;row.querySelector('.badge').className=data.badgeClass;row.querySelector('input').disabled=data.disabled;row.setAttribute('aria-disabled',String(data.disabled));list.appendChild(row);}overlay.querySelector('#regen-one').hidden=true;overlay.querySelector('#range-go').disabled=true;}, {scalar,segments});
    const dialogMetrics=ctx=>ctx.evaluate(()=>{const dialog=document.querySelector('#dlg-range .dialog');return [...dialog.querySelectorAll(':scope > .field,:scope > .seglist,:scope > .cost-table,:scope > .dialog__actions')].map(node=>{const r=node.getBoundingClientRect(),g=getComputedStyle(node);return{className:node.className,width:r.width,height:r.height,gap:g.gap,font:g.fontFamily};});});
    for(const width of [1280,900,640,390]){await page.setViewportSize({width,height:900});await reference.setViewportSize({width,height:900});const actual=await dialogMetrics(page),expected=await dialogMetrics(reference);assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++){assert.equal(actual[i].className,expected[i].className);assert.equal(actual[i].font,expected[i].font);assert.ok(Math.abs(actual[i].width-expected[i].width)<=2,'same-state literal range body width');assert.ok(Math.abs(actual[i].height-expected[i].height)<=2,`same-state literal range body height ${width} ${i}: ${JSON.stringify({actual:actual[i],expected:expected[i]})}`);}matched.push({width,actual,expected});await page.screenshot({path:path.join(outputs,`range-same-state-product-${width}.png`)});await reference.screenshot({path:path.join(outputs,`range-same-state-reference-${width}.png`)});}
    fs.writeFileSync(path.join(outputs,'range-same-state-body.json'),JSON.stringify({sourceSha256,primitiveState:{scalar,segments},comparisons:matched,method:'Original source dialog DOM hydrated with identical scalar text and segment state; no product DOM copied.'},null,2));
    await reference.evaluate(()=>document.querySelector('#dlg-range').classList.remove('is-open'));await page.setViewportSize({width:1280,height:900});
    await page.keyboard.press('Escape');await range.waitFor({state:'detached'});
    // Same-job task tray regression: minimizing/reopening preserves the captured job identity.
    await page.evaluate(()=>{
      const job={jobId:'synthetic-libra-job-1',kind:'canonical_missing',state:'awaiting_choice',scopeKey:__mockupAudit.LibraMemoryCore.peekSnapshot()?.scope?.scopeKey,currentStart:1,total:1,completed:0,failed:0,skipped:0,message:'Synthetic comparison; no storage write.'};
      __mockupAudit.Gui.canonicalJobDismissedId='';__mockupAudit.Gui.canonicalJobMinimized=false;
      __mockupAudit.Gui.canonicalJobObservedIds.add(job.jobId);__mockupAudit.Gui.canonicalJob=job;
      __mockupAudit.renderCanonicalJobSurface(job);
    });
    await page.locator('[data-canonical-job-portal] .dialog[aria-label="정본 기억 작업"]').waitFor();
    assert.equal(await page.locator('[data-canonical-job-portal]').getAttribute('class'),'overlay is-open');
    const jobButtonTexts=await page.locator('[data-canonical-job-portal] button').allTextContents();
    assert.ok(jobButtonTexts.some(text=>text.includes('최소화')),`job minimize control present: ${JSON.stringify(jobButtonTexts)} / ${await page.locator('[data-canonical-job-portal]').innerText()}`);
    await page.locator('[data-canonical-job-portal] button').filter({hasText:'최소화'}).click();
    const tray=page.locator('[data-canonical-job-chip]');await tray.waitFor();
    assert.equal(await tray.getAttribute('data-canonical-job-id'),'synthetic-libra-job-1');
    assert.equal(await tray.evaluate(node=>node.parentElement.classList.contains('grow')),true,'minimized task is placed in the visible mockup topbar growth area');
    await tray.click();await page.locator('[data-canonical-job-portal] .dialog[aria-label="정본 기억 작업"]').waitFor();
    assert.equal(await page.locator('[data-canonical-job-portal] [data-job-msg]').innerText(),'Synthetic comparison; no storage write.');

    for(const state of ['preparing','running','cancel_requested','adopting','interrupted','completed','completed_with_warnings','failed','cancelled','original_kept']){
      await page.evaluate(state=>{const audit=__mockupAudit,job={jobId:'synthetic-job-state-'+state,kind:'manual_scan',state,scopeKey:audit.LibraMemoryCore.peekSnapshot()?.scope?.scopeKey,currentStart:1,total:2,completed:state==='completed'?2:0,failed:state==='failed'?1:0,skipped:0,currentStage:state==='running'?'librarian':'',message:'Actual job-state fixture '+state,cancellable:true};audit.Gui.canonicalJobDismissedId='';audit.Gui.canonicalJobMinimized=false;audit.Gui.canonicalJobObservedIds.add(job.jobId);audit.Gui.canonicalJob=job;audit.LibraMemoryCore.state.canonicalJob=job;audit.renderCanonicalJobSurface(job);},state);
      const task=page.locator('#job-memory[data-canonical-job-portal]');await task.waitFor();
      assert.equal(await task.locator('.steps .step').count(),5,'literal approved job stage body retained');
      assert.ok((await task.locator('[data-job-msg]').innerText()).includes(state),'job message is actual state data');
      await task.getByRole('button',{name:'최소화',exact:true}).click();
      const chip=page.locator('[data-canonical-job-chip]');await chip.waitFor();
      await page.locator('.sidebar [data-go="world"]').click();await chip.waitFor();await chip.click();await task.waitFor();
      assert.equal(await task.getAttribute('data-canonical-job-id'),'synthetic-job-state-'+state,'all-state job identity retained across destinations');
      if(['completed','completed_with_warnings','failed','cancelled','original_kept'].includes(state))assert.ok(await task.locator('[data-job-result]:visible').count(),'observed terminal results remain visible');
      await page.evaluate(()=>{__mockupAudit.Gui.canonicalJob=null;__mockupAudit.LibraMemoryCore.state.canonicalJob=null;__mockupAudit.renderCanonicalJobSurface(null);});
    }
    await page.evaluate(()=>{__mockupAudit.Gui.canonicalJob=null;__mockupAudit.LibraMemoryCore.state.canonicalJob=null;__mockupAudit.renderCanonicalJobSurface(null);});
    await page.evaluate(()=>{const audit=__mockupAudit,job={jobId:'synthetic-candidate-choice',scopeKey:audit.LibraMemoryCore.peekSnapshot()?.scope?.scopeKey,kind:'regenerate',state:'awaiting_choice',currentStart:1,total:1,comparison:{active:{text:'Synthetic saved canonical',revision:1},candidate:{text:'Synthetic independent candidate',revision:2,manualAuthority:false},beforeState:{}}};audit.Gui.canonicalJobDismissedId='';audit.Gui.canonicalJobMinimized=false;audit.Gui.canonicalJob=job;audit.LibraMemoryCore.state.canonicalJob=job;audit.renderCanonicalJobSurface(job);});
    await page.locator('#job-memory').getByRole('button',{name:'후보 비교 후 정본 채택…',exact:true}).click();const promote=page.locator('#dlg-promote');await promote.waitFor();assert.equal(await promote.locator('.grid.g2 .note').count(),2,'candidate uses literal separate comparison overlay');assert.ok((await promote.innerText()).includes('Synthetic independent candidate'));
    await promote.evaluate(node=>node.dataset.candidateScope='wrong-scope');await promote.getByRole('button',{name:'후보 채택',exact:true}).click();assert.equal(await page.evaluate(()=>__mockupAudit.LibraMemoryCore.state.canonicalJob.state),'awaiting_choice','mismatched candidate overlay cannot adopt');await page.keyboard.press('Escape');await promote.waitFor({state:'detached'});await page.evaluate(()=>{__mockupAudit.Gui.canonicalJob=null;__mockupAudit.LibraMemoryCore.state.canonicalJob=null;__mockupAudit.renderCanonicalJobSurface(null);});
    await page.locator('.topbar [data-open="drawer-quick"]').click();
    const quick=page.locator('#drawer-quick');await quick.waitFor();
    assert.ok(await quick.locator('.drawer__head').count()>0,'quick settings uses approved mockup drawer head');
    assert.ok(await quick.locator('.drawer__body').count()>0,'quick settings uses approved mockup drawer body');
    assert.ok(await quick.locator('.drawer__foot.savebar').count()>0,'quick settings retains persistence controls in mockup drawer footer');
    assert.equal(await quick.locator('.libra-book-drawer,.libra-book-drawer-backdrop').count(),0,'no legacy quick settings wrapper');
    await quick.evaluate(node=>node.dataset.ownedDrawerProbe='original');await page.evaluate(()=>__mockupAudit.renderSettingsGui());assert.equal(await page.locator('#drawer-quick').count(),1,'routine refresh cannot duplicate the owned drawer');assert.equal(await page.locator('#drawer-quick').getAttribute('data-owned-drawer-probe'),'original','implicit main refresh retains drawer identity and controls');
    await quick.locator('[data-book-quick-close]').click();
    await page.evaluate(()=>__mockupAudit.openApprovedPromptDialog());
    const prompt=page.locator('#dlg-prompt');await prompt.waitFor();
    assert.ok((await prompt.getAttribute('class')).includes('is-open'),'prompt uses the approved original mockup dialog');
    assert.ok(await prompt.locator('[data-product-prompt-studio]').count(),'prompt dialog mounts the real prompt-profile editor');
    assert.ok(await prompt.getByText('저장만',{exact:true}).count(),'real prompt profile save action remains reachable');
    assert.ok(!(await prompt.innerText()).includes('(표본)'),'prompt dialog contains no mockup sample text');
    const promptReadback=await page.evaluate(async()=>{
      const audit=window.__mockupAudit,name='synthetic-browser-profile';
      audit.Gui.promptStudioProfileName=name;audit.Gui.promptStudioDraftKey='';audit.Gui.promptStudioDraft=null;
      audit.promptStudioEnsureDraft(true).name=name;
      await audit.savePromptStudioDraft(false);
      const saved=JSON.stringify(audit.Gui.state.promptProfiles||{}).includes(name);
      await audit.easyPromptUseDefault();
      const profiles=audit.promptStudioProfiles();
      return {saved,activeDefault:profiles.activeMemoryProfile==='default'};
    });
    assert.deepEqual(promptReadback,{saved:true,activeDefault:true},'actual prompt save/readback and reset-to-default paths persist synthetic settings');
    await prompt.getByRole('button',{name:'닫기'}).click();
    await page.evaluate(()=>{
      const row={id:'synthetic-character-1',name:'Synthetic Aster',aliases:['Aster'],state:{traits:['careful']}};
      const view={throughTurn:5,basis:{sourceFingerprint:'synthetic-fingerprint'},head:{},characters:[row],world:[],relationships:[],narrative:{}};
      __mockupAudit.openWorldManagerCorrectionEditor('characters',row,view);
    });
    const correction=page.locator('#dlg-correct');await correction.waitFor();
    assert.ok((await correction.getAttribute('class')).includes('is-open'),'correction uses approved original mockup dialog');
    assert.ok((await correction.innerText()).includes('Synthetic Aster'),'correction target is hydrated from the real selected product record');
    assert.ok(await correction.locator('[data-correction-save]').count(),'actual correction save/readback handler remains reachable');
    await correction.evaluate(node=>{node.dataset.correctionRecordId='synthetic-wrong-target';});
    await correction.locator('[data-correction-save]').click();
    await page.waitForFunction(()=>document.querySelector('#dlg-correct [data-correction-error]')?.textContent.includes('교정 대상이 열었던 기록과 달라졌습니다'));
    await page.evaluate(()=>{
      const overlay=document.querySelector('#dlg-correct');overlay.dataset.correctionRecordId='synthetic-character-1';
      __mockupAudit.Gui.worldManagerEditDraft.scopeKey='synthetic-other-scope';
    });
    await correction.locator('[data-correction-save]').click();
    await page.waitForFunction(()=>document.querySelector('#dlg-correct [data-correction-error]')?.textContent.includes('채팅 또는 scope가 바뀌었습니다'));
    await correction.locator('[data-correction-cancel]').click();
    await correction.waitFor({state:'hidden'});
    await page.locator('.sidebar [data-go="settings"]').click();
    const settingsPage=page.locator('.page[data-page="settings"]');
    assert.equal(await settingsPage.locator('.setnav button').count(),5,'settings navigation preserves the original mockup five-category structure');
    const settingsRoutes=[
      ['AI 연결','ai'],['AI 연결','embedding'],['기억과 검색','memory'],['기억과 검색','pipeline'],['기억과 검색','logs'],
      ['참고 자료','references'],['참고 자료','source_edits'],['저장과 백업','server'],['저장과 백업','recovery'],['저장과 백업','transfer'],['복구 · 진단','state'],['복구 · 진단','general']
    ];
    for(const [group,section] of settingsRoutes){
      await settingsPage.locator('.setnav button').filter({hasText:group}).click();
      await page.waitForTimeout(30);
      if(!['ai','memory','references','server','state'].includes(section)) await settingsPage.locator('.tabs button').filter({hasText:({ai:'AI 연결',embedding:'임베딩 연결',memory:'성능 프리셋',pipeline:'기억 분석',logs:'기록 보관소',references:'참고 자료',source_edits:'분석할 내용',server:'서버 · 저장',recovery:'백업 · 복구',transfer:'데이터 이동',state:'현재 상태 적용',general:'일반 · 진단'})[section]}).click();
      await page.waitForFunction(value=>document.querySelector('.page[data-page="settings"] [data-product-settings-section]')?.getAttribute('data-product-settings-section')===value,section);
      assert.equal(await settingsPage.locator('[data-product-settings-section]').getAttribute('data-product-settings-section'),section,`settings section ${section} remains reachable`);
      const host=settingsPage.locator(`[data-product-settings-section="${section}"]`);
      const controls={pipeline:'[data-librarian-analyzer] [data-analyzer-field="presetName"]',logs:'[data-execution-kind]',references:'[data-reference-settings] .setting',source_edits:'[data-source-input-controls]',state:'[data-state-replay-maintenance]',transfer:'[data-configuration-transfer="json"]',general:'[data-diagnostic-field="section"]'};
      if(controls[section])await host.locator(controls[section]).first().waitFor();
      if(section==='pipeline'){
        await host.locator('.fold > summary').first().click();
        const input=host.locator('[data-analyzer-field="maxChars"]');await input.fill('19000');await input.dispatchEvent('input');
        assert.equal(await host.locator('[data-analyzer-reference]').count(),4,'analyzer references preserved');
        assert.equal(await host.locator('[data-generation-policy="v1"] select').count(),3,'all existing generation policy controls preserved');await host.locator('[data-instruction-settings] > summary').click();assert.equal(await host.locator('[data-instruction-settings] > .fold__body > .field select').count(),2,'existing NSFW/profile selectors remain reachable');assert.ok(await host.locator('[data-instruction-field]').count()>0,'existing individual response instruction controls preserved');
      }
      if(section==='logs')assert.equal(await host.locator('[data-execution-kind]').count(),6,'six real execution receipt kinds remain selectable');
      if(section==='references'){
        await page.evaluate(()=>{__mockupAudit.Gui.moduleCatalogLoadedAt=Date.now();__mockupAudit.Gui.characterLoreCatalogLoadedAt=Date.now();__mockupAudit.Gui.characterLoreCatalogLoading=true;__mockupAudit.Gui.moduleCatalog=[{key:'synthetic-module',name:'Synthetic Module',active:true,loreCount:1,loreEntries:[{key:'synthetic-lore',name:'Synthetic Lore',contentPreview:'Synthetic only'}]}];__mockupAudit.Gui.characterLoreCatalog=[{key:'synthetic-character-lore',name:'Synthetic Character Lore'}];});
        await host.getByRole('button',{name:'선택…',exact:true}).click();
        const module=host.locator('[data-module-lore-module-toggle="synthetic-module"]');await module.check();
        await page.waitForTimeout(40);
        await host.locator('[data-reference-controls="modules"] .fold > summary').click();
        assert.ok(await page.evaluate(()=>__mockupAudit.Gui.state.runtime.selectedModuleLoreIds.includes('synthetic-module')),'module selection updates draft');await host.locator('[data-module-lore-entry-toggle="synthetic-lore"]').uncheck();assert.ok(await page.evaluate(()=>__mockupAudit.Gui.state.runtime.excludedModuleLoreIds.includes('synthetic-lore')),'individual lore exclusion updates actual runtime draft');
        await host.getByRole('button',{name:'제외 관리…',exact:true}).click();
        await host.locator('[data-character-lore-exclude="synthetic-character-lore"]').check();await page.evaluate(()=>{__mockupAudit.Gui.characterLoreCatalogLoading=false;});
      }
      if(section==='source_edits'){
        await host.locator('[data-source-input-row]').first().waitFor();
        assert.ok(await host.locator('[data-source-input-apply]').count(),'actual source rules apply handler reachable');
        assert.ok(await host.locator('[data-source-input-preview]').count(),'actual source rules preview handler reachable');
      }
      if(section==='state'){
        assert.equal(await host.locator('[data-recovery-kind]').count(),5,'five original recovery action kinds remain reachable');
        for(const kind of ['state','correction','rebuild','receipt','micro']){
          await host.locator(`[data-recovery-kind="${kind}"]`).click();
          const recovery=page.locator(kind==='correction'?'#dlg-corr-life':'#dlg-recover');await recovery.waitFor();
          assert.ok(await recovery.locator('.dialog').count(),'recovery uses original approved dialog body');
          if(kind!=='correction'){
            assert.ok(await recovery.locator('.cost-table').count(),'recovery cost and impact use original body');
            assert.ok(!(await recovery.textContent()).includes('T120'),'recovery never mounts demo boundaries');
          }
          await recovery.getByRole('button',{name:'닫기',exact:true}).click();await recovery.waitFor({state:'detached'});
        }
        await host.locator('[data-recovery-kind="state"]').focus();
        await page.evaluate(()=>{void __mockupAudit.confirmApprovedOperation('Synthetic operation only',{title:'Synthetic Confirmation',target:'synthetic-target'});});
        const confirmation=page.locator('#dlg-product-confirm');await confirmation.waitFor();
        await confirmation.evaluate(node=>{node.dataset.operationScope='different-synthetic-scope';});
        await confirmation.locator('[data-operation-confirm-execute]').click();
        assert.ok((await confirmation.locator('[data-operation-confirm-status]').innerText()).includes('바뀌었습니다'),'canonical confirmation blocks scope/target mismatch');
        await page.keyboard.press('Shift+Tab');assert.ok(await confirmation.evaluate(node=>node.contains(document.activeElement)),'confirmation contains reverse Tab');await page.keyboard.press('Escape');await confirmation.waitFor({state:'detached'});assert.equal(await page.evaluate(()=>document.activeElement?.dataset.recoveryKind),'state','decline returns original focus');
        const guard=await page.evaluate(async()=>{try{await __mockupAudit.runStateReplayMaintenance({kind:'rebuild',scopeKey:'different-synthetic-scope',worldlineId:'main'});return '';}catch(error){return error.message;}});
        assert.match(guard,/STATE_MAINTENANCE_SCOPE_CHANGED/,'state maintenance blocks changed scope before mutation');
        await host.locator('[data-state-replay-maintenance] .fold > summary').click();
        assert.equal(await host.locator('[data-state-maintenance-field="throughTurn"]').count(),1,'committed five-turn rollback input preserved');
      }
      if(section==='transfer'){
        await host.getByRole('button',{name:'JSON 만들기',exact:true}).click();
        const payload=JSON.parse(await host.locator('[data-configuration-transfer="json"]').inputValue());
        assert.ok(payload&&typeof payload==='object','transfer uses actual exporter payload');
        assert.ok(!(await host.locator('[data-configuration-transfer="json"]').inputValue()).includes('synthetic-secret-never-store'),'transfer default excludes secrets');
      }
      await page.screenshot({path:path.join(outputs,`settings-${section}-1280.png`),fullPage:true});
      if(section==='general'){
        assert.equal(await host.locator('[data-diagnostic-field="section"] option').count(),5,'all diagnostic categories preserved');await host.locator('[data-diagnostic-field="section"]').selectOption('log');
        await host.locator('[data-diagnostic-settings="log"]').waitFor();await host.locator('[data-diagnostic-log="log"] > summary').click();await host.getByRole('searchbox',{name:'디버그 로그 검색'}).waitFor();
        assert.ok(await host.getByRole('searchbox',{name:'디버그 로그 검색'}).count(),'real diagnostic search input reachable');
      }

    }
    await settingsPage.locator('.setnav button').filter({hasText:'기억과 검색'}).click();
    await settingsPage.locator('[data-product-settings-section="memory"] .fold > summary').first().click();
    const recallCount=settingsPage.locator('[data-memory-setting="recallMaxMemories"]');
    await recallCount.fill('7');await recallCount.dispatchEvent('change');
    await settingsPage.locator('[data-settings-room-save]').click();
    await page.waitForFunction(()=>__mockupAudit.Gui.settingsRoomSaving!==true&&__mockupAudit.Gui.dirty===false);
    const memoryReadback=await page.evaluate(async()=>await __mockupAudit.LibraMemoryCore.loadSettings());
    assert.equal(Number(memoryReadback.recallMaxMemories),7,'direct mockup memory field persists and reads back from LIBRA settings API');
    const actualSettings=await page.evaluate(async()=>await __mockupAudit.loadSettings());
    assert.equal(Number(actualSettings.stageOptions.librarian.max_chars),19000,'analyzer limit saved and read back through actual settings storage');
    assert.ok(actualSettings.selectedModuleLoreIds.includes('synthetic-module'),'module selection saved and read back');
    assert.ok(actualSettings.excludedModuleLoreIds.includes('synthetic-lore'),`individual lore exclusion saved and read back: ${JSON.stringify(actualSettings.excludedModuleLoreIds)}`);
    assert.ok(actualSettings.excludedCharacterLoreIds.includes('synthetic-character-lore'),'character lore exclusion saved and read back');

    await settingsPage.locator('.setnav button').filter({hasText:'저장과 백업'}).click();
    await settingsPage.locator('.tabs button').filter({hasText:'백업 · 복구'}).click();
    await page.locator('[data-portable-backup]').waitFor();
    const validation=await page.evaluate(async value=>await __LIBRAPortableMemoryBackup.validateBackup(value),envelope);
    assert.ok(validation,'product portable validator accepts the synthetic actual-API envelope');
    const backupInput=page.locator('#libra-portable-memory-backup-controls input[type="file"]');
    await backupInput.setInputFiles({name:'synthetic-libra-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(envelope))});
    const restoreMode=page.locator('[data-portable-restore-mode-modal]');await restoreMode.waitFor();
    assert.ok((await restoreMode.getAttribute('class')).split(/\s+/).includes('overlay'),'restore mode root uses the mockup overlay class');
    assert.ok(await restoreMode.locator('.dialog').count()>0,'restore qualification uses mockup dialog');
    assert.equal(await restoreMode.locator('.choice').count(),3,'restore shows three existing modes with API qualification');
    const restoreText=await restoreMode.innerText();
    assert.ok(restoreText.includes(envelope.source?.chatTitle||envelope.source?.chatId),'restore summary displays the actual synthetic source chat');
    await page.keyboard.press('Shift+Tab');assert.ok(await restoreMode.evaluate(node=>node.contains(document.activeElement)),'portable mode contains reverse Tab');await page.keyboard.press('Escape');
    await restoreMode.waitFor({state:'detached'});
    fs.writeFileSync(path.join(outputs,'body-comparisons.json'),JSON.stringify({sourceSha256,comparisons:bodyComparisons},null,2));
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({test:'libra_mockup_adoption_browser',sourceSha256,destinations:pages,viewports:[1280,1024,900,820,640,390],tray:'all real job-state bodies and same jobId across routes/minimize/reopen',settings:'seven route controls and persisted readback; five recovery kinds and canonical confirmation scope guard',errors,boundary:'synthetic isolated host/storage; no live RisuAI/provider; shell geometry/tokens compared to source mockup'}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
