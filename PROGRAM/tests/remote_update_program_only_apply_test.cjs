'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { applyProgramOnly } = require('../../UPDATER/core/program-only.cjs');

function setup(versionOld='0.3.51', versionNew='0.3.52') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian program-only '));
  fs.mkdirSync(path.join(root,'PROGRAM'),{recursive:true});
  fs.mkdirSync(path.join(root,'DATA','config'),{recursive:true});
  fs.mkdirSync(path.join(root,'UPDATER'),{recursive:true});
  fs.mkdirSync(path.join(root,'.update','PROGRAM.next'),{recursive:true});
  fs.writeFileSync(path.join(root,'PROGRAM','VERSION.txt'),versionOld+'\n');
  fs.writeFileSync(path.join(root,'PROGRAM','old.txt'),'old-program');
  fs.writeFileSync(path.join(root,'.update','PROGRAM.next','VERSION.txt'),versionNew+'\n');
  fs.writeFileSync(path.join(root,'.update','PROGRAM.next','new.txt'),'new-program');
  fs.writeFileSync(path.join(root,'DATA','runtime-token.txt'),'x'.repeat(64));
  fs.writeFileSync(path.join(root,'DATA','config','server-config.json'),JSON.stringify({schema:'memory-suite.server-config.v1',host:'127.0.0.1',port:47630}));
  fs.writeFileSync(path.join(root,'DATA','user-memory.bin'),Buffer.from('KEEP-ME'));
  return root;
}
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const receipt = root => ({ updatePolicy:'program_only',targetVersion:'0.3.52',programNext:path.join(root,'.update','PROGRAM.next') });

async function successCase(){
  const root=setup(); const dataFile=path.join(root,'DATA','user-memory.bin'); const before=digest(dataFile);
  try{
    const result=await applyProgramOnly({rootDir:root,receipt:receipt(root),logger:()=>{},hooks:{
      stopServer:async()=>({wasRunning:false,health:null}),
      startServer:async(_p,_d,{verifyMode})=>({ok:true,version:'0.3.52',dataInstanceId:require('../../UPDATER/core/program-only.cjs').dataInstanceId(path.join(root,'DATA')),dataIdentityContract:'memory-suite.physical-data-identity.v1',maintenanceMode:verifyMode===true}),
      integrity:()=>{}
    }});
    assert.equal(result.status,'complete');
    assert.equal(fs.readFileSync(path.join(root,'PROGRAM','VERSION.txt'),'utf8').trim(),'0.3.52');
    assert.equal(digest(dataFile),before,'active DATA must remain byte-identical for successful simulated program-only switch');
    assert.ok(fs.existsSync(path.join(root,'.rollback',result.operationId,'PROGRAM','old.txt')));
    assert.ok(fs.existsSync(path.join(root,'.rollback',result.operationId,'DATA-checkpoint','checkpoint-manifest.json')));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}

async function failureCase(){
  const root=setup(); const dataFile=path.join(root,'DATA','user-memory.bin'); const before=digest(dataFile);
  try{
    await assert.rejects(()=>applyProgramOnly({rootDir:root,receipt:receipt(root),logger:()=>{},hooks:{
      stopServer:async()=>({wasRunning:false,health:null}),
      startServer:async()=>{fs.writeFileSync(dataFile,'CORRUPTED-BY-CANDIDATE'); throw new Error('candidate_boot_failed');},
      integrity:()=>{}
    }}),/candidate_boot_failed/);
    assert.equal(fs.readFileSync(path.join(root,'PROGRAM','VERSION.txt'),'utf8').trim(),'0.3.51','old PROGRAM restored');
    assert.equal(digest(dataFile),before,'DATA restored from safety checkpoint');
    const state=JSON.parse(fs.readFileSync(path.join(root,'UPDATER','update-state.json'),'utf8'));
    assert.equal(state.status,'rolled_back');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}

(async()=>{await successCase();await failureCase();console.log('remote_update_program_only_apply_test: PASS');})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
