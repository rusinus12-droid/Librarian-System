'use strict';
// Read-only source extraction. No server start, HTTP listener, worker, model or
// network is available to the VM. SQLite/file fixtures live only beside this file.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN');};
const sourceRoot=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(sourceRoot,'server/server.cjs'),'utf8');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function between(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a);return source.slice(a,b);}
const repoCode=between('function createRepository(', '\nfunction verifyBackupDatabase(');
const verifyCode=between('function verifyBackupDatabase(', '\nfunction createMemorySuiteServer(');
const restoreCode=between('  const restoreBackup = async ', '\n  const ',source);
// The next declaration after restoreBackup is independently checked below.
assert(restoreCode.includes('maintenanceMode = false;')&&restoreCode.includes('migrationMetadataReceipt'));
const recoveryCode=between('function restoreJournalPath(', '\nfunction createRecoveryQuarantine(');
const mode=process.argv[2]||'maintenance';
const dir=process.env.LIB_RESTORE_FIXTURE || fs.mkdtempSync(path.join(require('node:os').tmpdir(),'lib-restore-'));
if(mode!=='recover'){assert(!fs.existsSync(path.join(dir,'config')),'Fresh fixture only; do not overwrite prior evidence');fs.mkdirSync(path.join(dir,'config'),{recursive:true});fs.mkdirSync(path.join(dir,'migrations'));fs.mkdirSync(path.join(dir,'stores'));fs.mkdirSync(path.join(dir,'backup'));}
const namespaceDbPath=(d,ns)=>path.join(d,'stores',ns+'.sqlite');
const atomicWrite=(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);};
const context={fs,path,crypto,Buffer,Date,console,Set,Map,Number,JSON,Error,DatabaseSync, NAMESPACES:['hayaku'],RESTORE_JOURNAL_SCHEMA:'memory-suite.restore-transaction.v1',RESTORE_JOURNAL_FILE:'restore-transaction.json', dataDir:dir, scopeCatalogPath:path.join(dir,'config','scope-catalog.json'),maintenanceMode:false, now:Date.now,sha256Text:sha,sha256File:f=>sha(fs.readFileSync(f)),namespaceDbPath, atomicWrite, fsyncDirectory:()=>{},fsyncFile:()=>{},durableRename:fs.renameSync,readJsonFile:(f,def)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return def;}},validateNamespace:x=>x,validateStoredHostLineage:()=>{},createFlashbackWriterFence:()=>({verify(){}}),validateSpace:x=>x,validateKey:x=>x,assertNonSensitive:()=>{},validateOperationId:x=>x,MANAGER_MAX_MUTATIONS:4096,OPERATION_RETENTION_MS:2592000000,OPERATION_SOFT_CAP:100000,
openDatabase(d,ns){const filePath=namespaceDbPath(d,ns);const database=new DatabaseSync(filePath);database.exec('CREATE TABLE IF NOT EXISTS kv(space TEXT NOT NULL,key TEXT NOT NULL,value_json TEXT,deleted INTEGER NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(space,key)); CREATE TABLE IF NOT EXISTS operations(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response_json TEXT NOT NULL,created_at INTEGER NOT NULL);');return {database,filePath};},
namespaceReset:{advanceEpochs(){}},createBackup:async()=>({ok:true,result:{id:'mock-pre-restore'}})};
// Source extraction must provide the same real module bindings as server.cjs.
// These remain default-off on this legacy fixture; no fake permit/readiness seam.
Object.assign(context, {
 authorityContracts: require('../server/authority/contracts.cjs'),
 ...require('../server/authority/control-store.cjs'),
 ...require('../server/authority/owner-store.cjs'),
 ...require('../server/authority/coordinator.cjs'),
 ...require('../server/authority/legacy-admission.cjs')
});
vm.createContext(context);
const metadataModule={exports:{}};
vm.runInNewContext(fs.readFileSync(path.join(sourceRoot,'server/core/migration_metadata.cjs'),'utf8'),{module:metadataModule,require:name=>{if(name==='node:fs')return fs;if(name==='node:path')return path;if(name==='../portable/migration_data_policy.cjs')return {allowlistedConfig:x=>x};throw Error('IMPORT_FORBIDDEN:'+name);},process:{pid:process.pid},Buffer});
Object.assign(context,metadataModule.exports);
vm.runInContext(repoCode+'\n'+verifyCode+'\n'+recoveryCode,context);
const configFile=path.join(dir,'config','server-config.json');
const before={schema:'memory-suite.server-config.v1',host:'127.0.0.1',port:47630,autoBackup:true,computeEnabled:true,computeWorkers:1};
if(mode==='recover'){
 const journal=JSON.parse(fs.readFileSync(path.join(dir,'migrations','restore-transaction.json'),'utf8'));
 const recovery=context.recoverInterruptedRestore(dir);
 const db=new DatabaseSync(namespaceDbPath(dir,'hayaku'),{readOnly:true});const row=db.prepare("SELECT value_json FROM kv WHERE key='hayaku.value'").get();db.close();
 const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
 assert.equal(JSON.parse(row.value_json),'BEFORE');assert.equal(config.autoBackup,true);assert.equal(config.computeEnabled,true);assert.equal(config.computeWorkers,1);assert(journal.migrationMetadata);
 console.log(JSON.stringify({case:'online_metadata_crash',sourceSha256:sha(source),journalPhase:journal.phase,journalHasMetadata:!!journal.migrationMetadata,recovery,restoredDatabaseValue:JSON.parse(row.value_json),beforeConfig:before,afterRecoveryConfig:config,regressionPassed:true,limitations:'exact restore/recovery functions + real SQLite/files; pre-backup, validation wrapper, epoch advance mocked; no full server/HTTP or power-failure certification'},null,2));
}else{
 fs.writeFileSync(configFile,JSON.stringify(before));
 context.repositories={hayaku:context.createRepository(dir,'hayaku',()=>context.maintenanceMode)};
 const mutation=(key,value,op)=>({kind:'set',space:'plugin',key,value,operationId:op,expectedRevision:0});
 context.repositories.hayaku.mutate(mutation('hayaku.value','BEFORE','before'));
 const backupFile=path.join(dir,'backup','hayaku.sqlite');context.repositories.hayaku.checkpoint();fs.copyFileSync(namespaceDbPath(dir,'hayaku'),backupFile);
 const db=new DatabaseSync(backupFile);db.prepare("UPDATE kv SET value_json=? WHERE key='hayaku.value'").run(JSON.stringify('MIGRATED'));db.close();
 const backup={id:'fixture',path:path.dirname(backupFile),stores:{hayaku:{file:path.basename(backupFile),sha256:sha(fs.readFileSync(backupFile))}},migrationAux:{schema:'librarian.migration-aux.v1',serverConfig:{autoBackup:false,computeEnabled:false,computeWorkers:5}}};
 context.listBackups=()=>[backup];
 if(mode==='rollback')context.verifyAuxiliary=()=>{throw Error('fixture_validation_failure');};
 if(mode==='crash')for(const name of ['installMigrationMetadata','applyMigrationMetadataPlan'])context[name]=(...args)=>{metadataModule.exports[name](...args);process.stdout.write('Crash simulation after real metadata install, before durable COMMITTED\n');process.exit(88);};
 vm.runInContext(restoreCode+'\nglobalThis.restore=restoreBackup;',context);
 (async()=>{
 context.maintenanceMode=true;let blockedBefore=false;try{context.repositories.hayaku.mutate(mutation('hayaku.late','late','late-before'));}catch(e){blockedBefore=e.statusCode===503;}context.maintenanceMode=false;assert(blockedBefore);
 if(mode==='rollback')await assert.rejects(()=>context.restore('fixture',['hayaku']),/fixture_validation_failure/);else await context.restore('fixture',['hayaku']);
 context.maintenanceMode=true;assert.throws(()=>context.repositories.hayaku.mutate(mutation('hayaku.late','late','late-after')),e=>e.statusCode===503);
 const stored=context.repositories.hayaku.get('plugin','hayaku.late');assert.equal(stored.exists,false);const result={ok:false};
 assert.throws(()=>context.repositories.hayaku.applyConditionalBatch([{kind:'set',space:'plugin',key:'hayaku.batch',value:'late',expectedRevision:0}],{operationId:'batch-late'}),e=>e.statusCode===503);
 context.repositories.hayaku.applyConditionalBatch([{kind:'set',space:'plugin',key:'hayaku.manager',value:'allowed',expectedRevision:0}],{operationId:'manager-maintenance',maintenance:true});assert.equal(context.repositories.hayaku.get('plugin','hayaku.manager').value,'allowed');
 console.log(JSON.stringify({case:'repository_fence_lost_after_restore',sourceSha256:sha(source),blockedBeforeRestore:blockedBefore,maintenanceMode:true,acceptedAfterRestore:result.ok,storedAfterRestore:stored,regressionPassed:true,limitations:'exact restore/repository functions + real SQLite; pre-backup, lineage validation, epoch advance mocked; no full server/HTTP'},null,2));
 for(const repo of Object.values(context.repositories))repo.close();
 })().catch(e=>{console.error(e);process.exitCode=1;});
}
