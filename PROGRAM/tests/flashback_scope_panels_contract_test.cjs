'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const raw=fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8');
(async()=>{const f=await createFixture({source:raw.replace('_test: { maintenanceResultText,','_test: { buildUiHtml,buildImportTab,maintenanceResultText,')});try{
const html=await f.api._test.buildUiHtml();for(const tab of ['source-edits','restore']){assert.ok(html.includes(`id="panel-${tab}"`));assert.ok(html.includes(`id="tab-${tab}"`));}
assert.ok(!f.api._test.buildImportTab().includes('data-portable-backup-host'));assert.ok(!f.api._test.buildImportTab().includes('fbSourceEditTitle'));
for(const id of ['cleanupSelectedScopesBtn','selectCleanupCandidatesBtn','selectOrphanScopesBtn','storageManagementView'])assert.ok(html.includes(`id="${id}"`),id);
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);for(const id of ['fbSourceEditTitle','panel-restore','panel-source-edits'])assert.equal(ids.filter(x=>x===id).length,1,id);assert.equal((html.match(/data-portable-backup-host="flashback_memory"/g)||[]).length,1);
assert.ok(!raw.includes('manifest 확인·메타데이터 복구'));assert.ok(raw.includes('현재 활성 채팅 없음'));
assert.ok(raw.includes("if (activeTab === 'source-edits') await refreshFlashbackSourceEditPanel()"));
console.log('flashback_scope_panels_contract_test: PASS');}finally{await f.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});
