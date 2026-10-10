"use strict";
// Approved three-group settings replaced the retired numbered accordion layout.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {loadGui}=require('./libra_management_gui_integration_test.cjs');
const checks=[];
(async()=>{const seed={weights:{similarity:0.67,importance:0.21,recency:0.12},injectionBudgetMaxTokens:1600,rpLongTermLongTtl:777,hybridMemoryEngineEnabled:true};
const store=new Map([['LMAI_Config',JSON.stringify(seed)]]),f=await loadGui({store});
const check=(name,fn)=>{try{fn();checks.push({name,ok:true})}catch(e){checks.push({name,ok:false,error:e.stack});process.exitCode=1}};
try{
const o=f.overlay,tab=o.querySelector('#tab-settings'),source=fs.readFileSync(path.join(__dirname,'../src/parts/15a-gui-session-data.js'),'utf8');
check('composer_exists_and_is_invoked',()=>{assert(source.includes('const composeSettingsPanelLayout = () => {'));assert(source.includes('composeSettingsPanelLayout();'));assert.equal(tab.dataset.libraLayoutComposed,'1')});
check('exactly_three_ordered_groups',()=>assert.deepEqual(Array.from(tab.querySelectorAll('[data-settings-group]')).map(n=>n.dataset.settingsGroup),['ai','memory','story']));
check('groups_have_current_user_titles',()=>assert.deepEqual(Array.from(tab.querySelectorAll('[data-settings-group] > h3')).map(n=>n.textContent),['AI 연결','기억','이야기']));
check('composer_idempotence_guard_and_single_storage_panel',()=>{assert(source.includes("tab.dataset.libraLayoutComposed === '1'"));assert.equal(o.querySelectorAll('[data-wm-storage-panel]').length,1)});
check('memory_controls_remain_reachable',()=>{for(const id of ['semotion','srag','sreg'])assert(o.querySelector('#'+id)?.closest('#tab-memory'),id)});
check('entity_and_world_controls_remain_reachable',()=>{for(const id of ['ssecret','svault'])assert(o.querySelector('#'+id)?.closest('#tab-entity'),id);assert(o.querySelector('#sswi')?.closest('#tab-world'))});
check('work_controls_remain_reachable',()=>{for(const id of ['screfl','spsync','scbs','sstream','sbypass','sapara'])assert(o.querySelector('#'+id)?.closest('#tab-work'),id)});
check('supported_injection_budget_stays_in_memory_group',()=>assert(o.querySelector('#sinjbp')?.closest('[data-settings-group="memory"]')));
check('retired_numeric_controls_are_absent',()=>{for(const id of ['swmode','swsim','swimp','swrec','sscprof','smaxlimit','sthr','ssimthr','sinjbtok','shme','shmegraph','shmedbg','srplt','srplttl','srplchars'])assert.equal(o.querySelector('#'+id),null,id)});
check('health_cache_storage_and_transfer_tools_remain_in_work',()=>{for(const id of ['btn-health-scan','lmai-cache-reset','btn-export-settings-file','btn-import-settings-file','btn-reset-settings','lmai-data-reset'])assert(o.querySelector('#'+id)?.closest('#tab-work'),id);assert(o.querySelector('#tab-work [data-wm-storage-panel]'))});
check('opening_layout_preserves_retired_control_values_and_performs_no_settings_write',()=>{assert.equal(store.get('LMAI_Config'),JSON.stringify(seed));assert.equal(f.calls.writes.filter(x=>x.key==='LMAI_Config').length,0)});
}finally{f.close()}
console.log(JSON.stringify({ok:checks.every(x=>x.ok),expectedCount:11,checks},null,2));
})().catch(error=>{console.error(error);process.exitCode=1});
