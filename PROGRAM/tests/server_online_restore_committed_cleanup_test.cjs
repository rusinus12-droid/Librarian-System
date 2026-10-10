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
 const actualRm=fs.rmSync;let injected=false,result;
 fs.rmSync=function(file,...rest){if(path.basename(String(file))==='restore-transaction.json'){injected=true;throw Object.assign(Error('fixture journal unlink EACCES'),{code:'EACCES'});}return actualRm.call(fs,file,...rest);};
 try {vm.runInContext(restoreCode+'\nglobalThis.restore=restoreBackup;',context);result=await context.restore('fixture',['hayaku']);}finally{fs.rmSync=actualRm;}
 const journal=JSON.parse(fs.readFileSync(path.join(dir,'migrations','restore-transaction.json'),'utf8'));let mutationError;
 try{context.repositories.hayaku.mutate({kind:'set',space:'plugin',key:'hayaku.after',value:'AFTER',operationId:'after',expectedRevision:0});}catch(e){mutationError={message:e.message,status:e.statusCode};}
 console.log(JSON.stringify({sourceSha256:sha(source),fixture:dir,injected,restoreReturnedOk:result.ok,journalPhase:journal.phase,maintenanceMode:context.maintenanceMode,mutationError},null,2));
 assert.equal(injected,true);assert.equal(result.ok,true);assert.equal(journal.phase,'COMMITTED');assert.equal(context.maintenanceMode,false);assert.equal(mutationError,undefined);assert.equal(context.repositories.hayaku.get("plugin","hayaku.after").value,"AFTER");
 for(const repo of Object.values(context.repositories))repo.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
`,sandbox,{filename:'independent-restore-cleanup-probe.cjs'});
