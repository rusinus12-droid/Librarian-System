'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createMemorySuiteServer}=require('../server/server.cjs');
async function main(){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ms-backup-scrub-'));
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
 await app.listen();
 try{
  app.repositories.libra.mutate({kind:'set',space:'plugin',key:'libra:scrub:test',value:{ok:true},operationId:'backup_scrub_test_0001',expectedRevision:0});
  const b=await app.createBackup('manual','scrub-source');
  const good=app.scrubBackups(b.result.id);
  assert.equal(good.ok,true);
  const file=path.join(dataDir,'backups','manual',b.result.id,b.result.stores.libra.file);
  const fd=fs.openSync(file,'r+'); fs.writeSync(fd,Buffer.from('CORRUPT'),0,7,64); fs.closeSync(fd);
  const bad=app.scrubBackups(b.result.id);
  assert.equal(bad.ok,false);
  assert.equal(bad.results[0].stores.libra.ok,false);
  process.stdout.write('backup_scrub_test: PASS\n');
 } finally {await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
}
main().catch(e=>{process.stderr.write(`backup_scrub_test: FAIL\n${e.stack||e}\n`);process.exitCode=1;});
