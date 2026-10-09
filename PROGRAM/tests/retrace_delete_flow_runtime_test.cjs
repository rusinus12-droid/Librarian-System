'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const text=fs.readFileSync(path.join(__dirname,'../plugins/RETRACE.js'),'utf8');
const start=text.indexOf('  const scopeManagerRunDeletion ='),end=text.indexOf('  const scopeManagerHandleSelectedDeletion =',start);
assert.ok(start>0&&end>start);
(async()=>{
 let confirms=0,executions=0,refreshes=0,saved=null,fail=true;
 const Runtime={busy:false,root:{querySelector:()=>({textContent:''})},serverScopeSelection:new Set()};
 const rows=['one','two'].map(scopeId=>({namespace:'flashback',scopeId,displayName:scopeId}));
 const deps={Runtime,syncServerDeleteControls(){},MEMORY_SUITE_NAMESPACE_LABELS:{flashback:'Flashback'},retraceConfirm:async()=>{confirms++;return true;},setBusy:b=>Runtime.busy=b,legacyStorageSet:async(k,v)=>{saved=JSON.parse(JSON.stringify(v));return true;},scopeManagerSelectionKey:r=>r.namespace+'|'+r.scopeId,compact:s=>String(s),scopeManagerOwnerProof:async()=>({verified:true}),refreshServerScopeManagement:async()=>{refreshes++;},scopeManagerFindCatalogScope:(ns,id)=>rows.find(r=>r.scopeId===id),scopeManagerDeleteBlockedReason:()=>'',scopeManagerBuildPlanAfterProof:async r=>({planId:'plan-'+r.scopeId,mutationFingerprint:'fingerprint'}),scopeManagerExecutePlan:async r=>{executions++;if(r.scopeId==='two'&&fail)throw Error('response_lost');return {backupId:'backup'};},MemorySuiteStorageBridge:{bootstrap:async()=>({url:'http://localhost:47630',capabilities:{'scope-delete-job.v1':true}}),managerExecuteScopeDeletion:async(a,b,options)=>options?.statusOnly?{state:'committed'}:{backupId:'backup',recovered:true}}};
 const run=new Function(...Object.keys(deps),text.slice(start,end)+'\nreturn scopeManagerRunDeletion;')(...Object.values(deps));
 await run(rows);assert.equal(confirms,1);assert.equal(executions,2);assert.equal(Runtime.busy,false);assert.ok(saved.pending['flashback|two']);
 fail=false;await run(rows,saved);assert.equal(confirms,2,'one confirmation for an explicit retry');assert.equal(executions,2,'successful item is not reexecuted; uncertain result recovered by plan id');assert.equal(saved.rows.filter(r=>r.status==='삭제 완료').length,2);
 assert.ok(refreshes>=2,'shared recipes refreshed between deletions');
 console.log('retrace_delete_flow_runtime_test: PASS (one confirmation, automatic execution, durable pending, retry without duplicate deletion)');
})().catch(e=>{console.error(e);process.exitCode=1;});
