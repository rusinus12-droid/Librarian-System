'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {test}=require('node:test');const {checkNavigation,checkBookHeader,checkComputeRetired}=require('./fixtures/current_ui_compute_contracts.cjs');
const read=name=>fs.readFileSync(path.join(__dirname,'../plugins',name),'utf8');const libra=read('LIBRA.js');
test('Book header tolerates relabeling but missing actionable settings control fails',()=>{
 checkBookHeader(libra);checkBookHeader(libra.replace('<div class=\\"brand__name\\">LIBRA</div>','<div class=\\"brand__name\\">Renamed</div>'));
 assert.throws(()=>checkBookHeader(libra.replace('<button class=\\"btn btn--icon\\" data-go=\\"settings\\" aria-label=\\"설정\\">','<button class=\\"btn btn--icon\\" aria-label=\\"설정\\">')),/required Book header control/);
});
test('pure server navigation tolerates formatting but wrong route fails',()=>{
 checkNavigation(libra);checkNavigation(libra.replace("if(['server','transfer','source_edits'].includes(requested))return{pageId:'settings',settingsHubSection:requested};","if ( ['server', 'transfer', 'source_edits'].includes(requested) ) { return { pageId: 'settings', settingsHubSection: requested }; }"));
 assert.throws(()=>checkNavigation(libra.replace("if(['server','transfer','source_edits'].includes(requested))return{pageId:'settings',settingsHubSection:requested};","if(['server','transfer','source_edits'].includes(requested))return{pageId:'memory'};")),/legacy settings route: server/);
});
for(const file of ['HAYAKU_Locator_Continuity.js','LIBRA.js','LIA_Persona_Linker.js','Flashback_Memory.js'])test(file+': retired Compute stays absent and a reintroduced bridge fails',()=>{
 const source=read(file);checkComputeRetired(source);
 assert.throws(()=>checkComputeRetired(source+'\nconst MemorySuiteReintroducedComputeBridge=createMemorySuiteComputeBridge({});'),/no retired Compute bridge or search client is created/);
});
