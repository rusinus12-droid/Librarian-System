'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{test}=require('node:test'),f=require('./fixtures/server_repair_fixture.cjs');
test('real server backup creation binds exact DATA identity and namespace reset map while maintenance-held',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'repair-backup-authority-')),x=f.open(dir);try{f.seed(x.repo);const out=await x.app.createBackup('manual','repair-fixture');assert.equal(out.ok,true);const expected=require(path.join(f.BASE,'server/core/data-instance-identity.cjs')).readDataInstanceIdentity(dir);assert.deepEqual(out.result.backupRepairAuthority,{schema:'memory-suite.backup-repair-authority.v1',...expected,resetEpochs:{}});}finally{await x.app.close();}
});
test('physical identity changed during the actual backup worker prevents manifest publication',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'repair-backup-identity-')),x=f.open(dir);try{f.seed(x.repo);const file=path.join(dir,'config','data-instance.json');globalThis.__repairBackupWorkerHook=()=>{const seed=JSON.parse(fs.readFileSync(file));seed.nonce='A'.repeat(43);fs.writeFileSync(file,JSON.stringify(seed));};await assert.rejects(()=>x.app.createBackup('manual','changed-identity'),/backup_physical_identity_changed/);assert.equal(x.app.listBackups().length,0);}finally{delete globalThis.__repairBackupWorkerHook;await x.app.close();}
});
