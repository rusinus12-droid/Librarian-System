'use strict';
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const strictGuard=require('./authority_strict_guard_probe.cjs').capture();
const {installTraps,installFaults}=require('./authority_fault_loader.cjs');
installTraps();strictGuard?.verify();
const config=JSON.parse(process.argv[2]);
const {openAuthorityStore}=require('../../server/authority/control-store.cjs');
const O=require('../../server/authority/owner-store.cjs');
const {createAuthorityCoordinator}=require('../../server/authority/coordinator.cjs');
if(config.action==='initialize'){
 const restore=installFaults(config);
 try{const ownerBindings=Object.fromEntries(['libra','hayaku','flashback','lia','retrace'].map(namespace=>[namespace,{filePath:path.join(config.dataDir,'stores',namespace,namespace+'.sqlite'),resetEpoch:0}]));const initialized=require('../../server/authority/control-store.cjs').initializeAuthorityStore({dataDir:config.dataDir,activationId:'test-child-initialization',physicalBinding:config.physicalBinding,ownerBindings});initialized.close();process.send?.({event:'result',result:{status:'preparing'}});}
 catch(error){process.send?.({event:'error',code:error.code||'TEST_DRIVER_ERROR'});process.exitCode=2;}
 finally{restore();}
}else{
const marker=JSON.parse(fs.readFileSync(path.join(config.dataDir,'config','server-authority.json'),'utf8'));
const control=openAuthorityStore({dataDir:config.dataDir,physicalBinding:marker.physicalBinding});
const ownerPath=path.join(config.dataDir,'stores','libra','libra.sqlite');
const db=new DatabaseSync(ownerPath);
const owner=O.bindOwnerStore({database:db,namespace:'libra',filePath:ownerPath,physicalBinding:marker.physicalBinding,resetEpoch:0});
const coordinator=createAuthorityCoordinator({control,resolveOwnerStore:n=>{if(n!=='libra')throw new Error('TEST_OWNER_MISMATCH');return owner;}});
const input={generation:marker.generation,namespace:'libra',operationId:config.operationId||'process-operation',fingerprint:'a'.repeat(64),operationClass:'kv'};
function pause(){process.send?.({event:'paused',point:'owner_lock'});const until=Date.now()+30000;while(!fs.existsSync(config.releaseFile)){if(Date.now()>until)process.exit(71);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}}
let restore=()=>{};
try{
 if(config.action==='hold_owner'){db.exec('BEGIN IMMEDIATE');pause();db.exec('ROLLBACK');process.send?.({event:'result',result:{status:'released'}});}
 else{
  restore=installFaults(config);
  let result;
  if(config.action==='close_raw_owner'){db.close();owner.close();throw new Error('RAW_CLOSE_MUST_FAIL_CLOSED');}
  if(config.action==='recover')result=coordinator.recoverPending();
  else if(config.action==='cancel')result=coordinator.cancelOperation(input);
  else result=coordinator.runMutation(input,tx=>{tx.run('INSERT INTO kv VALUES(?,?,?,0,1,?,0)','plugin','libra:memory:'+input.operationId,'{"body":"child"}','digest-child');tx.run('INSERT INTO operations VALUES(?,?,?,0)',input.operationId,input.fingerprint,'{"ok":true}');});
  process.send?.({event:'result',result});
 }
}catch(error){process.send?.({event:'error',code:error.code||'TEST_DRIVER_ERROR'});process.exitCode=2;}
finally{restore();try{owner.close();}catch{}try{control.close();}catch{}try{db.close();}catch{}}

}
