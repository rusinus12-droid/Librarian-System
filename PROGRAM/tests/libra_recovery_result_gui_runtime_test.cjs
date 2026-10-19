'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {create,until}=require('./fixtures/libra_gui_memory_dom_host.cjs');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'libra-recovery-result-')),pluginPath=path.join(dir,'LIBRA.js');let f;
 try{
  const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8'),marker='  const publicApi = Object.freeze({\n    getHostLineageStatus:';
  assert.ok(source.includes(marker));fs.writeFileSync(pluginPath,source.replace(marker,'  globalThis.__recoveryResultTest={bookRecoveryResult,openApprovedRecoveryJob};\n'+marker));
  f=await create('LIBRA','Full',{pluginPath});await f.open();await until(()=>f.doc.querySelector('.sidebar'),'GUI shell');const api=f.context.__recoveryResultTest;
  const cases=[
   ['micro',null,'pending'],['micro',{status:'pending_reconciliation'},'pending'],
   ['micro',{status:'verified',record:{analysisStatus:'minimum_source_bound'}},'pending'],
   ['micro',{status:'verified',record:{analysisStatus:'verified'},stateAdmission:{pending:1}},'pending'],
   ['micro',{status:'verified',record:{analysisStatus:'verified'},stateAdmission:{pendingReconciliation:1}},'pending'],
   ['micro',{status:'verified',record:{analysisStatus:'verified'},stateAdmission:{admitted:2}},'completed'],
   ['receipt',{status:'verified'},'completed'],['receipt',{status:'unavailable'},'pending']
  ];
  for(const [kind,result,outcome] of cases){
   const shown=api.bookRecoveryResult(kind,result);assert.equal(shown.outcome,outcome);
   const finish=api.openApprovedRecoveryJob(kind,'실행 결과',{scopeKey:'audit'});finish(shown.message,shown.outcome);
   const job=f.doc.querySelector('#job-recover');assert.equal(job.dataset.recoveryOutcome,outcome);
   assert.equal(job.querySelectorAll('.step.is-done').length===job.querySelectorAll('.step').length,outcome==='completed');
   if(outcome==='pending')assert.ok(job.textContent.includes('확인 필요'));
   job.querySelector('.dialog__actions button').click();assert.equal(f.doc.querySelector('#job-recover'),null);
  }
  const finish=api.openApprovedRecoveryJob('micro','error',{scopeKey:'audit'});finish('write failure',true);
  assert.equal(f.doc.querySelector('#job-recover').dataset.recoveryOutcome,'failed');assert.equal(f.doc.querySelectorAll('#job-recover .step.is-fail').length,1);
  assert.deepEqual(f.errors,[]);assert.equal(f.wire.length,0);
  console.log('libra_recovery_result_gui_runtime_test: PASS (8 recovery outcomes, real job DOM phases, pending readback, failed analysis, zero model/network calls)');
 }finally{await f?.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
