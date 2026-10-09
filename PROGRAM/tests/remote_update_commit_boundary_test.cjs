'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');
const {fixture}=require('./helpers/updater_fixture.cjs');
const {applyProgramOnly,recoverInterruptedProgramOnly,dataInstanceId}=require('../../UPDATER/core/program-only.cjs');
(async()=>{let failures=0;
 for(const liveFailure of [false,true]){const f=await fixture();let sawDurableCommit=false;try{
   const hooks={stopServer:async()=>({wasRunning:true}),integrity:()=>{},startServer:async(_p,_d,{verifyMode})=>{
     if(!verifyMode){const state=JSON.parse(fs.readFileSync(f.p('UPDATER/update-state.json')));sawDurableCommit=state.decision==='commit'&&!!state.committedAt;fs.writeFileSync(f.p('DATA/value'),'POST-COMMIT-WRITE');if(liveFailure)throw new Error('live_start_failed_after_accepting_write');}
     return {ok:true,version:'0.3.52',dataInstanceId:dataInstanceId(f.p('DATA')),dataIdentityContract:'memory-suite.physical-data-identity.v1',maintenanceMode:!!verifyMode};}};
   if(liveFailure)await assert.rejects(()=>applyProgramOnly({rootDir:f.root,receipt:f.receipt,hooks}),/live_start_failed_after_accepting_write/);
   else assert.equal((await applyProgramOnly({rootDir:f.root,receipt:f.receipt,hooks})).status,'complete');
   assert.equal(sawDurableCommit,true,'commit must be durable BEFORE first live write');
   assert.equal(fs.readFileSync(f.p('PROGRAM/VERSION.txt'),'utf8').trim(),'0.3.52');
   assert.equal(fs.readFileSync(f.p('DATA/value'),'utf8'),'POST-COMMIT-WRITE');
   if(liveFailure){const state=JSON.parse(fs.readFileSync(f.p('UPDATER/update-state.json')));state.serverWasRunning=false;fs.writeFileSync(f.p('UPDATER/update-state.json'),JSON.stringify(state));const r=await recoverInterruptedProgramOnly({rootDir:f.root});assert.equal(r.journal.status,'complete');assert.equal(fs.readFileSync(f.p('DATA/value'),'utf8'),'POST-COMMIT-WRITE');}
   console.log('PASS: commit/live-failure='+liveFailure);
 }catch(e){failures++;console.error('FAIL: commit/live-failure='+liveFailure+' :: '+e.message);}finally{f.cleanup();}}
 assert.equal(failures,0);console.log('remote_update_commit_boundary_test: PASS');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
