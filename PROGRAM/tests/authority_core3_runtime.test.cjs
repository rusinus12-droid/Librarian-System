'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {DatabaseSync}=require('node:sqlite');
const C=require('../server/authority/contracts.cjs'),Core=require('../server/authority/control-store.cjs');
const {core3Fixture,OWNERS,PROFILE}=require('./fixtures/authority_core3_fixture.cjs');
const {createMemorySuiteServer}=require('../server/server.cjs');
const config=f=>({dataDir:f.dataDir,authorityProfile:PROFILE,autoBackup:false,computeEnabled:false,token:'synthetic-core3-no-listener-token'});
function prepared(t){const f=core3Fixture(t);f.initialize();f.bind();f.qualify();return f;}
function appFor(t,f){const app=createMemorySuiteServer(config(f));t.after(()=>app.close());return app;}
function request(app,url,body={},extra={}){
 const req=new EventEmitter(),res=new EventEmitter();let result,reads=0;
 Object.assign(req,{url,method:extra.method||'POST',headers:{authorization:'Bearer '+app.token,'x-memory-suite-admin':'1',...extra.headers},destroy(){},resume(){}});
 const on=req.on;req.on=function(event,...rest){if(event==='data')reads++;return on.call(this,event,...rest);};
 res.writeHead=(status,headers)=>{res.statusCode=status;res.headers=headers;};res.getHeader=k=>res.headers?.[k];
 res.end=bytes=>{result={status:res.statusCode,body:bytes?JSON.parse(String(bytes)):null,reads};res.emit('finish');};
 const work=app.server.listeners('request')[0](req,res),finish=()=>{req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end');};
 if(!extra.defer)finish();return {finish,result:Promise.resolve(work).then(()=>{assert(result);return result;})};
}
const fresh=(key,value)=>({kind:'set',space:'plugin',key,value,expectedRevision:0,expectedDigest:'',expectedExists:false,expectedTombstone:false});
function current(repo,key,kind='remove'){const row=repo.get('plugin',key);return {kind,space:'plugin',key,expectedRevision:row.revision,expectedDigest:row.digest,expectedExists:row.exists,expectedTombstone:row.tombstone};}
function receipt(f,n,id){return f.control.readOperation({generation:f.control.readWitness().generation,namespace:n,operationId:id});}
function noAncillary(f){for(const p of ['stores/lia','stores/retrace','stores/unknown-owner','runtime','logs','backups','migrations','runtime-token.txt','config/compute-signing-key.txt','data-layout.json'])assert.equal(fs.existsSync(path.join(f.dataDir,p)),false,p);}

test('qualified core3 normal constructor opens a usable no-listen runtime without ancillary enrollment',async t=>{
 const f=prepared(t),initial=f.control.readInitialQualification(),app=appFor(t,f);
 assert.equal(app.authorityRuntime.authorityProfile,PROFILE);assert.equal(app.authorityRuntime.qualificationScope,'isolated-core3-server-candidate.v1');
 assert.equal(app.authorityRuntime.serverActivation,false);assert.equal(app.authorityRuntime.allWriterOwnership,false);assert.deepEqual(app.authorityRuntime.qualifiedProductionProfiles,[]);
 for(const n of OWNERS){const r=app.repositories[n].mutate({kind:'set',space:'plugin',key:n+':runtime',value:n,operationId:'runtime-'+n,expectedRevision:0});assert.equal(r.result.verified,true);assert.equal(receipt(f,n,'runtime-'+n).status,'committed');}
 for(const n of ['lia','retrace']){assert.equal(app.repositories[n].ephemeral,true);assert.equal(app.repositories[n].legacyReadOnly,true);assert.throws(()=>app.repositories[n].mutate({}),/read_only/);}
 assert.equal(app.server.listening,false);await assert.rejects(app.listen(),{code:'AUTHORITY_HOST_PROFILE_UNQUALIFIED'});assert.throws(()=>app.server.listen(0),{code:'AUTHORITY_HOST_PROFILE_UNQUALIFIED'});
 assert.deepEqual(f.control.readInitialQualification(),initial);noAncillary(f);await app.close();assert.throws(()=>app.repositories.libra.mutate({kind:'set',space:'plugin',key:'after-close',value:1,operationId:'after-close'}),/AUTHORITY_CLOSED/);noAncillary(f);
});
test('selection never initializes unprepared DATA or accepts caller qualification claims',t=>{
 const f=core3Fixture(t);
 for(const extra of [{authorityProfile:PROFILE},{authorityProfile:true},{authorityProfile:PROFILE,allWriterOwnership:true,actualHostQualified:true}])assert.throws(()=>createMemorySuiteServer({...config(f),...extra}));
 assert.equal(fs.existsSync(f.markerPath),false);assert.equal(fs.existsSync(f.controlPath),false);noAncillary(f);
 f.initialize();assert.throws(()=>createMemorySuiteServer(config(f)),/INITIAL_QUALIFICATION_REQUIRED/);for(const n of OWNERS)assert.equal(f.databases[n].prepare('PRAGMA user_version').get().user_version,1);
});
test('startup replays actual simultaneous owner locks without installing or rewriting initial receipt',async t=>{
 const f=prepared(t),initial=f.control.readInitialQualification(),exec=DatabaseSync.prototype.exec;let held=new Set(),simultaneous=false;
 DatabaseSync.prototype.exec=function(sql){const file=this.prepare('PRAGMA database_list').all().find(x=>x.name==='main')?.file;const n=OWNERS.find(n=>f.ownerBindings[n].filePath===file);const r=exec.call(this,sql);if(n&&sql==='BEGIN IMMEDIATE'){held.add(n);if(held.size===3){simultaneous=true;for(const owner of OWNERS){const rival=new DatabaseSync(f.ownerBindings[owner].filePath);try{rival.exec('PRAGMA busy_timeout=1');assert.throws(()=>rival.exec('BEGIN IMMEDIATE'),/busy|locked/i);}finally{rival.close();}}}}if(n&&/^(COMMIT|ROLLBACK)$/.test(sql))held.delete(n);return r;};
 let app;try{app=createMemorySuiteServer(config(f));}finally{DatabaseSync.prototype.exec=exec;}t.after(()=>app?.close());assert.equal(simultaneous,true);assert.deepEqual(f.control.readInitialQualification(),initial);assert.equal(f.control.readWitness().controlSequence,1);noAncillary(f);
});
test('authenticated normal request handler commits and replays core3 writes with exact receipts',async t=>{
 const f=prepared(t),app=appFor(t,f);
 for(const n of OWNERS){const body={namespace:n,space:'plugin',key:n+':http',value:'one',operationId:'runtime-http-'+n,expectedRevision:0};const first=await request(app,'/v1/kv/set',body).result;assert.equal(first.status,200);assert.equal(receipt(f,n,body.operationId).decision.receipt.operationClass,'kv');assert.deepEqual((await request(app,'/v1/kv/set',body).result).body,first.body);assert.equal((await request(app,'/v1/kv/set',{...body,value:'changed'}).result).status,409);}
 const batch=await request(app,'/v1/kv/batch',{namespace:'libra',operationId:'runtime-http-batch',mutations:[fresh('libra:batch',1)]}).result;assert.equal(batch.status,200);assert.equal(receipt(f,'libra','runtime-http-batch').decision.receipt.operationClass,'batch');
 const removed=await request(app,'/v1/kv/remove',{namespace:'libra',space:'plugin',key:'libra:batch',operationId:'runtime-http-remove',expectedRevision:1}).result;assert.equal(removed.status,200);assert.equal(app.repositories.libra.get('plugin','libra:batch').tombstone,true);
 assert.equal((await request(app,'/v1/kv/set',{namespace:'libra',space:'plugin',key:'denied',value:1,operationId:'unauthenticated'},{headers:{authorization:''}}).result).status,403);
 const bootstrap=await request(app,'/bootstrap',{}, {method:'GET',headers:{'x-memory-suite-plugin':'libra'}}).result;
 const headers={authorization:'Bearer '+bootstrap.body.token,'x-memory-suite-plugin':'libra','x-memory-suite-admin':''};
 const owned={namespace:'libra',space:'plugin',key:'libra:owner-auth',value:2,operationId:'plugin-owner-write'};
 assert.equal((await request(app,'/v1/kv/set',owned,{headers}).result).status,200);
 assert.equal((await request(app,'/v1/kv/set',{...owned,namespace:'hayaku',operationId:'wrong-owner-write'},{headers}).result).status,403);
 const lookup=await request(app,'/v1/operations/libra/plugin-owner-write',{}, {method:'GET',headers}).result;assert.equal(lookup.status,200);assert.equal(lookup.body.result.operationId,owned.operationId);noAncillary(f);
});
test('repository maintenance purge, deletion fences and ordinary cleanup retain coordinator evidence',async t=>{
 const f=core3Fixture(t);f.databases.libra.prepare('INSERT INTO operations VALUES(?,?,?,?)').run('expired-ordinary-fixture','a'.repeat(64),'{}',0);f.initialize();f.bind();f.qualify();const app=appFor(t,f),repo=app.repositories.libra;
 repo.applyConditionalBatch([fresh('libra:purge',1),fresh('libra:v1:scope:deleted:manifest','{}')],{operationId:'maintenance-seed'});
 repo.applyConditionalBatch([current(repo,'libra:purge','purge')],{maintenance:true,operationId:'maintenance-purge'});assert.equal(repo.get('plugin','libra:purge').exists,false);assert.equal(receipt(f,'libra','maintenance-purge').decision.receipt.operationClass,'maintenance');
 repo.applyConditionalBatch([current(repo,'libra:v1:scope:deleted:manifest')],{maintenance:true,operationId:'maintenance-seal',ownedScopeDeletion:{scopeId:'deleted-owner',scopeKey:'deleted',backupId:'offline-fixture-backup'}});
 assert.equal(repo.isOwnerScopeDeleted('deleted-owner'),true);assert.throws(()=>repo.mutate({kind:'set',space:'plugin',key:'libra:v1:scope:deleted:manifest',value:'x',operationId:'sealed-write'}),/deleted_scope|AUTHORITY_BUSY/);
 const cleaned=repo.maintainReceipts();assert.equal(cleaned.kind,'ordinary-receipt-cleanup');assert.equal(repo.operation('expired-ordinary-fixture'),null);const rows=repo.database.prepare('SELECT receipt_json FROM authority_write_receipts').all().map(x=>JSON.parse(x.receipt_json));assert(rows.some(x=>x.operationId.startsWith('receipt-cleanup:')&&x.operationClass==='maintenance'));
 assert.throws(()=>repo.database.exec('DELETE FROM kv'),/readonly|read-only|not authorized|no such function: authority_/i);assert.throws(()=>repo.database.exec('DROP TABLE kv'),/readonly|read-only|not authorized|no such function: authority_/i);
 const target=path.join(f.root,'unsupported-export','owner.sqlite');assert.throws(()=>repo.vacuumInto(target),/AUTHORITY_LIFECYCLE_UNAVAILABLE/);assert.equal(fs.existsSync(path.dirname(target)),false);assert.throws(()=>repo.checkpoint(),/AUTHORITY_LIFECYCLE_UNAVAILABLE/);noAncillary(f);
});
test('Flashback writer acquire renew write release use normal handler and real fence receipts',async t=>{
 const f=prepared(t),app=appFor(t,f),key='vector_rag_memory:scope:runtime_alias:manifest:v2',owner='runtime-writer-owner-0001';
 const command=body=>request(app,'/v1/flashback/writer',{key,owner,...body}).result;
 const acquire=await command({action:'acquire'});assert.equal(acquire.status,200);const fence=acquire.body.result;
 assert.equal((await command({action:'renew',epoch:fence.epoch})).status,200);
 const body={namespace:'flashback',space:'plugin',key,value:'fenced',operationId:'fenced-http-rejected'};assert.equal((await request(app,'/v1/kv/set',body).result).status,409);
 assert.equal((await request(app,'/v1/kv/set',{...body,operationId:'fenced-http-valid',fence}).result).status,200);assert.equal((await command({action:'release',epoch:fence.epoch})).status,200);
 const rows=app.repositories.flashback.database.prepare('SELECT receipt_json FROM authority_write_receipts').all().map(x=>JSON.parse(x.receipt_json));assert.equal(rows.filter(x=>x.operationClass==='fence').length,3);noAncillary(f);
});
test('unsupported routes fail before body, manager recovery, native proof, filesystem work',async t=>{
 const f=prepared(t),app=appFor(t,f),before=f.control.readWitness().controlSequence;
 for(const route of ['/v1/admin/backups/create','/v1/admin/backups/import','/v1/admin/backups/export','/v1/admin/restore/plan','/v1/admin/restore','/v1/manager/reset/plan','/v1/manager/reset/execute','/v1/manager/control/backup-create','/v1/manager/portable/import-begin','/v1/manager/scopes/index','/v1/manager/scope-pin','/v1/manager/scope-delete/plan','/v1/manager/scope-delete/execute','/v1/owner/scope-delete/plan','/v1/owner/scope-delete/execute','/v1/admin/libra/native-archive-repair/execute','/v1/flashback/physical-repair/reserve','/v1/compute/bootstrap','/v1/compute/execute','/v1/libra/read-session/capture','/v1/libra/read-session/current','/v1/unknown-writer']){
  const result=await request(app,route,{allWriterOwnership:true,mode:'server_only'}).result;assert.equal(result.status,503,route);assert.equal(result.reads,0,route);
 }
 await assert.rejects(app.createBackup(),/AUTHORITY_LIFECYCLE_UNAVAILABLE/);await assert.rejects(app.restoreBackup('none'),/AUTHORITY_LIFECYCLE_UNAVAILABLE/);await assert.rejects(app.managerControl.handle('backup-create'),/AUTHORITY_LIFECYCLE_UNAVAILABLE/);assert.equal(f.control.readWitness().controlSequence,before);noAncillary(f);
});
test('bootstrap advertises bounded capability coverage and never native corpus or lifecycle authority',async t=>{
 const f=prepared(t),app=appFor(t,f);
 const result=await request(app,'/bootstrap',{}, {method:'GET',headers:{'x-memory-suite-plugin':'libra'}}).result;
 assert.equal(result.status,200);assert.equal(result.body.capabilities['kv.v1'],true);for(const key of ['backup.v1','restore.v1','handoff-sync-proof.v1','libra-read-session.v1','scope-delete-commit.v1','storage-mode-contract.v2'])assert.notEqual(result.body.capabilities[key],true,key);
 assert.equal(result.body.authorityRuntime.serverActivation,false);assert.equal(result.body.storageModeContract,null);assert.equal(result.body.databaseSchemaVersion,3);
});
test('pending work or changed reset/restore evidence refuses startup and delayed mutators',async t=>{
 const f=prepared(t),app=appFor(t,f),delayed=request(app,'/v1/kv/set',{namespace:'libra',space:'plugin',key:'late',value:1,operationId:'late-body'},{defer:true});
 fs.writeFileSync(path.join(f.dataDir,'config','namespace-reset.json'),JSON.stringify({epochs:{libra:1},pending:null}));delayed.finish();const denied=await delayed.result;assert.equal(denied.status,503);assert.equal(app.repositories.libra.get('plugin','late').exists,false);assert.throws(()=>createMemorySuiteServer(config(f)));
 fs.unlinkSync(path.join(f.dataDir,'config','namespace-reset.json'));f.control.publishIntent({generation:f.control.readWitness().generation,namespace:'libra',operationId:'pending',fingerprint:'a'.repeat(64),operationClass:'kv'});assert.throws(()=>createMemorySuiteServer(config(f)),/AUTHORITY_BUSY/);
});
test('reopen keeps qualification and durable operation replay; legacy default stays closed on prepared DATA',async t=>{
 const f=prepared(t),initial=f.control.readInitialQualification(),first=createMemorySuiteServer(config(f));const input={kind:'set',space:'plugin',key:'libra:restart',value:'same',operationId:'restart-op'};const result=first.repositories.libra.mutate(input);await first.close();
 assert.throws(()=>createMemorySuiteServer({dataDir:f.dataDir,autoBackup:false,computeEnabled:false}),/AUTHORITY_LIFECYCLE_UNAVAILABLE/);
 const second=appFor(t,f);assert.deepEqual(second.repositories.libra.mutate(input),result);assert.deepEqual(f.control.readInitialQualification(),initial);noAncillary(f);
});

test('existing retired stores stay readable and immutable without requiring extra or retired enrollment',async t=>{
 const f=core3Fixture(t);
 for(const n of ['lia','retrace']){const file=path.join(f.dataDir,'stores',n,n+'.sqlite');fs.mkdirSync(path.dirname(file),{recursive:true});const db=new DatabaseSync(file);try{db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE kv(space TEXT NOT NULL,key TEXT NOT NULL,value_json TEXT,deleted INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL,digest TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(space,key));CREATE TABLE operations(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response_json TEXT NOT NULL,created_at INTEGER NOT NULL);PRAGMA user_version=1;");db.prepare('INSERT INTO kv VALUES(?,?,?,0,1,?,0)').run('plugin','retained',JSON.stringify(n),'a'.repeat(64));}finally{db.close();}}
 f.initialize();f.bind();f.qualify();const app=appFor(t,f);
 for(const n of ['lia','retrace']){const repo=app.repositories[n];assert.equal(repo.ephemeral,false);assert.equal(repo.get('plugin','retained').value,n);assert.throws(()=>repo.applyConditionalBatch([current(repo,'retained')],{maintenance:true,operationId:'retired-delete'}),/read_only/);assert.throws(()=>repo.maintainReceipts(),/read_only/);assert.throws(()=>repo.database.exec('DROP TABLE kv'),/readonly|read-only/i);}
 await app.close();for(const n of ['lia','retrace']){const db=new DatabaseSync(path.join(f.dataDir,'stores',n,n+'.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT value_json FROM kv').get().value_json,JSON.stringify(n));assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name GLOB 'authority_*'").get().n,0);}finally{db.close();}}
 assert.equal(fs.existsSync(path.join(f.dataDir,'stores','unknown-owner')),false);
});
test('changed receipt, missing owner and restore journal all refuse without startup repair',async t=>{
 for(const kind of ['receipt','owner','restore']){
  const f=prepared(t);let restore;
  if(kind==='receipt'){const db=new DatabaseSync(f.controlPath);try{db.prepare('UPDATE lifecycle_operations SET journal_json=?').run('{}');}finally{db.close();}}
  if(kind==='owner'){f.owners.flashback.close();fs.renameSync(f.ownerBindings.flashback.filePath,f.ownerBindings.flashback.filePath+'.retained');}
  if(kind==='restore'){fs.mkdirSync(path.join(f.dataDir,'migrations'));restore=path.join(f.dataDir,'migrations','restore-transaction.json');fs.writeFileSync(restore,'{"phase":"PREPARED","synthetic":"preserve"}');}
  assert.throws(()=>createMemorySuiteServer({...config(f),actualHostQualified:true,allWriterOwnership:true,serverActivation:true}));
  if(restore)assert.equal(fs.readFileSync(restore,'utf8'),' {"phase":"PREPARED","synthetic":"preserve"}'.trim());
  for(const p of ['logs','runtime','backups','data-layout.json','runtime-token.txt'])assert.equal(fs.existsSync(path.join(f.dataDir,p)),false);
 }
});
test('unprepared legacy default remains usable and does not select core3 from caller claims',async t=>{
 const f=core3Fixture(t),app=createMemorySuiteServer({dataDir:f.dataDir,autoBackup:false,computeEnabled:false,token:'offline-legacy-control',actualHostQualified:true,allWriterOwnership:true});
 t.after(async()=>{await app.close();app.server.emit('close');});
 assert.equal(app.authorityRuntime,undefined);assert.equal(fs.existsSync(f.markerPath),false);const result=await request(app,'/v1/kv/set',{namespace:'libra',space:'plugin',key:'libra:legacy-check',value:1,operationId:'legacy-default-write'}).result;assert.equal(result.status,200);assert.equal(app.repositories.libra.database.prepare('PRAGMA user_version').get().user_version,1);
 for(const n of ['lia','retrace'])assert.equal(fs.existsSync(path.join(f.dataDir,'stores',n)),false);
});
test('core3 bootstrap refuses unknown plugins and strong GRADIA consumers rather than minting unusable capabilities',async t=>{
 const f=prepared(t),app=appFor(t,f);
 for(const [plugin,status] of [['unknown-plugin',403],['serial_gradation_agents_for_rp',503]]){const r=await request(app,'/bootstrap',{}, {method:'GET',headers:{'x-memory-suite-plugin':plugin}}).result;assert.equal(r.status,status,plugin);assert.equal(r.body.token,undefined);}
});

for(const authorityEvidence of ['prepared','orphan'])test(`invalid physical reset and ${authorityEvidence} authority evidence both remain fail-closed`,t=>{
 const f=prepared(t),reset=path.join(f.dataDir,'config','namespace-reset.json');
 if(authorityEvidence==='orphan'){
  fs.renameSync(f.markerPath,path.join(f.root,'retained-marker.json'));
  fs.renameSync(path.dirname(f.controlPath),path.join(f.root,'retained-authority'));
 }
 fs.writeFileSync(reset,JSON.stringify({epochs:{libra:1},pending:{schema:'memory-suite.namespace-reset-job.v2',dataInstanceId:'A'.repeat(32),dataIdentityContract:'memory-suite.physical-data-identity.v1',id:'dual-invalid',namespaces:['libra'],completed:[]}}));
 const snapshot=()=>{const rows=[];const visit=dir=>{for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name);if(fs.lstatSync(file).isDirectory())visit(file);else rows.push([path.relative(f.dataDir,file),fs.readFileSync(file).toString('base64')]);}};visit(f.dataDir);return rows;};
 const before=snapshot();assert.throws(()=>createMemorySuiteServer({dataDir:f.dataDir,autoBackup:false,computeEnabled:false}),/namespace_reset_physical_binding_changed/);assert.deepEqual(snapshot(),before,'dual-invalid refusal changes no DATA bytes');
 fs.unlinkSync(reset);const authorityOnly=snapshot();assert.throws(()=>createMemorySuiteServer({dataDir:f.dataDir,autoBackup:false,computeEnabled:false}),/AUTHORITY_LIFECYCLE_UNAVAILABLE/);assert.deepEqual(snapshot(),authorityOnly,'clearing invalid reset cannot bypass prepared or orphan authority');
});
