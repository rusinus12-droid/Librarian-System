'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createMemorySuiteServer}=require('../../server/server.cjs');
const dataDir=process.argv[2]; const backupId=process.argv[3];
const originalRename=fs.renameSync;
let blocked=false;
fs.renameSync=(from,to)=>{
 const result=originalRename(from,to);
 if(!blocked && path.basename(String(from))==='libra.sqlite' && String(to).includes('.restore-rollback-')){
  blocked=true;
  process.stdout.write('CRASH_POINT_REACHED\n');
  const sab=new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab),0,0,30000);
 }
 return result;
};
(async()=>{
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
 await app.listen();
 await app.restoreBackup(backupId,['libra']);
 process.stdout.write('RESTORE_UNEXPECTEDLY_COMPLETED\n');
 await app.close();
})().catch(e=>{process.stderr.write(String(e.stack||e)+'\n');process.exitCode=1;});
