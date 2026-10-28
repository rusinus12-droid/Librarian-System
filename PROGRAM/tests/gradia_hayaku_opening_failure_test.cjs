'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {JSDOM}=require('jsdom');
const {load}=require('./gradia/host.cjs');
const {create,until,pause}=require('./fixtures/libra_gui_memory_dom_host.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const snapshot=(dom,name)=>{if(process.env.OPENING_FAILURE_SNAPSHOTS){fs.mkdirSync(process.env.OPENING_FAILURE_SNAPSHOTS,{recursive:true});fs.writeFileSync(path.join(process.env.OPENING_FAILURE_SNAPSHOTS,name+'.html'),dom.serialize());}};
async function gradia(t){
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://offline.invalid',pretendToBeVisual:true});
 const control={fail:false,gate:null,reads:0},unloads=[];let shows=0,hides=0;
 const f=await load({testGlobals:{__openingControl:control,document:dom.window.document,window:dom.window,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLTextAreaElement:dom.window.HTMLTextAreaElement,HTMLSelectElement:dom.window.HTMLSelectElement,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window)},
  api:{showContainer:async()=>{shows++;},hideContainer:async()=>{hides++;},onUnload:async fn=>unloads.push(fn)},
  transformSource:s=>s.replace('  const loadSettings = async () => {',`  const loadSettings = async () => {if(globalThis.__openingControl.fail || globalThis.__openingControl.gate){globalThis.__openingControl.reads++;if(globalThis.__openingControl.gate)await globalThis.__openingControl.gate;if(globalThis.__openingControl.fail)throw Error('SYNTHETIC_LOCAL_READ_FAILURE');}`)});
 t.after(async()=>{for(const fn of unloads)await fn();dom.window.close();});
 return {f,dom,control,shows:()=>shows,hides:()=>hides};
}
test('GRADIA opening failure stays in the UI and retry returns to the actual settings shell',async t=>{
 const x=await gradia(t);x.control.fail=true;
 assert.equal(await x.f.plugin.openSettingsGui(),false);
 assert(x.dom.window.document.querySelector('[data-gradia-opening-state="failed"]'));
 assert.equal(x.dom.window.document.body.textContent.includes('SYNTHETIC_LOCAL_READ_FAILURE'),false);
 snapshot(x.dom,'gradia-failed');x.control.fail=false;
 x.dom.window.document.querySelector('[data-gradia-opening-retry]').click();
 await until(()=>x.f.plugin.debugGuiStateInfo().shellReady,'normal GRADIA shell');
 assert.equal(x.dom.window.document.querySelector('[data-gradia-opening-state]'),null);snapshot(x.dom,'gradia-recovered');
 assert.equal(x.f.getCalls(),0,'no external server/provider request');
});
test('GRADIA concurrent opening shares a read and closing loading prevents late success from rendering',async t=>{
 const x=await gradia(t),gate=deferred();x.control.gate=gate.promise;
 const first=x.f.plugin.openSettingsGui();await until(()=>x.dom.window.document.querySelector('[data-gradia-opening-close]'),'loading');
 const second=x.f.plugin.openSettingsGui();assert.equal(x.control.reads,1);
 x.dom.window.document.querySelector('[data-gradia-opening-close]').click();gate.resolve();await Promise.all([first,second]);
 assert.equal(x.f.plugin.debugGuiStateInfo().shellReady,false);assert.equal(x.hides(),1);assert.equal(x.shows(),1);
 x.control.gate=null;assert.equal(await x.f.plugin.openSettingsGui(),true);
});
test('HAYAKU ledger failure overrides completed-job health and clears after a successful ledger refresh',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hayaku-opening-')),file=path.join(temp,'HAYAKU.js');
 let source=fs.readFileSync(path.resolve(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');
 source=source.replace('      readScope = scope;','      readScope = scope;if(globalThis.__ledgerReadFault)throw Error("SYNTHETIC_LEDGER_READ_FAILURE");')
  .replace('    globalThis.HAYAKU = exposedApi;','    globalThis.__headerAudit={Memory,viewerRenderHeaderHealth};globalThis.HAYAKU = exposedApi;');
 fs.writeFileSync(file,source);const f=await create('HAYAKU','Full',{pluginPath:file,initialChat:[{role:'user',chatId:'u1',data:'Where is the key?'},{role:'assistant',chatId:'a1',data:'The key remains in the blue cabinet.'}]});
 t.after(async()=>{await f.close();fs.rmSync(temp,{recursive:true,force:true});});f.context.__ledgerReadFault=true;
 assert.equal(await f.open(),true);const header=()=>f.doc.querySelector('#hayakuViewerHealth');
 await until(()=>header()?.textContent.includes('원장 확인 필요'),'ledger failure health');await pause(150);
 assert(header().classList.contains('health--danger'));snapshot(f.dom,'hayaku-failed');
 const audit=f.context.__headerAudit;audit.Memory.nativeRecovery.job={state:'completed',kind:'cold_start'};audit.viewerRenderHeaderHealth();
 assert.match(header().textContent,/원장 확인 필요/);assert.doesNotMatch(header().textContent,/정상 작동|복구 완료/);
 header().click();await pause(50);assert.match(f.doc.body.textContent,/상태 확인 필요 · 원장 및 연속성 점검 필요/);
 f.doc.querySelector('[data-status-log-close]').click();audit.Memory.nativeRecovery.job=null;f.context.__ledgerReadFault=false;f.doc.querySelector('#hayakuOverviewRefresh').click();
 await until(()=>!header().textContent.includes('원장 확인 필요'),'ledger recovery');snapshot(f.dom,'hayaku-recovered');
 assert.equal(header().classList.contains('health--danger'),false);assert.deepEqual(f.errors,[]);
});
