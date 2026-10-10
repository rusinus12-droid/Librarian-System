'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const {fixture}=require('./helpers/updater_fixture.cjs');
const core=require('../../UPDATER/core/program-only.cjs');
const points=['checkpoint_copy','old_program_rename','candidate_activate','candidate_start','candidate_verified','rollback_program_quarantine','rollback_program_restore','rollback_data_quarantine','rollback_data_restore','rollback_restored','committed'];
(async()=>{
 if(process.argv[2]==='child'){
   const root=process.argv[3],point=process.argv[4];const p=rel=>path.join(root,rel);let fired=false;
   function kill(){if(fired)return;fired=true;fs.writeFileSync(p('.update/killed-at'),point);process.kill(process.pid,'SIGKILL');}
   const rename=fs.promises.rename.bind(fs.promises);
   fs.promises.rename=async(a,b)=>{
     const result=await rename(a,b);const from=path.relative(root,a).split(path.sep).join('/'),to=path.relative(root,b).split(path.sep).join('/');
     if((point==='old_program_rename'&&from==='PROGRAM'&&to.startsWith('.rollback/'))
       ||(point==='candidate_activate'&&from==='.update/PROGRAM.next')
       ||(point==='rollback_program_quarantine'&&from==='PROGRAM'&&to.startsWith('.update/failed-'))
       ||(point==='rollback_program_restore'&&from.startsWith('.rollback/')&&from.endsWith('/PROGRAM')&&to==='PROGRAM')
       ||(point==='rollback_data_quarantine'&&from==='DATA'&&to.startsWith('.update/failed-'))
       ||(point==='rollback_data_restore'&&from.endsWith('/DATA-checkpoint/DATA')&&to==='DATA'))kill();
     if(to==='UPDATER/update-state.json'){
       const j=JSON.parse(fs.readFileSync(b));
       if((point==='candidate_verified'&&j.phase==='candidate_verified')||(point==='committed'&&j.status==='committed')||(point==='rollback_restored'&&j.status==='rollback_restored'))kill();
     }
     return result;
   };
   const open=fs.promises.open.bind(fs.promises);
   fs.promises.open=async(file,...args)=>{const result=await open(file,...args);if(point==='checkpoint_copy'&&String(file).includes('DATA-checkpoint'+path.sep+'DATA'+path.sep))kill();return result;};
   await core.applyProgramOnly({rootDir:root,receipt:{updatePolicy:'program_only',targetVersion:'0.3.52',programNext:p('.update/PROGRAM.next')},
     failpointEnv:point.startsWith('rollback_')?{LIBRARIAN_UPDATER_FAILPOINT:'after_candidate_start'}:{},
     hooks:{stopServer:async()=>({wasRunning:false}),integrity:()=>{},startServer:async()=>{fs.writeFileSync(p('DATA/value'),'CANDIDATE');if(point==='candidate_start')kill();return{ok:true,version:'0.3.52',dataInstanceId:core.dataInstanceId(p('DATA')),dataIdentityContract:'memory-suite.physical-data-identity.v1',maintenanceMode:true};}}});
   throw new Error('requested kill boundary was not reached:'+point);
 }
 let failures=0;
 for(const point of points){const f=await fixture();try{
   const child=spawnSync(process.execPath,['--no-warnings',__filename,'child',f.root,point],{encoding:'utf8',timeout:20000});
   assert.equal(fs.readFileSync(f.p('.update/killed-at'),'utf8'),point,child.stderr);assert.notEqual(child.status,0);
   if(process.platform!=='win32')assert.equal(child.signal,'SIGKILL');
   if(point==='rollback_restored')fs.writeFileSync(f.p('DATA/value'),'AFTER-RESTORE');
   const recovered=await core.recoverInterruptedProgramOnly({rootDir:f.root});
   assert.equal(recovered.journal.status,point==='committed'?'complete':'rolled_back');
   assert.equal(fs.readFileSync(f.p('PROGRAM/VERSION.txt'),'utf8').trim(),point==='committed'?'0.3.52':'0.3.51');
   assert.equal(fs.readFileSync(f.p('DATA/value'),'utf8'),point==='committed'?'CANDIDATE':point==='rollback_restored'?'AFTER-RESTORE':'BEFORE');
   assert.equal((await core.recoverInterruptedProgramOnly({rootDir:f.root})).recovered,false);
   console.log('PASS: actual process termination at '+point);
 }catch(e){failures++;console.error('FAIL: '+point+' :: '+e.message);}finally{f.cleanup();}}
 assert.equal(failures,0);console.log('remote_update_sigkill_recovery_test: PASS');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
