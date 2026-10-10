'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
const {fixture}=require('./helpers/updater_fixture.cjs');
const {applyProgramOnly,recoverInterruptedProgramOnly}=require('../../UPDATER/core/program-only.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 if(process.argv[2]==='hold'){
   const root=process.argv[3];await applyProgramOnly({rootDir:root,receipt:{updatePolicy:'program_only',targetVersion:'0.3.52',programNext:path.join(root,'.update/PROGRAM.next')},hooks:{stopServer:async()=>{fs.writeFileSync(path.join(root,'.update/holder-ready'),'ready');await delay(60000);return{wasRunning:false};}}});return;
 }
 const f=await fixture();const child=spawn(process.execPath,['--no-warnings',__filename,'hold',f.root],{stdio:'ignore'});const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 try{
   const deadline=Date.now()+10000;while(!fs.existsSync(f.p('.update/holder-ready'))&&Date.now()<deadline)await delay(20);
   assert.ok(fs.existsSync(f.p('.update/holder-ready')),'child updater must reach checkpoint barrier');
   await assert.rejects(()=>recoverInterruptedProgramOnly({rootDir:f.root}),/updater_already_running/,'another updater must not recover a live transaction');
   child.kill('SIGKILL');await exited;
   const result=await recoverInterruptedProgramOnly({rootDir:f.root});assert.equal(result.journal.status,'rolled_back');assert.equal(fs.readFileSync(f.p('DATA/value'),'utf8'),'BEFORE');
   console.log('remote_update_operation_lock_test: PASS');
 }finally{child.kill('SIGKILL');await exited;f.cleanup();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
