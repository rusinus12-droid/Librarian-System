'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {createMemorySuiteServer}=require('../server/server.cjs');
(async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'librarian verify isolation '));const old=process.env.LIBRARIAN_UPDATER_VERIFY_MODE;process.env.LIBRARIAN_UPDATER_VERIFY_MODE='1';
 let app;try{app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:data,autoBackup:false,computeEnabled:false});}finally{if(old===undefined)delete process.env.LIBRARIAN_UPDATER_VERIFY_MODE;else process.env.LIBRARIAN_UPDATER_VERIFY_MODE=old;}
 try{const address=await app.listen();const base=`http://127.0.0.1:${address.port}`;const headers={'Authorization':'Bearer '+fs.readFileSync(path.join(data,'runtime-token.txt'),'utf8').trim(),'x-memory-suite-admin':'1','Content-Type':'application/json'};
   for(const [method,route,body] of [['GET','/v1/manager/control/status'],['POST','/v1/manager/reset/plan',{namespaces:['libra']}],['POST','/v1/manager/portable/export-plan',{}],['POST','/v1/admin/backup',{reason:'must-not-run'}]]){
     const response=await fetch(base+route,{method,headers,...(body?{body:JSON.stringify(body)}:{})});assert.equal(response.status,503,route+' must be blocked before its handler in updater verification mode');
   }
   assert.equal((await fetch(base+'/v1/admin/integrity',{method:'POST',headers,body:'{}'})).status,200);
   assert.equal((await fetch(base+'/v1/shutdown',{method:'POST',headers,body:'{}'})).status,200,'authenticated shutdown must remain usable');
   console.log('remote_update_verify_mode_isolation_test: PASS');
 }finally{await app.close();fs.rmSync(data,{recursive:true,force:true});}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
