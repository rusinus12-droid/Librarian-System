'use strict';
// Exact online restore and startup recovery functions, real SQLite/files, real
// process exit. Surrounding backup scheduling/validation and fsync are fixture
// seams; this is not power-loss or installed-host certification.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),mode=process.argv[2],phase=process.argv[3];
if(!mode){
 const results=[];
 for(const phase of ['PREPARED','INSTALLED','VERIFIED','COMMITTED','ROLLED_BACK']){
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'lib-phase-'));
  const env={...process.env,LIB_RESTORE_FIXTURE:fixture};
  const crashed=spawnSync(process.execPath,[__filename,'crash',phase],{env,encoding:'utf8'});assert.equal(crashed.status,88,crashed.stderr||crashed.stdout);
  const recovered=spawnSync(process.execPath,[__filename,'recover',phase],{env,encoding:'utf8'});assert.equal(recovered.status,0,recovered.stderr||recovered.stdout);results.push(JSON.parse(recovered.stdout));
 }
 console.log(JSON.stringify({cases:results,realProcessExits:5,network:0,models:0},null,2));
}else{
 const setup=fs.readFileSync(path.join(__dirname,'server_online_restore_review_regression_test.cjs'),'utf8').split("if(mode==='recover'){")[0];
 const childProcess={...process,argv:['node','probe',mode==='recover'?'recover':'phase-crash'],env:process.env};
 Object.defineProperty(childProcess,'exitCode',{get:()=>process.exitCode,set:v=>{process.exitCode=v;}});
 const sandbox={require,__dirname,process:childProcess,console,Buffer,reviewPhase:phase,reviewMode:mode};vm.createContext(sandbox);
 vm.runInContext(setup+String.raw`
(async()=>{
 if(reviewMode==='recover'){
  const journal=JSON.parse(fs.readFileSync(path.join(dir,'migrations','restore-transaction.json'),'utf8'));assert.equal(journal.phase,reviewPhase);
  const terminal=['COMMITTED','ROLLED_BACK'].includes(reviewPhase);
  if(terminal){const changed=JSON.parse(fs.readFileSync(configFile,'utf8'));changed.computeWorkers=9;fs.writeFileSync(configFile,JSON.stringify(changed));}
  const recovery=context.recoverInterruptedRestore(dir);const db=new DatabaseSync(namespaceDbPath(dir,'hayaku'),{readOnly:true});const value=JSON.parse(db.prepare("SELECT value_json FROM kv WHERE key='hayaku.value'").get().value_json);db.close();
  const config=JSON.parse(fs.readFileSync(configFile,'utf8'));assert.equal(value,reviewPhase==='COMMITTED'?'MIGRATED':'BEFORE');assert.equal(config.computeWorkers,terminal?9:1);assert.equal(config.autoBackup,reviewPhase!=='COMMITTED');assert.equal(fs.existsSync(path.join(dir,'migrations','restore-transaction.json')),false);
  assert.equal(recovery.action,reviewPhase==='COMMITTED'?'commit_cleanup':reviewPhase==='ROLLED_BACK'?'rollback_cleanup':'rollback');
  console.log(JSON.stringify({phase:reviewPhase,db:value,workers:config.computeWorkers,autoBackup:config.autoBackup,action:recovery.action,journalCleared:true}));return;
 }
 fs.writeFileSync(configFile,JSON.stringify(before));context.repositories={hayaku:context.createRepository(dir,'hayaku',()=>context.maintenanceMode)};
 context.repositories.hayaku.mutate({kind:'set',space:'plugin',key:'hayaku.value',value:'BEFORE',operationId:'before',expectedRevision:0});
 const backupFile=path.join(dir,'backup','hayaku.sqlite');context.repositories.hayaku.checkpoint();fs.copyFileSync(namespaceDbPath(dir,'hayaku'),backupFile);
 const db=new DatabaseSync(backupFile);db.prepare("UPDATE kv SET value_json=? WHERE key='hayaku.value'").run(JSON.stringify('MIGRATED'));db.close();
 context.listBackups=()=>[{id:'fixture',path:path.dirname(backupFile),stores:{hayaku:{file:path.basename(backupFile),sha256:sha(fs.readFileSync(backupFile))}},migrationAux:{schema:'librarian.migration-aux.v1',serverConfig:{autoBackup:false,computeEnabled:false,computeWorkers:5}}}];
 if(reviewPhase==='ROLLED_BACK')context.verifyAuxiliary=()=>{throw Error('fixture verification failure');};
 const write=context.writeRestoreJournal;context.writeRestoreJournal=(data,journal)=>{const result=write(data,journal);if(journal.phase===reviewPhase)process.exit(88);return result;};
 vm.runInContext(restoreCode+'\nglobalThis.restore=restoreBackup;',context);await context.restore('fixture',['hayaku']);throw Error('phase not reached');
})().catch(e=>{console.error(e);process.exitCode=1;});
`,sandbox);
}
