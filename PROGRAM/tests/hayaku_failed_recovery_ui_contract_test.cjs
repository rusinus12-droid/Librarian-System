'use strict';
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');const s=fs.readFileSync(path.join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');
for(const fragment of ['data-hayaku-viewer-panel="failed_recovery"','id="hayakuViewerTabFailedRecovery"','name="hayaku_failed_recovery_automation"'])assert.ok(!s.includes(fragment),fragment);
for(const fragment of ['id="loadHayakuArchivedFailures"','id="hayakuArchivedFailures"',"makeButton('기억 생성', true)","makeButton('나중에')"])assert.ok(s.includes(fragment),fragment);
console.log('PASS old failure screen and paid settings removed; read-only diagnostics and simple consent retained');
