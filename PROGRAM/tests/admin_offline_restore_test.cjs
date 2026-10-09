'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createMemorySuiteServer}=require('../server/server.cjs');
const adminPath=path.join(__dirname,'..','server','admin.cjs');
function run(args){return new Promise((resolve,reject)=>{const c=spawn(process.execPath,[adminPath,...args],{stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',x=>out+=x);c.stderr.on('data',x=>err+=x);c.on('error',reject);c.on('close',code=>resolve({code,out,err}));});}
async function main(){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ms-admin-offline-'));
 let app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false}); await app.listen();
 app.repositories.libra.mutate({kind:'set',space:'plugin',key:'libra:offline:test',value:{state:'backup'},operationId:'offline_restore_backup_0001',expectedRevision:0});
 const b=await app.createBackup('manual','offline-cli');
 app.repositories.libra.mutate({kind:'set',space:'plugin',key:'libra:offline:test',value:{state:'current'},operationId:'offline_restore_current_0002',expectedRevision:1});
 await app.close();
 const denied=await run(['restore-offline',b.result.id,'libra','--data-dir',dataDir]); assert.notEqual(denied.code,0); assert.match(denied.err,/--yes/);
 const ok=await run(['restore-offline',b.result.id,'libra','--yes','--data-dir',dataDir]); assert.equal(ok.code,0,ok.err); const receipt=JSON.parse(ok.out); assert.equal(receipt.recoveryMode,true);
 app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false}); await app.listen();
 try{assert.deepEqual(app.repositories.libra.get('plugin','libra:offline:test').value,{state:'backup'});process.stdout.write('admin_offline_restore_test: PASS\n');}
 finally{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
}
main().catch(e=>{process.stderr.write(`admin_offline_restore_test: FAIL\n${e.stack||e}\n`);process.exitCode=1;});
