'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');
const {fixture}=require('./helpers/updater_fixture.cjs');
const {recoverInterruptedProgramOnly}=require('../../UPDATER/core/program-only.cjs');
const cases=[
 ['checkpoint interrupted before manifest',async f=>{fs.mkdirSync(f.p('.rollback/case/DATA-checkpoint/DATA'),{recursive:true});fs.writeFileSync(f.p('.rollback/case/DATA-checkpoint/DATA/partial'),'partial');}],
 ['old rename before journal flag',async f=>{await f.checkpoint();fs.renameSync(f.p('PROGRAM'),f.p(f.journal.paths.rollbackProgram));f.journal.phase='intent_program_old_rename';}],
 ['new activation before journal flag',async f=>{await f.checkpoint();f.activate();f.journal.flags.programNewActivated=false;f.journal.phase='intent_program_new_activate';}],
 ['rollback PROGRAM quarantine before journal',async f=>{await f.checkpoint();f.activate();f.dirty();f.quarantine('PROGRAM');f.journal.status='rollback';}],
 ['rollback PROGRAM restore before journal',async f=>{await f.checkpoint();f.activate();f.dirty();f.quarantine('PROGRAM');fs.renameSync(f.p(f.journal.paths.rollbackProgram),f.p('PROGRAM'));f.journal.status='rollback';}],
 ['rollback DATA quarantine before journal',async f=>{await f.checkpoint();f.activate();f.dirty();f.quarantine('DATA');f.journal.status='rollback';}],
 ['rollback DATA restore before journal',async f=>{await f.checkpoint();f.activate();f.dirty();f.quarantine('DATA');fs.renameSync(f.p(f.journal.paths.checkpointRoot+'/DATA'),f.p('DATA'));f.journal.status='rollback';}],
 ['both restores before journal',async f=>{await f.checkpoint();f.activate();f.dirty();f.quarantine('PROGRAM');fs.renameSync(f.p(f.journal.paths.rollbackProgram),f.p('PROGRAM'));f.quarantine('DATA');fs.renameSync(f.p(f.journal.paths.checkpointRoot+'/DATA'),f.p('DATA'));f.journal.status='rollback_failed';}],
 ['rollback durable restored decision preserves new writes',async f=>{await f.checkpoint();f.journal.status='rollback_restart_failed';f.journal.rollbackRestoredAt=new Date().toISOString();f.journal.flags.candidateServerAttempted=true;fs.writeFileSync(f.p('DATA/value'),'AFTER-RESTORE');f.expected='AFTER-RESTORE';}]
];
(async()=>{let failed=0;for(const [name,prepare] of cases){const f=await fixture();try{await prepare(f);f.save();const r=await recoverInterruptedProgramOnly({rootDir:f.root});assert.equal(r.journal.status,'rolled_back');assert.equal(fs.readFileSync(f.p('PROGRAM/VERSION.txt'),'utf8').trim(),'0.3.51');assert.equal(fs.readFileSync(f.p('DATA/value'),'utf8'),f.expected||'BEFORE');assert.equal((await recoverInterruptedProgramOnly({rootDir:f.root})).recovered,false);console.log('PASS: '+name);}catch(e){failed++;console.error('FAIL: '+name+' :: '+e.message);}finally{f.cleanup();}}
 for(const name of ['missing old PROGRAM','corrupt checkpoint']){const f=await fixture();try{await f.checkpoint();f.activate();f.dirty();if(name==='missing old PROGRAM')fs.rmSync(f.p(f.journal.paths.rollbackProgram),{recursive:true});else fs.writeFileSync(f.p(f.journal.paths.checkpointRoot+'/DATA/value'),'CORRUPT');f.save();await assert.rejects(()=>recoverInterruptedProgramOnly({rootDir:f.root}));assert.notEqual(JSON.parse(fs.readFileSync(f.p('UPDATER/update-state.json'))).status,'rolled_back');console.log('PASS: rejects '+name);}catch(e){failed++;console.error('FAIL: '+name+' :: '+e.message);}finally{f.cleanup();}}
 assert.equal(failed,0,`${failed} recovery boundaries failed`);console.log('remote_update_recovery_boundaries_test: PASS');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
