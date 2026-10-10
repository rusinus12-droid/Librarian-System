'use strict';
// Independent failure-composition probe. Only an isolated temporary fixture is written.
// Loads the fixed-source review harness setup and exact restore/recovery functions;
// injects filesystem EIO at INSTALLED journal publication and config rollback.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const fixed=path.resolve(__dirname,'..');
const setup=fs.readFileSync(path.join(fixed,'tests/server_online_restore_review_regression_test.cjs'),'utf8').split("if(mode==='recover'){")[0];
const sandbox={require,__dirname:path.join(fixed,'tests'),process:{...process,argv:['node','probe','rollback-failure'],env:{...process.env,LIB_RESTORE_FIXTURE:''}},console,Buffer};
// metadata helper is unchanged, and intentionally loaded from baseline context.
const patched=setup.replace("path.join(sourceRoot,'server/core/migration_metadata.cjs')",JSON.stringify(path.join(fixed,'server/core/migration_metadata.cjs')));
Object.defineProperty(sandbox.process,'exitCode',{get:()=>process.exitCode,set:value=>{process.exitCode=value;}});
vm.createContext(sandbox);
vm.runInContext(patched+String.raw`
(async()=>{

 context.repositories={hayaku:context.createRepository(dir,'hayaku',()=>context.maintenanceMode)};
 context.repositories.hayaku.mutate({kind:'set',space:'plugin',key:'hayaku.value',value:'BEFORE',operationId:'before',expectedRevision:0});
 const backupFile=path.join(dir,'backup','hayaku.sqlite');context.repositories.hayaku.checkpoint();fs.copyFileSync(namespaceDbPath(dir,'hayaku'),backupFile);
 const db=new DatabaseSync(backupFile);db.prepare("UPDATE kv SET value_json=? WHERE key='hayaku.value'").run(JSON.stringify('MIGRATED'));db.close();
 context.listBackups=()=>[{id:'fixture',path:path.dirname(backupFile),stores:{hayaku:{file:path.basename(backupFile),sha256:sha(fs.readFileSync(backupFile))}},migrationAux:{schema:'librarian.migration-aux.v1',serverConfig:{autoBackup:false,computeEnabled:false,computeWorkers:5}}}];
 let failRollback=false,journalFailureInjected=false,rollbackFailureInjected=false,reported='';
 const actualWrite=fs.writeFileSync,actualRm=fs.rmSync;
 fs.rmSync=function(file,...rest){if(failRollback&&String(file)===configFile){rollbackFailureInjected=true;throw Object.assign(Error("fixture config unlink EACCES"),{code:"EACCES"});}return actualRm.call(fs,file,...rest);};
 fs.writeFileSync=function(file,data,...rest){
   if(path.basename(String(file))==='restore-transaction.json' && typeof data==='string' && JSON.parse(data).phase==='INSTALLED'){
     failRollback=true;journalFailureInjected=true;throw Object.assign(Error('fixture journal EIO'),{code:'EIO'});
   }
   if(failRollback && String(file)===configFile){rollbackFailureInjected=true;throw Object.assign(Error('fixture rollback EIO'),{code:'EIO'});}
   return actualWrite.call(fs,file,data,...rest);
 };
 try {
   vm.runInContext(restoreCode+'\nglobalThis.restore=restoreBackup;',context);
   await assert.rejects(()=>context.restore('fixture',['hayaku']),e=>{reported=e.message;return e.code==='EIO';});
 } finally {fs.writeFileSync=actualWrite;fs.rmSync=actualRm;}
 const current=context.repositories.hayaku.get('plugin','hayaku.value').value;
 const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
 const journalExists=fs.existsSync(path.join(dir,'migrations','restore-transaction.json'));
 const recovery=context.recoverInterruptedRestore(dir);
 const result={sourceSha256:sha(source),fixture:dir,journalFailureInjected,rollbackFailureInjected,reported,db:current,config,maintenanceMode:context.maintenanceMode,journalExists,restartRecovery:recovery};
 console.log(JSON.stringify(result,null,2));
 assert.equal(journalFailureInjected,true);assert.equal(rollbackFailureInjected,true);
 assert.equal(current,'BEFORE');assert.equal(config.autoBackup,false);assert.equal(journalExists,true);assert.equal(context.maintenanceMode,true);assert.equal(recovery.action,'rollback');assert.equal(fs.existsSync(configFile),false);
 for(const repo of Object.values(context.repositories))repo.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
`,sandbox,{filename:'independent-restore-rollback-probe.cjs'});
