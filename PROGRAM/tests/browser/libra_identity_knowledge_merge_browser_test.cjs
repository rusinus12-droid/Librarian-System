'use strict';
// Deployed UI and commit with controlled RisuAI/model/storage, not live RisuAI.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {artifact}=require('../fixtures/libra_unified_runtime_fixture.cjs');
const input=require('../fixtures/unified_vertical_source.json');
(async()=>{
 const browser=await chromium.launch({executablePath:(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'),headless:true});
 const errors=[];
 try{
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<html lang="ko"><body></body></html>');
  await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
  await page.evaluate(({rows,a})=>{
   __writerHost.chat.message=rows.map(r=>({role:r.role,chatId:r.ref,data:r.text}));
   __writerHost.artifact=a;risuai.runLLMModel=async()=>({type:'success',result:JSON.stringify(__writerHost.artifact)});
  },{rows:input.sourceRows,a:artifact()});
  let source=fs.readFileSync(path.join(__dirname,'../../plugins/LIBRA.js'),'utf8');
  const needle='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';
  assert.ok(source.includes(needle));
  source=source.replace(needle,'  globalThis.__mergeAudit={LibraMemoryCore,buildWorldManagerIdentityMerge,worldManagerSnapshotView};\n'+needle);
  await page.addScriptTag({content:source});await page.waitForFunction(()=>!!window.__LIBRA__);
  assert.equal((await page.evaluate(()=>__LIBRA__.runManualColdStart())).completed,1);
  await page.evaluate(async()=>{
   const head=__mergeAudit.LibraMemoryCore.peekSnapshot().continuityState;
   const a=head.characters.find(r=>r.name==='지호'),b=head.characters.find(r=>r.name==='준호');
   for(const[p,knowledge]of [[a,['암호는 달빛','등대에 지도']],[b,['등대에 지도','서재에 열쇠']]])
    await __LIBRA__.addWorldManagerCorrection({anchorTurn:5,target:{domain:'characters'},patch:{characters:[{id:p.id,set:{knowledge}}]}});
   await __LIBRA__.openSettingsGui();
   const view=__mergeAudit.worldManagerSnapshotView(),row=view.characters.find(r=>r.id===a.id);
   const host=document.createElement('div');host.id='merge-test';host.style.cssText='position:fixed;inset:0;background:white;z-index:2147483647;overflow:auto';host.appendChild(__mergeAudit.buildWorldManagerIdentityMerge('characters',row,view));document.body.appendChild(host);
   window.__mergeTarget=b.id;
  });
  const panel=page.locator('#merge-test');await panel.locator('summary').click();
  await panel.getByLabel('병합 후 남길 항목').selectOption(await page.evaluate(()=>__mergeTarget));
  await panel.getByRole('button',{name:'병합 내용 확인',exact:true}).click();
  const select=panel.locator('select').filter({has:page.locator('option[value="both"]')});
  await select.waitFor();
  assert.deepEqual(await select.locator('option').evaluateAll(nodes=>nodes.map(n=>n.value)),['','source','target','both']);
  for(const choice of ['source','target','both']){await select.selectOption(choice);assert.equal(await select.inputValue(),choice);}
  await panel.getByRole('button',{name:'선택한 내용으로 병합 확정',exact:true}).click();
  await page.waitForFunction(()=>__mergeAudit.LibraMemoryCore.peekSnapshot().continuityState.characters.length===2);
  assert.deepEqual(await page.evaluate(()=>__mergeAudit.LibraMemoryCore.peekSnapshot().continuityState.characters.find(r=>r.id===__mergeTarget).state.knowledge),['등대에 지도','서재에 열쇠','암호는 달빛']);
  assert.deepEqual(errors,[]);
  console.log('PASS knowledge merge UI retains source/target choices and commits both');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
