'use strict';
const assert = require('node:assert/strict'), path = require('node:path');
const {create,pause,until} = require('./fixtures/libra_gui_memory_dom_host.cjs');
const pluginPath = process.argv[2] || path.resolve(__dirname,'../plugins/LIBRA.js');
const {goSettings,field}=require('./helpers/libra_approved_gui_navigation.cjs');
const button = (s,label) => [...s.doc.querySelectorAll('button')].find(n=>n.textContent===label);
const edit = (s,value) => {const n=field(s,'통합 검색 최대 근거 수');n.value=String(value);n.dispatchEvent(new s.dom.window.Event('input',{bubbles:true}));};
async function boot(options={}) {const s=await create('LIBRA','Full',{...options,pluginPath});await s.open();await pause(300);await goSettings(s,options.initialSection||'memory');return s;}
async function settled(s){await until(()=>!s.doc.querySelector('[data-settings-room-save]').disabled,'save settled');await pause(100);}
async function save(s){s.doc.querySelector('[data-settings-room-save]').click();await settled(s);}
const rows=[];
async function test(name,body){let s;try{s=await body();rows.push({name,status:'PASS'});}catch(e){rows.push({name,status:'FAIL',error:e.stack});}finally{if(s)await s.close();}console.log(JSON.stringify(rows.at(-1)));}
async function using(options,fn){const s=await boot(options);try{await fn(s);assert.equal(s.wire.length,0);assert.deepEqual(s.errors,[]);}finally{await s.close();}}
(async()=>{
 for(const scenario of ['after memory editing','after draft discard','before first performance visit'])await test(`configuration import ${scenario} remains draft-only and saves`,async()=>using({initialSection:scenario==='before first performance visit'?'transfer':'performance'},async s=>{
   if(scenario!=='before first performance visit'){edit(s,16);await goSettings(s,'transfer');}
   if(scenario==='after draft discard')await s.click('[data-settings-room-revert]');
   const area=s.doc.querySelector('[data-configuration-transfer="json"]');area.value=JSON.stringify({runtime:{},memorySettings:{unifiedMaxUnits:18}});area.dispatchEvent(new s.dom.window.Event('input',{bubbles:true}));
   button(s,'병합 가져오기').click();await pause(100);
   assert.equal((await s.api.getLibraMemorySettings()).unifiedMaxUnits,24,'import must not change runtime before Save');
   await goSettings(s,'memory');assert.equal(field(s,'통합 검색 최대 근거 수').value,'18');
   await save(s);assert.equal(s.api.debugGuiSettingsState().dirty,false);assert.equal((await s.api.getLibraMemorySettings()).unifiedMaxUnits,18);
 }));
 await test('full configuration export includes unsaved recall draft like other GUI fields',async()=>using({},async s=>{
   edit(s,18);await goSettings(s,'transfer');const scope=field(s,'내보내기 범위');scope.value='all';scope.dispatchEvent(new s.dom.window.Event('change',{bubbles:true}));await pause(100);
   button(s,'JSON 만들기').click();await pause(100);
   assert.equal(JSON.parse(s.doc.querySelector('[data-configuration-transfer="json"]').value).memorySettings.unifiedMaxUnits,18);
   assert.equal((await s.api.getLibraMemorySettings()).unifiedMaxUnits,24);
 }));
 for(const fail of [false,true])await test(`external completed memory save survives GUI ${fail?'rollback':'commit attempt'}`,async()=>{
   let active=false,entered=false,release;const gate=new Promise(resolve=>{release=resolve});
   return using({beforeWrite:async(k)=>{if(active&&k==='libra:v1:runtime-settings'){active=false;entered=true;await gate;if(fail)throw Error('held_runtime_write_failure');}}},async s=>{
     edit(s,17);active=true;s.doc.querySelector('[data-settings-room-save]').click();await until(()=>entered,'runtime gate entered');
     await s.api.saveLibraMemorySettings({unifiedMaxUnits:14});release();await settled(s);
     assert.equal((await s.api.getLibraMemorySettings()).unifiedMaxUnits,14,'newer successful owner write is never reverted or overwritten');
     assert.equal(JSON.parse(s.values.get('libra:v1:memory-settings')).unifiedMaxUnits,14);
     assert.equal(s.api.debugGuiSettingsState().dirty,true);assert.equal(field(s,'통합 검색 최대 근거 수').value,'17');
   });
 });
 await test('editing while a save is pending keeps the newer unsaved draft',async()=>{
   let active=false,entered=false,release;const gate=new Promise(resolve=>{release=resolve});
   return using({beforeWrite:async(k)=>{if(active&&k==='libra:v1:runtime-settings'){active=false;entered=true;await gate;}}},async s=>{
     edit(s,17);active=true;s.doc.querySelector('[data-settings-room-save]').click();await until(()=>entered,'runtime gate entered');edit(s,18);release();await settled(s);
     assert.equal((await s.api.getLibraMemorySettings()).unifiedMaxUnits,17);assert.equal(field(s,'통합 검색 최대 근거 수').value,'18');assert.equal(s.api.debugGuiSettingsState().dirty,true);
     assert.match(s.doc.querySelector('[data-settings-room-save-status]').textContent,/아직 저장되지/);
     await save(s);assert.equal((await s.api.getLibraMemorySettings()).unifiedMaxUnits,18);assert.equal(s.api.debugGuiSettingsState().dirty,false);
   });
 });
 for(const externalValue of [14,17])await test(`a later owner save ${externalValue} survives failure after the GUI memory write`,async()=>{
   let active=false,entered=false,release;const gate=new Promise(resolve=>{release=resolve});
   return using({beforeRemove:async k=>{if(active&&k==='libra:v1:settings-transaction-journal'){active=false;entered=true;await gate;throw Error('held_journal_clear_failure');}}},async s=>{
     edit(s,17);active=true;s.doc.querySelector('[data-settings-room-save]').click();await until(()=>entered,'journal gate entered');
     await s.api.saveLibraMemorySettings({unifiedMaxUnits:externalValue});release();await settled(s);
     assert.equal((await s.api.getLibraMemorySettings()).unifiedMaxUnits,externalValue);
     assert.equal(JSON.parse(s.values.get('libra:v1:memory-settings')).unifiedMaxUnits,externalValue,'rollback must retain a later owner publication, including the same value');
     assert.equal(s.api.debugGuiSettingsState().dirty,true);
   });
 });
 await test('room and quick drawer share one transaction and lock both revert controls',async()=>{
   let active=false,entered=false,release;const gate=new Promise(resolve=>{release=resolve});
   return using({beforeWrite:async k=>{if(active&&k==='libra:v1:runtime-settings'){active=false;entered=true;await gate;}}},async s=>{
     await save(s);edit(s,17);const live=field(s,'최근 대화 최대 턴');live.value='3';live.dispatchEvent(new s.dom.window.Event('input',{bubbles:true}));
     const before=s.writes.filter(w=>w.key==='libra:v1:settings-transaction-journal').length;
     active=true;s.doc.querySelector('[data-settings-room-save]').click();await until(()=>entered,'runtime gate entered');await s.click('.topbar [data-open="drawer-quick"]');
     try {
       assert.equal(s.doc.querySelector('[data-book-quick-revert]').disabled,true,'newly opened drawer cannot revert an in-flight room save');
       s.doc.querySelector('#drawer-quick [data-gui-save-label]').dispatchEvent(new s.dom.window.MouseEvent('click',{bubbles:true}));await pause(100);
       assert.equal(s.writes.filter(w=>w.key==='libra:v1:settings-transaction-journal').length-before,1,'one shared transaction journal');
       assert.equal(s.doc.querySelector('[data-book-quick-revert]').disabled,true);
     } finally {release();await settled(s);}
     assert.equal((await s.api.getLibraMemorySettings()).unifiedMaxUnits,17);assert.equal(s.api.debugGuiSettingsState().state.runtime.liveTailMaxTurns,3);
   });
 });
 await test('failed memory rollback is explicitly disclosed as a possible partial save',async()=>{
   let journalFailure=false,blockRollback=false;
   return using({failRemoves:k=>{if(journalFailure&&k==='libra:v1:settings-transaction-journal'){journalFailure=false;blockRollback=true;return true;}return false;},failWrites:(k,v)=>blockRollback&&k==='libra:v1:memory-settings'&&JSON.parse(v).unifiedMaxUnits===24},async s=>{
     await save(s);edit(s,17);journalFailure=true;await save(s);
     assert.equal(JSON.parse(s.values.get('libra:v1:memory-settings')).unifiedMaxUnits,17);
     assert.equal(s.api.debugGuiSettingsState().dirty,true);
     assert.match(s.doc.querySelector('[data-settings-room-save-status]').textContent,/복원.*못|일부.*저장|일부.*적용/);
   });
 });
 console.log(JSON.stringify({pluginPath,rows},null,2));if(rows.some(r=>r.status==='FAIL'))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
