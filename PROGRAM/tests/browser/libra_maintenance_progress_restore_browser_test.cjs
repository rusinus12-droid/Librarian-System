'use strict';
// Full production renderer with synthetic persisted evidence, not a live RisuAI host.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const errors=[];
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost/maintenance-restore',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><body></body></html>'}));await page.goto('http://localhost/maintenance-restore');
  await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
  let source=fs.readFileSync(path.join(__dirname,'../../plugins/LIBRA.js'),'utf8');
  const marker='  const runLibraMemoryMaintenance = async (mode = \'auto\', options = {}) => {';
  assert.ok(source.includes(marker));source=source.replace(marker,marker+'\n    if(globalThis.__maintenanceTestRun)return globalThis.__maintenanceTestRun(mode,options);');
  const seam='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';assert.ok(source.includes(seam));source=source.replace(seam,'  globalThis.__maintenanceUI={Gui,LibraMemoryCore,renderCanonicalJobSurface,hideSettingsGui};\n'+seam);
  await page.addScriptTag({content:source});await page.waitForFunction(()=>!!window.__LIBRA__);await page.evaluate(()=>__LIBRA__.openSettingsGui());
  await page.evaluate(()=>{window.__maintenanceCalls=0;window.__maintenanceTestRun=async(mode,options)=>{window.__maintenanceCalls++;window.__maintenanceUpdate=options.onProgress;options.onProgress({step:'canonical',status:'done'});options.onProgress({step:'micro',status:'running',detail:'22턴 분석 중'});await new Promise(resolve=>window.__finishMaintenance=resolve);return {durationMs:1000,after:options.preflight,actionsTaken:[],healthy:true};};});
  await page.evaluate(()=>__LIBRA__.openMemoryMaintenanceDialog());const overlay=page.locator('#dlg-maintenance');
  await overlay.locator('[data-maintenance-full]').click();await page.getByRole('button',{name:'자동 복구 시작',exact:true}).click();await overlay.locator('[data-maintenance-progress]').waitFor();
  await overlay.locator('[data-maintenance-minimize]').click();const chip=page.locator('[data-maintenance-progress-chip]');await chip.waitFor();assert.equal(await overlay.isVisible(),false);assert.equal(await page.evaluate(()=>__maintenanceCalls),1);
  await page.evaluate(()=>__maintenanceUpdate({step:'micro',status:'running',detail:'23턴 분석 중'}));await chip.click();await overlay.getByText(/23턴 분석 중/).first().waitFor();assert.equal(await overlay.isVisible(),true);
  await page.evaluate(()=>__LIBRA__.openMemoryMaintenanceDialog());assert.equal(await page.locator('#dlg-maintenance').count(),1);assert.equal(await page.evaluate(()=>__maintenanceCalls),1);
  await page.keyboard.press('Escape');await chip.waitFor();assert.equal(await overlay.isVisible(),false);
  await page.locator('.nav-item[data-go="people"]').click();await chip.waitFor();
  await page.evaluate(()=>{const a=__maintenanceUI,job={jobId:'separate-live-job',scopeKey:a.LibraMemoryCore.peekSnapshot().scope.scopeKey,state:'running',kind:'manual_scan',total:22,completed:2};a.LibraMemoryCore.state.canonicalJob=job;a.Gui.canonicalJob=job;a.Gui.canonicalJobObservedIds.add(job.jobId);a.Gui.canonicalJobMinimized=true;a.renderCanonicalJobSurface(job);});
  await page.locator('[data-canonical-job-chip]').waitFor();await chip.click();assert.equal(await page.evaluate(()=>__maintenanceUI.Gui.canonicalJobMinimized),true);await overlay.locator('[data-maintenance-minimize]').click();await page.locator('[data-canonical-job-chip]').click();assert.equal(await overlay.isVisible(),false);
  await page.locator('[data-canonical-job-portal]').getByRole('button',{name:'최소화',exact:true}).click();
  await page.evaluate(()=>{const a=__maintenanceUI,s=a.LibraMemoryCore.state.snapshot;window.__oldMaintenanceScope=s.scope.scopeKey;s.scope.scopeKey='another-scope';a.Gui.maintenanceProgressSurface.sync();});assert.equal(await chip.count(),0);assert.equal(await overlay.count(),0);
  await page.evaluate(()=>{const a=__maintenanceUI;a.LibraMemoryCore.state.snapshot.scope.scopeKey=window.__oldMaintenanceScope;a.Gui.maintenanceProgressSurface.sync();});await chip.waitFor();
  for(const width of [1280,390,320]){
   await page.setViewportSize({width,height:1000});
   const layout=await page.locator('.topbar').evaluate(n=>{
    const b=n.getBoundingClientRect(),main=n.parentElement.querySelector('.main').getBoundingClientRect();
    return {overflow:n.scrollWidth-n.clientWidth,overlap:b.bottom>main.top+1,chips:[...n.querySelectorAll('[data-maintenance-progress-chip],[data-canonical-job-chip]')].map(c=>{const r=c.getBoundingClientRect();return {text:c.textContent,clipped:c.scrollWidth>c.clientWidth+1||c.scrollHeight>c.clientHeight+1,outside:r.left<b.left||r.right>b.right+1||r.top<b.top||r.bottom>b.bottom+1};})};
   });
   assert.ok(layout.overflow<=1&&!layout.overlap,JSON.stringify({width,layout}));
   assert.ok(layout.chips.every(c=>!c.clipped&&!c.outside),JSON.stringify({width,layout}));
  }
  await page.setViewportSize({width:390,height:1000});
  if(process.env.LIBRA_REVIEW_ARTIFACT_DIR){fs.mkdirSync(process.env.LIBRA_REVIEW_ARTIFACT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.LIBRA_REVIEW_ARTIFACT_DIR,'maintenance-two-chips-mobile.png')});}
  await page.evaluate(async()=>{await __maintenanceUI.hideSettingsGui();await __LIBRA__.openSettingsGui();});await chip.waitFor();assert.equal(await page.evaluate(()=>__maintenanceCalls),1);
  await page.evaluate(()=>__finishMaintenance());await chip.filter({hasText:'완료'}).waitFor();await chip.click();await overlay.getByText('상태 점검 및 자동 복구 완료',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>__maintenanceCalls),1);
  await overlay.getByRole('button',{name:'확인',exact:true}).click();assert.equal(await chip.count(),0);assert.equal(await overlay.count(),0);assert.deepEqual(errors,[]);
  console.log('PASS maintenance minimize/restore, hidden updates and completion, idempotent reopen, GUI reopen, separate live job controls, mobile header bounds; synthetic runner, production UI');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
