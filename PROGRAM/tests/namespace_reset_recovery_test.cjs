'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const create=require('../server/core/namespace-reset.cjs');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reset-recovery-'));
 require('../server/core/data-instance-identity.cjs').ensureDataInstanceIdentity(dir);
 let rows=3,failCatalog=true,backupCalls=0,catalogCleared=false;
 const database={exec(sql){if(sql.startsWith('DELETE'))rows=0;},prepare(){return {get:()=>({n:rows})};}};
 const options={dataDir:dir,repositories:{hayaku:{database}},backup:async()=>{backupCalls++;throw Error('backup_failed');},setMaintenance(){},clearCatalog(){if(failCatalog)throw Error('catalog_interrupted');catalogCleared=true;}};
 try{
  let reset=create(options);let plan=reset.plan(['hayaku']);
  const body={planId:plan.id,confirmation:plan.confirmation};
  await assert.rejects(reset.execute({...body,withoutBackup:'false'}),/backup_choice/);
  await assert.rejects(reset.execute(body),/backup_failed/);assert.equal(rows,3);assert.deepEqual(reset.epochs(),{});
  await assert.rejects(reset.execute({...body,withoutBackup:true}),/catalog_interrupted/);
  assert.equal(backupCalls,1);assert.equal(rows,0);assert.equal(reset.allows('hayaku','{"hayaku":1}'),false);
  failCatalog=false;reset=create(options);assert.equal(catalogCleared,true);assert.deepEqual(reset.epochs(),{hayaku:1});
  assert.equal(reset.allows('hayaku','{}'),false);assert.equal(reset.allows('hayaku','{"hayaku":1}'),true);
  console.log('namespace_reset_recovery_test: PASS (backup failure, explicit opt-out, interrupted catalog, durable restart fence)');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
