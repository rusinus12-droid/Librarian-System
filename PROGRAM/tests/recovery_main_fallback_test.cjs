'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createMemorySuiteServer}=require('../server/server.cjs');
async function main(){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ms-recovery-main-'));
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false}); await app.listen();
 app.repositories.libra.mutate({kind:'set',space:'plugin',key:'libra:main:recovery',value:{ok:true},operationId:'recovery_main_source_0001',expectedRevision:0});
 await app.createBackup('manual','main-recovery-source'); await app.close();
 fs.writeFileSync(path.join(dataDir,'stores','libra','libra.sqlite'),Buffer.from('broken sqlite image'));
 const serverPath=path.join(__dirname,'..','server','server.cjs');
 const child=spawn(process.execPath,[serverPath,'serve','--data-dir',dataDir,'--port','0','--no-auto-backup'],{stdio:['ignore','pipe','pipe']});
 let out='',err=''; child.stdout.on('data',c=>{out+=c;}); child.stderr.on('data',c=>{err+=c;});
 const deadline=Date.now()+10000; let m=null;
 while(Date.now()<deadline){m=out.match(/Recovery Safe Mode ready at (http:\/\/[^\s]+)/);if(m)break;await new Promise(r=>setTimeout(r,25));}
 assert.ok(m,`recovery server did not start\nstdout=${out}\nstderr=${err}`);
 const health=await fetch(`${m[1]}/health`).then(r=>r.json()); assert.equal(health.recoveryMode,true); assert.equal(health.status,'recovery_only');
 child.kill('SIGTERM'); await new Promise(resolve=>child.once('close',resolve));
 fs.rmSync(dataDir,{recursive:true,force:true});
 process.stdout.write('recovery_main_fallback_test: PASS\n');
}
main().catch(e=>{process.stderr.write(`recovery_main_fallback_test: FAIL\n${e.stack||e}\n`);process.exitCode=1;});
