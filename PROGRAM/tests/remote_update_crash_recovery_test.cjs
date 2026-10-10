'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {applyProgramOnly,recoverInterruptedProgramOnly,dataInstanceId}=require('../../UPDATER/core/program-only.cjs');
const identity=require('../../UPDATER/core/data-identity.cjs');
function setup(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'librarian crash recovery '));for(const d of ['PROGRAM','DATA/config','UPDATER','.update/PROGRAM.next'])fs.mkdirSync(path.join(root,d),{recursive:true});fs.writeFileSync(path.join(root,'PROGRAM/VERSION.txt'),'0.3.51\n');fs.writeFileSync(path.join(root,'PROGRAM/old.txt'),'old');fs.writeFileSync(path.join(root,'.update/PROGRAM.next/VERSION.txt'),'0.3.52\n');fs.writeFileSync(path.join(root,'.update/PROGRAM.next/new.txt'),'new');fs.writeFileSync(path.join(root,'DATA/runtime-token.txt'),'t'.repeat(64));fs.writeFileSync(path.join(root,'DATA/config/server-config.json'),JSON.stringify({schema:'memory-suite.server-config.v1',host:'127.0.0.1',port:47630}));fs.writeFileSync(path.join(root,'DATA/value'),'v1');return root;}
(async()=>{
 const root=setup();try{
  await assert.rejects(()=>applyProgramOnly({rootDir:root,receipt:{updatePolicy:'program_only',targetVersion:'0.3.52',programNext:path.join(root,'.update/PROGRAM.next')},logger:()=>{},failpointEnv:{LIBRARIAN_UPDATER_FAILPOINT:'after_program_new_activate'},hooks:{stopServer:async()=>({wasRunning:false}),startServer:async()=>({version:'0.3.52',dataInstanceId:dataInstanceId(path.join(root,'DATA')),dataIdentityContract:'memory-suite.physical-data-identity.v1',maintenanceMode:true}),integrity:()=>{}}}),/updater_failpoint/);
  // apply's normal catch already rolls back. Create an interrupted journal/physical state manually to test --recover semantics.
  fs.rmSync(path.join(root,'UPDATER/update-state.json'),{force:true});
  const op='manual-crash';const rr=path.join(root,'.rollback',op);fs.mkdirSync(rr,{recursive:true});
  fs.renameSync(path.join(root,'PROGRAM'),path.join(rr,'PROGRAM'));
  fs.mkdirSync(path.join(root,'PROGRAM'));fs.writeFileSync(path.join(root,'PROGRAM/VERSION.txt'),'0.3.52\n');
  const {createDataCheckpoint}=require('../../UPDATER/core/checkpoint.cjs');await createDataCheckpoint({dataDir:path.join(root,'DATA'),checkpointDir:path.join(rr,'DATA-checkpoint')});
  fs.writeFileSync(path.join(root,'DATA/value'),'candidate-write');
  fs.writeFileSync(path.join(root,'UPDATER/update-state.json'),JSON.stringify({schema:'librarian.update-state.v1',engineRevision:identity.engineRevision,dataIdentityContract:identity.contract,dataIdentity:identity.capture(path.join(root,'DATA')),checkpointDataIdentity:identity.capture(path.join(rr,'DATA-checkpoint/DATA')),operationId:op,status:'running',phase:'program_new_activated',policy:'program_only',fromVersion:'0.3.51',toVersion:'0.3.52',serverWasRunning:false,dataInstanceId:dataInstanceId(path.join(root,'DATA')),flags:{checkpointCreated:true,programOldRenamed:true,programNewActivated:true,candidateServerAttempted:true,candidateServerStarted:false,candidateVerified:false},paths:{rollbackRoot:'.rollback/'+op,rollbackProgram:'.rollback/'+op+'/PROGRAM',checkpointRoot:'.rollback/'+op+'/DATA-checkpoint',programNext:'.update/PROGRAM.next'}}));
  const recovered=await recoverInterruptedProgramOnly({rootDir:root,logger:()=>{}});assert.equal(recovered.recovered,true);assert.equal(fs.readFileSync(path.join(root,'PROGRAM/VERSION.txt'),'utf8').trim(),'0.3.51');assert.equal(fs.readFileSync(path.join(root,'DATA/value'),'utf8'),'v1');
  console.log('remote_update_crash_recovery_test: PASS');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
