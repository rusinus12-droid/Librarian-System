'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {test}=require('node:test');const {checkNavigation,checkBookHeader,checkComputeRetired}=require('./fixtures/current_ui_compute_contracts.cjs');
const read=name=>fs.readFileSync(path.join(__dirname,'../plugins',name),'utf8');const libra=read('LIBRA.js');
test('Book header tolerates relabeling but missing actionable settings control fails',()=>{
 checkBookHeader(libra);checkBookHeader(libra.replace('사서의 열람대 · 현재 기록을 읽고 다음 응답을 준비합니다','새로운 열람대 이름'));
 assert.throws(()=>checkBookHeader(libra.replace('sga-btn libra-book-settings-button','sga-btn removed-settings-control')),/required Book header control/);
});
test('pure server navigation tolerates formatting but wrong route fails',()=>{
 checkNavigation(libra);checkNavigation(libra.replace("if(['server','transfer','source_edits'].includes(requested))return{pageId:'settings',settingsHubSection:requested};","if ( ['server', 'transfer', 'source_edits'].includes(requested) ) { return { pageId: 'settings', settingsHubSection: requested }; }"));
 assert.throws(()=>checkNavigation(libra.replace("if(['server','transfer','source_edits'].includes(requested))return{pageId:'settings',settingsHubSection:requested};","if(['server','transfer','source_edits'].includes(requested))return{pageId:'memory'};")),/legacy settings route: server/);
});
for(const file of ['HAYAKU_Locator_Continuity.js','LIBRA.js','LIA_Persona_Linker.js','Flashback_Memory.js'])test(file+': retired Compute stays absent and a reintroduced bridge fails',()=>{
 const source=read(file);checkComputeRetired(source);
 assert.throws(()=>checkComputeRetired(source+'\nconst MemorySuiteReintroducedComputeBridge=createMemorySuiteComputeBridge({});'),/no retired Compute bridge or search client is created/);
});
