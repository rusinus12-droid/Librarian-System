'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {test}=require('node:test');const {checkNavigation,checkBookHeader,checkComputeMode}=require('./fixtures/current_ui_compute_contracts.cjs');
const read=name=>fs.readFileSync(path.join(__dirname,'../plugins',name),'utf8');const libra=read('LIBRA.js');
test('Book header tolerates relabeling but missing actionable settings control fails',()=>{
 checkBookHeader(libra);checkBookHeader(libra.replace('사서의 열람대 · 현재 기록을 읽고 다음 응답을 준비합니다','새로운 열람대 이름'));
 assert.throws(()=>checkBookHeader(libra.replace('sga-btn libra-book-settings-button','sga-btn removed-settings-control')),/required Book header control/);
});
test('pure server navigation tolerates formatting but wrong route fails',()=>{
 checkNavigation(libra);checkNavigation(libra.replace("if(['server','transfer','source_edits'].includes(requested))return{pageId:'settings',settingsHubSection:requested};","if ( ['server', 'transfer', 'source_edits'].includes(requested) ) { return { pageId: 'settings', settingsHubSection: requested }; }"));
 assert.throws(()=>checkNavigation(libra.replace("if(['server','transfer','source_edits'].includes(requested))return{pageId:'settings',settingsHubSection:requested};","if(['server','transfer','source_edits'].includes(requested))return{pageId:'memory'};")),/legacy settings route: server/);
});
for(const [file,bridge]of [['HAYAKU_Locator_Continuity.js','MemorySuiteHayakuComputeBridge'],['LIBRA.js','MemorySuiteLibraComputeBridge'],['LIA_Persona_Linker.js','MemorySuiteLiaComputeBridge']])test(file+': scope mode survives long formatting but missing policy mode fails',()=>{
 const source=read(file);checkComputeMode(source,bridge);checkComputeMode(source.replaceAll('mode: executionPolicy.computeMode','/*'+'padding '.repeat(300)+'*/ mode : executionPolicy . computeMode'),bridge);
 assert.throws(()=>checkComputeMode(source.replaceAll('mode: executionPolicy.computeMode',"mode: 'local'"),bridge),/mode derives from scope policy/);
});
test('Flashback current vector-search path survives formatting but missing consumer fails',()=>{
 const source=read('Flashback_Memory.js');checkComputeMode(source,null,{flashback:true});checkComputeMode(source.replace('mode:policy.computeMode','/*'+'padding '.repeat(300)+'*/ mode : policy . computeMode'),null,{flashback:true});
 assert.throws(()=>checkComputeMode(source.replaceAll('MemorySuiteFlashbackSearchClient.vectors','MemorySuiteFlashbackSearchClient.removedVectors'),null,{flashback:true}),/calls the current vector-search client/);
 assert.throws(()=>checkComputeMode(source.replace('mode:policy.computeMode',"mode:'local'"),null,{flashback:true}),/mode derives from scope policy/);
});
