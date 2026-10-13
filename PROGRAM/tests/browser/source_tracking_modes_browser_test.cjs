'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{chromium}=require('playwright');
// Real product input controls plus the authoritative SDK compatibility boundary.
// Retired auto/off selectors cannot enable automatic source processing.
(async()=>{const b=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',headless:true});try{
for(const [owner,file,api]of [['libra','LIBRA.js','__LIBRA__'],['hayaku','HAYAKU_Locator_Continuity.js','HAYAKU'],['flashback','Flashback_Memory.js','__FlashbackMemory']]){
 const p=await b.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('http://localhost/**',r=>r.fulfill({body:'<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body></body></html>',contentType:'text/html'}));await p.goto('http://localhost/source-controls');
 await p.addScriptTag({path:path.join(__dirname,'hayaku_browser_host.js')});const source=fs.readFileSync(path.join(__dirname,'../../plugins',file),'utf8');console.log('sourceSha256 '+owner+' '+crypto.createHash('sha256').update(source).digest('hex'));await p.addScriptTag({content:source});await p.waitForFunction(a=>!!window[a],api);
 await p.evaluate(async({owner,api})=>{window.product=window[api];window.originalSourceBytes=JSON.stringify(__chat);if(owner==='libra')await product.openSettingsGui();else await product.showUi();},{owner,api});
 if(owner==='libra'){
  await p.waitForFunction(()=>!!document.querySelector('.sidebar [data-go="settings"]'));
  await p.evaluate(()=>document.querySelector('.sidebar [data-go="settings"]').click());
  await p.locator('.setnav button').filter({hasText:'참고 자료'}).click();await p.locator('.page[data-page="settings"] .tabs button').filter({hasText:'분석할 내용'}).click();
 }else if(owner==='hayaku'){
  await p.locator('.tabbar [data-go="recovery"]').click();await p.locator('[data-recovery-view="reanalysis"]').click();
 }else await p.locator('.tabbar [data-go="care"]').click();
 const controls=p.locator('[data-source-input-controls]:visible');await controls.waitFor();
 assert.equal(await controls.locator('option[value="auto"],option[value="off"],option[value="notify"]').count(),0,owner+': no retired processing mode in actual input controls');
 await controls.locator('textarea').last().fill('fixture_browser');await controls.locator('textarea').last().dispatchEvent('input');await controls.locator('.ms-input-apply').click();
 await p.waitForFunction(()=>JSON.stringify(product.getSourceEditRules()).includes('fixture_browser'));
 assert.equal(await p.evaluate(()=>JSON.stringify(__chat)),await p.evaluate(()=>originalSourceBytes),owner+': input rule save preserves original chat');
 assert.equal(await p.evaluate(()=>__hostCalls.llm),0,owner+': opening/input settings do no model work');
 assert.equal(await p.evaluate(()=>__hostCalls.network),0,owner+': opening/input settings do no external calls');
 // Compatibility is tested against the current SDK directly; products no longer
 // expose the retired automatic-observer controller/getter.
 await p.addScriptTag({path:path.join(__dirname,'../../sdk/MemorySuiteSourceEditConsent.source.js')});
 const outcomes=await p.evaluate(async owner=>{
  const storage=new Map();let collected=0,executed=0,prompted=0;
  const units=[1,2].map(n=>({key:String(n),start:n,end:n,digest:'edited-'+n,sourceDigest:'edited-'+n,originalDigest:'original-'+n,basis:'basis',identity:'identity-'+n,changed:true,current:false}));
  const controller=createMemorySuiteSourceEditConsent({owner,requestBoundary:true,read:async k=>storage.get(k)??null,write:async(k,v)=>{storage.set(k,v);return true;},collect:async()=>{collected++;return{scopeKey:'selected-current-chat',units};},prompt:async()=>{prompted++;return{decision:'approve',keys:['1','2']};},execute:async(_task,permit)=>{await permit.assertCurrent();executed++;return{ok:true};}});
  await controller.ready();const modes=[];
  for(const legacy of ['auto','notify','off']){await controller.setMode(legacy);await controller.beforeRequest();controller.afterRequest();modes.push(controller.status().mode);}
  const manual=await controller.review(),before={collected,executed,prompted};
  const ticket=await controller.previewSelected(['1','2']);const result=await controller.applySelected(ticket);
  const state=controller.status();controller.dispose();return{modes,manual,before,ticket:{allowed:ticket.allowed,owner:ticket.owner,scopeKey:ticket.scopeKey,units:ticket.units},result,executed,prompted,events:state.events.length,tasks:state.tasks.map(t=>t.state),modal:!!document.querySelector('#memorySuiteSourceReview'),dock:!!document.querySelector('[x-memory-suite-source-review-dock]'),dialog:!!document.querySelector('[x-memory-suite-source-edit-dialog]')};
 },owner);
 assert.deepEqual(outcomes.modes,['explicit_only','explicit_only','explicit_only'],owner+': every legacy mode normalizes to explicit selection');
 assert.equal(outcomes.manual.reason,'explicit_selection_required');assert.deepEqual(outcomes.before,{collected:0,executed:0,prompted:0},owner+': admission and legacy manual entry do not observe/execute/prompt');
 assert.equal(outcomes.ticket.allowed,true);assert.equal(outcomes.ticket.owner,owner);assert.equal(outcomes.ticket.scopeKey,'selected-current-chat');assert.equal(outcomes.ticket.units.length,2);
 assert.equal(outcomes.result.ok,true,JSON.stringify(outcomes.result));assert.equal(outcomes.executed,2);assert.equal(outcomes.events,2);assert.deepEqual(outcomes.tasks,['applied','applied']);assert.equal(outcomes.prompted,0);
 assert.equal(outcomes.modal,false);assert.equal(outcomes.dock,false);assert.equal(outcomes.dialog,false);assert.equal(await p.evaluate(()=>__hostCalls.llm),0);assert.deepEqual(errors,[]);
 console.log('PASS '+owner+': real input settings/readback; legacy modes explicit_only; admission inert; only selected SDK ticket executes; original data/model/UI guards retained');await p.evaluate(()=>__dispose());await p.close();
}
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
