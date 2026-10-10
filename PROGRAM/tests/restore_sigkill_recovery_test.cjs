'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createMemorySuiteServer}=require('../server/server.cjs');

async function main(){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ms-restore-sigkill-'));
 let app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false}); await app.listen();
 app.repositories.libra.mutate({kind:'set',space:'plugin',key:'libra:sigkill:test',value:{state:'backup'},operationId:'sigkill_backup_0001',expectedRevision:0});
 const backup=await app.createBackup('manual','sigkill-source');
 app.repositories.libra.mutate({kind:'set',space:'plugin',key:'libra:sigkill:test',value:{state:'current'},operationId:'sigkill_current_0002',expectedRevision:1});
 await app.close();
 const childPath=path.join(__dirname,'fixtures','restore_crash_child.cjs');
 const child=spawn(process.execPath,[childPath,dataDir,backup.result.id],{stdio:['ignore','pipe','pipe']});
 let out='',err=''; child.stdout.on('data',c=>{out+=c;}); child.stderr.on('data',c=>{err+=c;});
 const deadline=Date.now()+10000;
 while(!out.includes('CRASH_POINT_REACHED') && Date.now()<deadline) await new Promise(r=>setTimeout(r,25));
 assert.match(out,/CRASH_POINT_REACHED/,err||out);
 child.kill('SIGKILL');
 await new Promise(resolve=>child.once('close',resolve));
 assert.ok(fs.existsSync(path.join(dataDir,'migrations','restore-transaction.json')),'journal must survive the killed process');
 app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
 assert.equal(app.interruptedRestoreRecovery.recovered,true);
 assert.equal(app.interruptedRestoreRecovery.action,'rollback');
 await app.listen();
 try{
  assert.deepEqual(app.repositories.libra.get('plugin','libra:sigkill:test').value,{state:'current'});
  assert.equal(fs.existsSync(path.join(dataDir,'migrations','restore-transaction.json')),false);
  process.stdout.write('restore_sigkill_recovery_test: PASS\n');
 } finally {await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
}
main().catch(e=>{process.stderr.write(`restore_sigkill_recovery_test: FAIL\n${e.stack||e}\n`);process.exitCode=1;});
