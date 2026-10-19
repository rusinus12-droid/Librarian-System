'use strict';

const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(process.env.RETRACE_SOURCE_FILE||path.join(__dirname,'../plugins/RETRACE.js'),'utf8');
const section=(start,end)=>{
  const a=source.indexOf(start),b=source.indexOf(end,a);
  assert.ok(a>=0&&b>a,`source boundary: ${start}`);return source.slice(a,b);
};
const dom=new JSDOM('<body><span id="serverNavCount"></span><div id="serverDataBody"></div></body>');
const rows=[
  {scopeId:'active',classification:'active'},
  {scopeId:'orphan',classification:'orphan_candidate'},
  {scopeId:'pinned',classification:'orphan_candidate',pinned:true},
  {scopeId:'ancestor',classification:'referenced_ancestor',referenceCount:1},
  {scopeId:'unknown',classification:'unverified'},
  {scopeId:'paired',classification:'paired_recovery'}
].map(row=>({namespace:'flashback',kind:'chat_memory',coverageComplete:true,displayName:row.scopeId,members:[],...row}));
const key=row=>row.namespace+'|'+row.scopeId;
const Runtime={root:dom.window.document.body,serverScopeSelection:new Set(),serverScopeRecipes:new Map(rows.map(row=>[key(row),[{}]])),
  serverScopePlans:new Map(),serverScopeCatalog:{scopes:rows,hostInventory:{stable:true,chatCount:1},at:Date.now()}};
const deps={Runtime,scopeManagerArray:v=>Array.isArray(v)?v:[],scopeManagerText:v=>String(v??''),scopeManagerRecipeKey:(ns,id)=>ns+'|'+id,
  scopeManagerFormatBytes:v=>String(v??0),formatNumber:v=>String(v),escapeHtml:v=>String(v??''),compact:v=>String(v??''),
  syncServerDeleteControls(){},scopeManagerPairingPanelHtml:()=>'',scopeManagerPairable:()=>false,
  MEMORY_SUITE_SCOPE_STATUS_ORDER:['active','referenced_ancestor','orphan_candidate','unverified','paired_recovery'],
  MEMORY_SUITE_SCOPE_STATUS_LABELS:{active:'활성',orphan_candidate:'고아 후보'},MEMORY_SUITE_NAMESPACE_LABELS:{flashback:'Flashback'},
  SERVER_SCOPE_MANAGER_PAGE_SIZE:60};
const code=section('  const scopeManagerFormatTime =','  const scopeManagerPairableKinds =')
  +section('  const renderServerScopeManagement =','  const scopeManagerTogglePinned =')
  +section('  const scopeManagerSelectedScopes =','  const scopeManagerRunDeletion =')
  +section('  const handleServerScopeManagementClick =','  const MEMORY_SUITE_OWNER_STATUS_ORDER =');
const api=new Function(...Object.keys(deps),code+'return {renderServerScopeManagement,handleServerScopeManagementClick,scopeManagerSelectedScopes,scopeManagerFormatTime};')(...Object.values(deps));
const document=dom.window.document;
(async()=>{
  api.renderServerScopeManagement();
  assert.equal(document.querySelector('#serverNavCount').textContent,'6','completed scan updates the navigation badge');
  const active=document.querySelector('[data-server-scope-select="flashback|active"]');
  assert.equal(active.disabled,true,'active scopes require the separate owner-proof action');
  assert.equal(document.querySelector('[data-server-scope-delete="flashback|active"]').disabled,false,
    'individual active-scope cleanup remains available through its existing protection procedure');
  const click=selector=>api.handleServerScopeManagementClick({target:document.querySelector(selector)});
  await click('[data-server-scope-select-all]');
  assert.deepEqual([...Runtime.serverScopeSelection],['flashback|orphan']);
  assert.equal(document.querySelectorAll('[data-server-scope-select]:checked').length,1);
  assert.match(document.querySelector('.toolbar').textContent,/일괄 선택 가능 1개 · 선택 1개/);
  Runtime.serverScopeSelection.add('flashback|active');
  assert.deepEqual(api.scopeManagerSelectedScopes().map(row=>row.scopeId),['orphan'],'a stale active selection cannot enter a batch');
  await click('[data-server-scope-select-clear]');
  assert.equal(Runtime.serverScopeSelection.size,0);
  rows.find(row=>row.scopeId==='orphan').pinned=true;
  api.renderServerScopeManagement();
  assert.equal(document.querySelector('[data-server-scope-select-all]').disabled,true);
  assert.equal(document.querySelector('[data-server-scope-delete-selected]').disabled,true);
  const timestamp=Date.parse('2026-10-19T01:00:00.000Z');
  assert.equal(api.scopeManagerFormatTime(timestamp),api.scopeManagerFormatTime('2026-10-19T01:00:00.000Z'));
  assert.equal(api.scopeManagerFormatTime(String(timestamp)),api.scopeManagerFormatTime(timestamp));
  for(const value of [null,'',0,'invalid',NaN,Infinity,1e30])assert.equal(api.scopeManagerFormatTime(value),'-');
  console.log('retrace_server_bulk_selection_runtime_test: PASS (protected active/ancestor/pinned/paired/unknown scopes, exact batch count, ISO/epoch dates)');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>dom.window.close());
