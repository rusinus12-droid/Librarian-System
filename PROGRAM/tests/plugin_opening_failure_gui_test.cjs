'use strict';
// Production UI/event handlers; faults are injected at storage/context/probe
// boundaries. No RisuAI host or external server/provider requests.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {create,until,pause}=require('./fixtures/libra_gui_memory_dom_host.cjs');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
const {createColdStartGuiDocument}=require('./fixtures/hayaku_cold_start_gui_dom_fixture.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const snapshot=(f,name)=>{if(process.env.OPENING_FAILURE_SNAPSHOTS){fs.mkdirSync(process.env.OPENING_FAILURE_SNAPSHOTS,{recursive:true});fs.writeFileSync(path.join(process.env.OPENING_FAILURE_SNAPSHOTS,name+'.html'),f.dom.serialize());}};
async function flashback(t){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fb-opening-')),file=path.join(temp,'Flashback.js');
 const source=fs.readFileSync(path.resolve(__dirname,'../plugins/Flashback_Memory.js'),'utf8')
  .replace('  globalThis.__FlashbackMemory = publicApi;','  globalThis.__openingAudit={clearSettings(){Runtime.settings=null;}};\n  globalThis.__FlashbackMemory = publicApi;')
  .replace('const probe = await MemorySuiteStorageBridge.testConnection();','const probe = await globalThis.__openingProbe();');
 fs.writeFileSync(file,source);const f=await create('Flashback','Full',{pluginPath:file});
 t.after(async()=>{await f.close();fs.rmSync(temp,{recursive:true,force:true});});
 f.context.__openingAudit.clearSettings();const read=f.host.pluginStorage.getItem.bind(f.host.pluginStorage);let fault=true,hold=null;
 f.host.pluginStorage.getItem=async key=>{if(String(key).endsWith(':settings:v2')){if(hold)await hold.promise;if(fault)throw Object.assign(Error('memory_suite_server_unavailable'),{code:'MEMORY_SUITE_SERVER_UNAVAILABLE'});}return read(key);};
 return {f,setFault:value=>fault=value,setHold:value=>hold=value};
}
test('Flashback contains opening failure, retries once per click and restores normal UI after verified probe',async t=>{
 const x=await flashback(t),f=x.f;let probes=0;f.context.__openingProbe=async()=>{probes++;return {ok:false};};
 assert.equal(await f.open(),false);assert(f.doc.querySelector('[data-opening-error]'));
 assert.equal(f.doc.querySelector('[data-vrm-skeleton-shell]'),null);assert.match(f.doc.body.textContent,/서버에 연결하지 못했습니다/);
 snapshot(f,'flashback-failed');const settings=f.doc.querySelector('[data-opening-settings]');settings.click();
 const connection=f.doc.querySelector('[data-opening-connection]');assert.equal(connection.hidden,false);
 await until(()=>connection.textContent.includes('Flashback · 서버 연결'),'connection settings mounted');settings.click();assert.equal(connection.hidden,true);
 const button=f.doc.querySelector('[data-opening-retry]');button.click();button.click();
 await until(()=>!button.disabled,'retry settles');assert.equal(probes,1);assert.match(f.doc.querySelector('[data-opening-status]').textContent,/아직 연결/);
 x.setFault(false);const gate=deferred();f.context.__openingProbe=async()=>{probes++;await gate.promise;return {ok:true};};button.click();button.click();assert.equal(probes,2);
 gate.resolve();await until(()=>f.doc.querySelector('[data-vrm-mounted="1"]'),'normal workspace');
 assert.equal(f.doc.querySelector('[data-opening-error]'),null);snapshot(f,'flashback-recovered');assert.deepEqual(f.errors,[]);
});
test('Flashback closing during connection retry does not reopen the plugin',async t=>{
 const x=await flashback(t),f=x.f,gate=deferred();f.context.__openingProbe=()=>gate.promise;
 await f.open();f.doc.querySelector('[data-opening-retry]').click();f.doc.querySelector('[data-opening-close]').click();
 await until(()=>f.calls.hide===1,'closed');x.setFault(false);gate.resolve({ok:true});await pause(100);assert.equal(f.calls.show,1);
 assert.equal(f.doc.querySelector('[data-opening-retry]')?.disabled,true);
});
test('Flashback closing initial loading prevents a late read failure from painting a new error screen',async t=>{
 const x=await flashback(t),f=x.f,gate=deferred();x.setHold(gate);const opening=f.open();
 await until(()=>f.doc.querySelector('[data-vrm-skeleton-shell]'),'loading');f.doc.querySelector('[data-vrm-skeleton-shell] button').click();
 await until(()=>f.calls.hide===1,'closed while loading');gate.resolve();await opening;assert.equal(f.doc.querySelector('[data-opening-error]'),null);
});
async function lia(t){
 let open;const f=await createFixture('official',{configureApi(api){api.registerSetting=async(_name,callback)=>{open=callback;return true;};},transformSource:s=>s.replace('      renderLiaPreviewState(root,error);','      globalThis.__openingLastError=error.stack;renderLiaPreviewState(root,error);').replace('  async function getContext(contextOptionsOverride = null) {',`  async function getContext(contextOptionsOverride = null) { if(globalThis.__openingGate)await globalThis.__openingGate;if(globalThis.__openingFault)throw new Error('memory_suite_server_unavailable');`)});
 const gui=createColdStartGuiDocument();Object.assign(f.context,{document:gui.document,window:gui.dom.window,HTMLInputElement:gui.dom.window.HTMLInputElement,HTMLTextAreaElement:gui.dom.window.HTMLTextAreaElement,HTMLSelectElement:gui.dom.window.HTMLSelectElement});t.after(async()=>{await f.dispose();gui.dom.window.close();});assert(open);return {f,gui,open};
}
test('LIA local workspace contains a read error, retains persona data and restores the full UI on retry',async t=>{
 const {f,gui,open}=await lia(t),before=JSON.stringify(f.db.personas),binding=f.liveChat.bindedPersona;f.context.__openingFault=true;
 await open();assert(gui.document.querySelector('[data-lia-preview-state="failed"]'));assert.match(gui.document.body.textContent,/LIA는 로컬 저장소/);
 assert.equal(gui.document.querySelector('[data-opening-settings]'),null);snapshot(gui,'lia-failed');
 f.context.__openingFault=false;gui.document.querySelector('[data-lia-preview-retry]').click();
 await until(()=>!gui.document.querySelector('[data-lia-preview-state]'),'LIA restored').catch(e=>{e.message+='; '+f.context.__openingLastError;throw e});snapshot(gui,'lia-recovered');
 assert.equal(JSON.stringify(f.db.personas),before);assert.equal(f.liveChat.bindedPersona,binding);assert.deepEqual(gui.errors,[]);
});
test('LIA closing a pending read rejects late rendering and reopening can read again',async t=>{
 const {f,gui,open}=await lia(t),gate=deferred();f.context.__openingGate=gate.promise;const opening=open();
 await until(()=>gui.document.querySelector('[data-lia-preview-close]'),'LIA loading');gui.document.querySelector('[data-lia-preview-close]').click();
 gate.resolve();await opening;assert.equal(gui.document.querySelector('.stage').hidden,true);
 f.context.__openingGate=null;await open();assert.equal(gui.document.querySelector('.stage').hidden,false);assert.equal(gui.document.querySelector('[data-lia-preview-state]'),null,f.context.__openingLastError);
});
