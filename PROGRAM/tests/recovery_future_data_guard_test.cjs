'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {createMemorySuiteServer,isRecoverySafeModeEligibleError}=require('../server/server.cjs');
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function main(){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ms-future-guard-'));
 fs.writeFileSync(path.join(dataDir,'data-layout.json'),JSON.stringify({schema:'memory-suite.data-layout.v1',layoutVersion:99,createdAt:'future'}));
 const layout=path.join(dataDir,'data-layout.json'); const before=sha(layout);
 let error=null; try{createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});}catch(e){error=e;}
 assert.ok(error); assert.equal(error.code,'DATA_LAYOUT_NEWER_THAN_PROGRAM'); assert.equal(isRecoverySafeModeEligibleError(error),false);
 const serverPath=path.join(__dirname,'..','server','server.cjs');
 const run=spawnSync(process.execPath,[serverPath,'serve','--data-dir',dataDir,'--port','0','--no-auto-backup'],{encoding:'utf8'});
 assert.notEqual(run.status,0); assert.doesNotMatch(run.stdout,/Recovery Safe Mode/); assert.equal(sha(layout),before,'future DATA must not be rewritten');
 fs.rmSync(dataDir,{recursive:true,force:true}); process.stdout.write('recovery_future_data_guard_test: PASS\n');
}
try{main();}catch(e){process.stderr.write(`recovery_future_data_guard_test: FAIL\n${e.stack||e}\n`);process.exitCode=1;}
