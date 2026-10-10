'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const fixed=path.resolve(__dirname,'..');
const setup=fs.readFileSync(path.join(fixed,'tests/server_online_restore_review_regression_test.cjs'),'utf8').split("if(mode==='recover'){")[0];
const sandbox={require,__dirname:path.join(fixed,'tests'),process:{...process,argv:['node','probe','cleanup-failure'],env:{...process.env,LIB_RESTORE_FIXTURE:''}},console,Buffer};
Object.defineProperty(sandbox.process,'exitCode',{get:()=>process.exitCode,set:v=>{process.exitCode=v;}});
vm.createContext(sandbox);
vm.runInContext(setup+String.raw`
(async()=>{
 fs.writeFileSync(configFile,JSON.stringify(before));
 context.repositories={hayaku:context.createRepository(dir,'hayaku',()=>context.maintenanceMode)};
 context.repositories.hayaku.mutate({kind:'set',space:'plugin',key:'hayaku.value',value:'BEFORE',operationId:'before',expectedRevision:0});
 const backupFile=path.join(dir,'backup','hayaku.sqlite');context.repositories.hayaku.checkpoint();fs.copyFileSync(namespaceDbPath(dir,'hayaku'),backupFile);
 const db=new DatabaseSync(backupFile);db.prepare("UPDATE kv SET value_json=? WHERE key='hayaku.value'").run(JSON.stringify('MIGRATED'));db.close();
 context.listBackups=()=>[{id:'fixture',path:path.dirname(backupFile),stores:{hayaku:{file:path.basename(backupFile),sha256:sha(fs.readFileSync(backupFile))}},migrationAux:{schema:'librarian.migration-aux.v1',serverConfig:{autoBackup:false,computeEnabled:false,computeWorkers:5}}}];
 const actualRm=fs.rmSync,actualWrite=fs.writeFileSync;let injected=false,result;
 fs.writeFileSync=function(file,data,...rest){if(path.basename(String(file))==='restore-transaction.json'&&typeof data==='string'&&JSON.parse(data).phase==='ROLLED_BACK'){injected=true;throw Object.assign(Error('fixture journal write EIO'),{code:'EIO'});}return actualWrite.call(fs,file,data,...rest);};
 try {context.verifyAuxiliary=()=>{throw Object.assign(Error('fixture verification failure'),{code:'TEST_VERIFY'});};vm.runInContext(restoreCode+'\nglobalThis.restore=restoreBackup;',context);await assert.rejects(()=>context.restore('fixture',['hayaku']),e=>e.code==='TEST_VERIFY');}finally{fs.rmSync=actualRm;fs.writeFileSync=actualWrite;}
 const journal=JSON.parse(fs.readFileSync(path.join(dir,'migrations','restore-transaction.json'),'utf8'));
 assert.equal(context.maintenanceMode,true);const beforeRestart=JSON.parse(fs.readFileSync(configFile,'utf8'));assert.equal(beforeRestart.computeWorkers,1);
 const recovery=context.recoverInterruptedRestore(dir),afterRestart=JSON.parse(fs.readFileSync(configFile,'utf8'));
 console.log(JSON.stringify({sourceSha256:sha(source),fixture:dir,injected,journalPhase:journal.phase,maintenanceMode:context.maintenanceMode,beforeRestart,afterRestart,recovery},null,2));
 assert.equal(injected,true);assert.equal(journal.phase,'PREPARED');assert.equal(context.maintenanceMode,true);assert.equal(afterRestart.computeWorkers,1);assert.equal(recovery.action,'rollback');
 for(const repo of Object.values(context.repositories))repo.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
`,sandbox,{filename:'independent-restore-cleanup-probe.cjs'});
