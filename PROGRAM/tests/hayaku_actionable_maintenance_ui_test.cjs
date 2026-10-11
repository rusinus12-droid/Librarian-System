'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const run={hidden:false,disabled:false},button={},box={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null},card={innerHTML:'',querySelector:()=>button};
const root={querySelector:s=>s==='#hayakuMissingTurnPicker'?box:s==='#runHayakuNativeRepair'?run:s==='#hayakuSourceEditConsent'?card:null};
let refreshes=0, mounts=0;
const c=vm.createContext({getHayakuSourceEdits:()=>({mountControls:target=>{assert(target===card||target===null);mounts++;}}),Memory:{ledgerViewer:{root,activeTab:'recovery',scope:{key:'scope',confident:true}}},Set,Map,Number,Array,text:v=>String(v??''),ensureArray:v=>Array.isArray(v)?v:[],viewerEscapeHtml:v=>String(v??''),viewerScopeFields:rows=>JSON.stringify(rows),hayakuRecoverySourceRowMatches:(a,b)=>a?.sourceDigest===b?.sourceDigest,viewerRenderNativeRecovery:()=>refreshes++});
vm.runInContext(section('  const viewerRenderMissingTurnSelection=','  const viewerRenderNativeRecovery =')+'\nglobalThis.render=viewerRenderMissingTurnSelection;',c);
vm.runInContext(section('  function viewerRenderSourceEditConsent(','  const viewerRenderHostLineage ='),c);
const row=(turn,state)=>({turn,state,sourceDigest:'v1',label:state,recoveryExecutable:state==='missing'});
c.render({rows:[row(1,'covered'),row(2,'source_edit_pending'),row(3,'user_suppressed')]},'scope');
assert.match(box.innerHTML,/선택할 누락 턴이 없습니다/);assert(!box.innerHTML.includes('data-missing-turn'));assert(!box.innerHTML.includes('data-missing-action'));assert.equal(run.hidden,true);
c.render({rows:[row(1,'covered'),row(2,'missing'),row(3,'source_edit_pending'),row(4,'missing')]},'scope');
assert(!box.innerHTML.includes('data-missing-turn="1"'));assert(!box.innerHTML.includes('data-missing-turn="3"'));assert(box.innerHTML.includes('data-missing-turn="2"'));assert(box.innerHTML.includes('data-missing-turn="4"'));assert.equal(run.hidden,false);
c.Memory.ledgerViewer.missingTurnSelection.selected.add(2);
c.render({rows:[row(2,'covered')]},'scope');assert.equal(c.Memory.ledgerViewer.missingTurnSelection.selected.size,0);assert.equal(run.hidden,true);
for(const coverage of [{},{rows:[],sourceEditError:'read_failure'}]){c.render(coverage,'scope');assert.match(box.innerHTML,/조회 실패/);assert.match(box.innerHTML,/data-missing-action="refresh"/);assert(!box.innerHTML.includes('선택할 누락 턴이 없습니다'));assert.equal(run.hidden,true);}
c.render({rows:[row(2,'missing')]},'scope');c.render({},'scope',false,'network_failed');assert(!box.innerHTML.includes('data-missing-turn'));assert.equal(run.hidden,true);
// Source-edit history is retired; the replacement UI consumes an explicit
// current-scope range inventory. Its async selection/busy/error/scope behavior
// is exercised by hayaku_gui_workspace_v346_runtime_test.cjs.
const reanalysis=section('  function viewerRenderSourceEditConsent(','  const viewerRenderHostLineage =');
assert.match(reanalysis,/listHayakuReanalysisRanges/);assert.match(reanalysis,/runHayakuSelectedReanalysis\(selection\)/);
assert.match(reanalysis,/scopeKey:inventory\.scopeKey,topology:inventory\.topology/);
assert.doesNotMatch(reanalysis,/getHayakuSourceEdits|reviewHayakuSourceEdits|sourceEditSyncStatus/);
console.log('PASS actionable-only rows, empty controls hidden, selection pruning, read errors, scope isolation and explicit current-range UI contract');
