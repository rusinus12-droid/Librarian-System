'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {worldAtlasHead}=require('../fixtures/libra_world_atlas_fixture.cjs');
const {artifact}=require('../fixtures/libra_unified_runtime_fixture.cjs');
const input=require('../fixtures/unified_vertical_source.json');
const program=path.resolve(__dirname,'../..');
const output=path.resolve(process.argv[2]||path.join(program,'../../review_artifacts/libra_world_atlas_20260912'));
const results=[],errors=[];
const check=(name,value)=>{assert.ok(value,name);results.push(name);};
const source=fs.readFileSync(path.join(program,'plugins/LIBRA.js'),'utf8');
const marker='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';
assert(source.includes(marker));
const audited=source.replace(marker,'  globalThis.__atlasAudit={Gui,LibraMemoryCore,bookNavigate,renderSettingsGui,worldManagerSnapshotView,bookWorldAtlasModel,buildBookWorldGuideProjection};\n'+marker);
async function seed(page){
 await page.evaluate(head=>{const a=__atlasAudit;a.LibraMemoryCore.state.snapshot={...a.LibraMemoryCore.peekSnapshot(),continuityState:head};a.Gui.bookBrowse_world={query:'',kind:'',selected:'village'};a.Gui.bookWorldSection='guide';a.bookNavigate('world');},worldAtlasHead());
 await page.locator('[data-book-world-atlas]').waitFor();
 await page.locator('.atlas-article h2',{hasText:'하나 마을'}).waitFor();
}
(async()=>{
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({executablePath:(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'),headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<html lang="ko"><body></body></html>');
  await page.addScriptTag({path:path.join(__dirname,'libra_writer_host.js')});
  await page.evaluate(({rows,a})=>{__writerHost.chat.message=rows.map(r=>({role:r.role,chatId:r.ref,data:r.text}));risuai.runLLMModel=async()=>{__writerHost.calls.model++;return {type:'success',result:JSON.stringify(a)};};},{rows:input.sourceRows,a:artifact()});
  await page.addScriptTag({content:audited});await page.waitForFunction(()=>!!window.__LIBRA__);
  await page.waitForFunction(()=>[...__writerHost.values.entries()].some(([k,v])=>k.includes('remove-world-additional')&&JSON.parse(v).done));
  const job=await page.evaluate(()=>__LIBRA__.runManualColdStart());check('production canonical analysis commits',job.completed===1);
  await page.evaluate(()=>__LIBRA__.openSettingsGui());
  const dialog=page.locator('.canonical-job-overlay');if(await dialog.count())await dialog.getByRole('button',{name:'닫기',exact:true}).click();
  await page.evaluate(()=>__atlasAudit.bookNavigate('world'));
  const atlas=page.locator('[data-book-world-atlas]');await atlas.waitFor();
  check('committed world data renders',/도서관/.test(await atlas.innerText()));
  const committed=await page.evaluate(()=>__atlasAudit.bookWorldAtlasModel(__atlasAudit.worldManagerSnapshotView()).map(n=>({id:n.id,recordId:n.recordId,name:n.title,kind:n.kind,links:n.links.map(e=>e.label+':'+e.target.row.name),facts:n.facts})));
  check('committed rule remains visible on location',committed.some(n=>n.facts.some(f=>f.key==='rule'&&f.value.includes('정숙'))));
  check('committed manager reverse link',committed.find(n=>n.name==='기록회').links.some(l=>l.includes('도서관')));
  const rulePage=committed.find(n=>n.kind==='규칙');
  check('embedded rule has a read-only category page',rulePage&&rulePage.recordId===committed.find(n=>n.name==='도서관').id);
  await atlas.locator('[data-world-entry="'+rulePage.id+'"]').click();await atlas.locator('h2',{hasText:'도서관 · 적용 규칙'}).waitFor();
  await atlas.getByRole('button',{name:'근거 보기 · 관리 ↗'}).click();await page.waitForFunction(()=>__atlasAudit.Gui.bookWorldSection==='details');
  check('derived rule management opens original source record',await page.evaluate(()=>__atlasAudit.Gui.worldManagerSelectedWorldId)===rulePage.recordId);
  await page.evaluate(()=>__LIBRA__.retryPendingUnifiedVectors());
  const storedBefore=await page.evaluate(()=>JSON.stringify([...__writerHost.values]));
  await seed(page);
  check('sample has correct categories',await atlas.locator('.atlas-category').count()===8);
  check('sample manager and scoped rule linked',await atlas.locator('[data-world-link="council"]').count()===1&&await atlas.locator('[data-world-link="curfew"]').count()>=1);
  await atlas.locator('[data-world-link="council"]').click();await atlas.locator('h2',{hasText:'하나 자치회'}).waitFor();
  check('current and former memberships distinguished',/현재 구성원 · 야간 순찰 담당/.test(await atlas.innerText())&&/이전 구성원 · 기록 담당/.test(await atlas.innerText()));
  await atlas.locator('[data-world-link="seoyun"]').click();await page.waitForFunction(()=>__atlasAudit.Gui.bookPage==='people');
  check('member opens existing people page',await page.evaluate(()=>__atlasAudit.Gui.bookSelectedCharacterId)==='seoyun');
  await seed(page);
  await atlas.locator('[data-world-entry="curfew"]').click();await atlas.locator('h2',{hasText:'일몰 이후'}).waitFor();
  check('rule has scope condition and exception',/약초 채집자/.test(await atlas.innerText())&&/통행 허용/.test(await atlas.innerText()));
  await atlas.getByText(/인용 근거 .*개 펼치기/).click();await atlas.locator('details blockquote').first().waitFor();check('evidence expands quoted source',await atlas.locator('details blockquote').count()>0);
  await atlas.locator('.atlas-category').filter({has:page.getByText('사물',{exact:true})}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.atlas-entry').length===1);
  check('category narrows entries',await atlas.locator('.atlas-entry').count()===1);
  await atlas.getByRole('searchbox').fill('없는 기록');await atlas.getByRole('button',{name:'찾기',exact:true}).click();
  await atlas.locator('h2',{hasText:'일치하는 기록이 없습니다'}).waitFor();
  check('empty search state',await atlas.locator('h2').innerText()==='일치하는 기록이 없습니다');
  await atlas.getByRole('searchbox').fill('');await atlas.getByRole('searchbox').press('Enter');
  await page.waitForFunction(()=>document.querySelectorAll('.atlas-entry').length===1);
  check('Enter applies query and restores results',await atlas.locator('.atlas-entry').count()===1);
  await seed(page);
  const pure=await page.evaluate(()=>{
   const a=__atlasAudit,v=a.worldManagerSnapshotView(),before=JSON.stringify(v.head);
   const sample=structuredClone(v);sample.world.push({id:'unrelated',name:'하나 마을이라는 이름만 언급',kind:'other',state:{description:'하나 마을의 자치회와 연결된 것처럼 보이는 문장'}});
   sample.world.push({id:'identity',name:'아직 이름만 아는 탑',kind:'location',state:{}});
   const model=a.bookWorldAtlasModel(sample);
   const metadataOnly=structuredClone(sample);metadataOnly.world[0].identityEvidence=null;metadataOnly.world[0].fieldEvidence={condition:{memoryId:'sample',turnRange:{start:106,end:110}}};metadataOnly.world[0].evidence=null;const fallback=a.bookWorldAtlasModel(metadataOnly)[0];if(fallback.evidence.length!==0||fallback.confirmations[0]?.turn!==110)throw Error('metadata-only evidence fallback');
   return {unchanged:before===JSON.stringify(v.head),unrelated:model.find(n=>n.id==='unrelated').links.length,identity:model.find(n=>n.id==='identity').facts.length};
  });check('unsupported descriptions absent',await atlas.locator('.atlas-article').innerText().then(t=>!t.includes('북쪽 숲의 남쪽 경계에 자리한 작은 마을.')));check('read-only projection and no lexical relationship invention',pure.unchanged&&pure.unrelated===0&&pure.identity===0);
  for(const width of [1440,1024,390]){
   await page.setViewportSize({width,height:1100});
   await page.evaluate(()=>{document.querySelector('.sga-main').scrollTop=0;});
   await page.screenshot({path:path.join(output,`actual-${width}.png`),fullPage:true});
   check('atlas no horizontal overflow '+width,await atlas.evaluate(n=>n.scrollWidth<=n.clientWidth+1));
   check('page no horizontal overflow '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }
  await page.setViewportSize({width:1024,height:1100});
  await atlas.locator('[data-world-entry="curfew"]').click();await atlas.locator('h2',{hasText:'일몰 이후'}).waitFor();await page.screenshot({path:path.join(output,'rule-1024.png')});
  await atlas.locator('[data-world-entry="council"]').click();await atlas.locator('h2',{hasText:'하나 자치회'}).waitFor();await page.screenshot({path:path.join(output,'organization-1024.png')});
  await page.evaluate(()=>{const a=__atlasAudit;a.LibraMemoryCore.state.snapshot.continuityState.world=[{id:'bare',name:'이름만 확인된 장소',kind:'location',state:{},clearedFieldEvidence:{ownerRef:{}},correctionProvenance:{correctionId:'test'}}];a.Gui.bookBrowse_world={query:'',kind:'',selected:'bare'};a.bookNavigate('world');});
  await atlas.locator('h2',{hasText:'이름만 확인된 장소'}).waitFor();
  check('sparse and corrected records explain missing content',/상태와 연결 정보는 아직 기록되지/.test(await atlas.innerText())&&/명시적으로 해제됨/.test(await atlas.innerText())&&/사용자 교정/.test(await atlas.innerText()));
  await page.screenshot({path:path.join(output,'sparse-1024.png')});
  await page.evaluate(()=>{__atlasAudit.LibraMemoryCore.state.snapshot.continuityState.world=[];__atlasAudit.bookNavigate('world');});
  await atlas.locator('h2',{hasText:'아직 세계 기록이 없습니다'}).waitFor();
  check('empty collection stays usable',await atlas.locator('.atlas-category').count()===8&&/아직 세계 기록이 없습니다/.test(await atlas.innerText()));
  await seed(page);await atlas.getByRole('button',{name:'근거 보기 · 관리 ↗'}).click();
  await page.waitForFunction(()=>__atlasAudit.Gui.bookWorldSection==='details');
  check('existing management route retains identity',await page.evaluate(()=>__atlasAudit.Gui.worldManagerSelectedWorldId)==='village');
  check('GUI makes no extra model call',await page.evaluate(()=>__writerHost.calls.model)===1);
  const storedAfter=await page.evaluate(()=>JSON.stringify([...__writerHost.values]));
  if(storedAfter!==storedBefore){const a=new Map(JSON.parse(storedBefore)),b=new Map(JSON.parse(storedAfter));fs.writeFileSync(path.join(output,'storage-diff.json'),JSON.stringify([...new Set([...a.keys(),...b.keys()])].filter(k=>a.get(k)!==b.get(k)).map(k=>({key:k,before:a.get(k),after:b.get(k)})),null,2));}
  const canonicalStorage=raw=>JSON.parse(raw).filter(([k])=>k.includes(':scope:')).map(([k,v])=>{if(k.endsWith(':manifest')){v=JSON.parse(v);delete v.updatedAt;if(v.branchGuard){delete v.branchGuard.updatedAt;delete v.branchGuard.lastFullAuditAt;}v=JSON.stringify(v);}return [k,v];});
  check('canonical bytes and State preserved (background audit timestamps excluded)',JSON.stringify(canonicalStorage(storedAfter))===JSON.stringify(canonicalStorage(storedBefore)));
  check('no uncaught browser errors',errors.length===0);
  // An interactive local review uses the same complete deployed source and test host.
  fs.writeFileSync(path.join(output,'plugin.js'),audited);
  fs.copyFileSync(path.join(__dirname,'libra_writer_host.js'),path.join(output,'host.js'));
  fs.writeFileSync(path.join(output,'actual.html'),`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LIBRA 세계 도감 · 실제 렌더러 + 예시 데이터</title><body><script src="host.js"></script><script src="plugin.js"></script><script>(async()=>{await __LIBRA__.openSettingsGui();__atlasAudit.LibraMemoryCore.state.snapshot={...__atlasAudit.LibraMemoryCore.peekSnapshot(),continuityState:${JSON.stringify(worldAtlasHead()).replace(/</g,'\\u003c')}};__atlasAudit.Gui.bookWorldSection='guide';__atlasAudit.bookNavigate('world');})();</script></body></html>`);
 }finally{await browser.close();fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({results,errors,boundary:'Full production LIBRA in Chromium with controlled RisuAI host and provider; sample State for visual comparison; no live RisuAI or real user data'},null,2));}
 console.log(JSON.stringify({test:'libra_world_atlas_browser',passed:results.length,errors}));
})().catch(e=>{console.error(e);process.exitCode=1;});
