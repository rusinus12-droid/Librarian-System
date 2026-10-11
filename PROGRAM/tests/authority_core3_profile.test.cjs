'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const C=require('../server/authority/contracts.cjs'),Core=require('../server/authority/control-store.cjs'),O=require('../server/authority/owner-store.cjs');
const {core3Fixture,OWNERS,PROFILE}=require('./fixtures/authority_core3_fixture.cjs');
function serverInternals(){const Module=require('node:module'),file=require.resolve('../server/server.cjs'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.createRepository=createRepository;\n',file);return m.exports;}
const missingRetired=f=>{for(const n of ['lia','retrace','unknown-owner'])assert.equal(fs.existsSync(path.join(f.dataDir,'stores',n)),false,n+' must not be created');};
test('explicit core3 preparation and genuine qualification need only three physical owners',t=>{
 const f=core3Fixture(t),before=OWNERS.map(n=>f.databases[n].prepare('SELECT * FROM kv').all());f.initialize();f.bind();
 assert.equal(f.control.readWitness().contract,'memory-suite.server-authority.v2');assert.equal(f.control.readWitness().authorityProfile,PROFILE);
 const marker=JSON.parse(fs.readFileSync(f.markerPath));assert.equal(marker.schema,'memory-suite.server-authority-activation.v2');assert.equal(marker.authorityProfile,PROFILE);
 const result=f.qualify();assert.equal(result.outcome,'committed');assert.equal(result.currentQualification.status,'ready');
 assert.equal(result.receipt.contract,'memory-suite.initial-owner-qualification.v2');assert.equal(result.receipt.authorityProfile,PROFILE);assert.equal(result.receipt.qualificationScope,'isolated-core3-owner-backend.v2');
 assert.deepEqual(result.receipt.ownerProofs.map(p=>p.namespace),OWNERS);assert.deepEqual(Object.keys(result.receipt.sourceCoverage).sort(),[...OWNERS].sort());assert.deepEqual(OWNERS.map(n=>f.databases[n].prepare('SELECT * FROM kv').all()),before);
 for(const n of OWNERS){assert.equal(f.databases[n].prepare('PRAGMA user_version').get().user_version,3);assert.throws(()=>f.databases[n].exec("UPDATE kv SET revision=99"));O.verifyOwnerGuards(f.owners[n]);}
 assert.deepEqual(f.qualify().receipt,result.receipt);assert.deepEqual(f.track(Core.openAuthorityStore({dataDir:f.dataDir,authorityProfile:PROFILE})).readInitialQualification(),result.receipt);missingRetired(f);
});
test('profile selection cannot silently convert legacy defaults, markers or receipts',t=>{
 const f=core3Fixture(t);assert.throws(()=>Core.initializeAuthorityStore({...f,authorityProfile:undefined}),{code:'INVALID_OWNER_BINDINGS'});assert.equal(fs.existsSync(f.markerPath),false);
 f.initialize();f.bind();assert.throws(()=>f.qualify({authorityProfile:undefined}),{code:'AUTHORITY_PROFILE_MISMATCH'});
 const receipt=f.qualify().receipt;assert.throws(()=>Core.initializeAuthorityStore({...f,authorityProfile:C.LEGACY_AUTHORITY_PROFILE}),{code:'AUTHORITY_PROFILE_MISMATCH'});
 assert.throws(()=>Core.openAuthorityStore({dataDir:f.dataDir,authorityProfile:'unknown-profile'}),{code:'INVALID_AUTHORITY_PROFILE'});
 const bytes=fs.readFileSync(f.markerPath);const legacy={...JSON.parse(bytes),schema:'memory-suite.server-authority-activation.v1'};delete legacy.authorityProfile;fs.writeFileSync(f.markerPath,JSON.stringify(legacy));
 assert.throws(()=>Core.readActivationState({dataDir:f.dataDir}),{code:'AUTHORITY_QUARANTINED'});fs.writeFileSync(f.markerPath,bytes);
 const db=new DatabaseSync(f.controlPath);try{db.prepare('UPDATE lifecycle_operations SET journal_json=?').run(C.canonical({...receipt,contract:'memory-suite.initial-owner-qualification.v1'}));assert.throws(()=>f.control.readInitialQualification(),{code:'AUTHORITY_QUARANTINED'});}finally{db.close();}missingRetired(f);
});
test('core3 rejects retired and unknown-owner writes before resolving owners or creating a repository',t=>{
 const f=core3Fixture(t);f.initialize();f.bind();f.qualify();let resolutions=0;
 const coordinator=require('../server/authority/coordinator.cjs').createAuthorityCoordinator({control:f.control,resolveOwnerStore:n=>{resolutions++;return f.owners[n];}});
 const server=serverInternals();
 for(const namespace of ['lia','retrace','unknown-owner']){
  const op={generation:f.control.readWitness().generation,namespace,operationId:'blocked-'+namespace,fingerprint:'a'.repeat(64),operationClass:'kv'};
  assert.throws(()=>coordinator.runMutation(op,()=>assert.fail('body must not run')));assert.throws(()=>f.control.publishIntent(op));
  assert.throws(()=>server.createRepository(f.dataDir,namespace,()=>false,f.control));
 }
 assert.equal(resolutions,0);assert.equal(f.control.readWitness().controlSequence,1);missingRetired(f);
});
test('all three live SQLite locks are required during actual core3 receipt publication',t=>{
 const f=core3Fixture(t);f.initialize();f.bind();const raw=DatabaseSync.prototype.prepare;let publications=0;
 DatabaseSync.prototype.prepare=function(sql){const stmt=raw.call(this,sql);if(/^INSERT INTO lifecycle_operations/.test(sql)){const run=stmt.run;stmt.run=function(...args){publications++;for(const n of OWNERS){const rival=new DatabaseSync(f.ownerBindings[n].filePath);try{rival.exec('PRAGMA busy_timeout=1');assert.throws(()=>rival.exec('BEGIN IMMEDIATE'),/busy|locked/i);}finally{rival.close();}}return run.apply(this,args);};}return stmt;};
 try{f.qualify();}finally{DatabaseSync.prototype.prepare=raw;}assert.equal(publications,1);missingRetired(f);
});
test('core3 publisher refuses partial, duplicate or forged locks and remains preparing',t=>{
 const f=core3Fixture(t);f.initialize();f.bind();f.control.withExclusiveGate(permit=>{
  const context=Core.assertInitialQualificationContext(permit);for(const n of OWNERS)O.installOwnerGuards(f.owners[n],{...context,controlPermit:permit});
  const locks=OWNERS.map(n=>O.lockOwnerForInitialQualification(f.owners[n],permit));try{
   for(const supplied of [locks.slice(0,2),[locks[0],locks[0],locks[2]],locks.map(()=>({end(){}}))])assert.throws(()=>f.control.commitInitialQualification(permit,supplied),{code:'INVALID_INITIAL_OWNER_LOCK'});
  }finally{for(const lock of locks.reverse())lock.end();}
 });assert.equal(f.control.readWitness().status,'preparing');assert.equal(f.qualify().currentQualification.status,'ready');missingRetired(f);
});
test('core3 per-owner mutations retain real fences and receipts across qualification replay',t=>{
 const f=core3Fixture(t);f.initialize();f.bind();const initial=f.qualify().receipt;
 const coordinator=require('../server/authority/coordinator.cjs').createAuthorityCoordinator({control:f.control,resolveOwnerStore:n=>f.owners[n]});
 for(const namespace of OWNERS){const operationId='write-'+namespace,fingerprint='a'.repeat(64);const result=coordinator.runMutation({namespace,operationId,fingerprint,operationClass:'kv'},tx=>{
  tx.run('UPDATE kv SET revision=revision+1');tx.run('INSERT INTO operations VALUES(?,?,?,?)',operationId,fingerprint,'{"ok":true}',1);
 });assert.equal(result.status,'committed');assert.equal(result.decision.receipt.namespace,namespace);assert.equal(result.decision.receipt.fenceEpoch,1);assert.equal(f.databases[namespace].prepare('SELECT revision FROM kv').get().revision,2);}
 assert.deepEqual(f.qualify().receipt,initial);assert.equal(f.control.readWitness().controlSequence,7);missingRetired(f);
});
test('retired inventory is optional and untouched; prepared core3 still closes normal startup',t=>{
 const f=core3Fixture(t),server=serverInternals();
 for(const n of ['lia','retrace']){const repository=server.createRepository(f.dataDir,n);try{assert.equal(repository.ephemeral,true);assert.equal(repository.legacyReadOnly,true);assert.deepEqual(repository.list('plugin'),{keys:[],tombstones:[],records:[]});}finally{repository.close();}}
 missingRetired(f);f.initialize();f.bind();f.qualify();
 assert.throws(()=>server.createMemorySuiteServer({dataDir:f.dataDir,autoBackup:false}),{code:'AUTHORITY_LIFECYCLE_UNAVAILABLE'});missingRetired(f);
});
test('a missing third genuine owner refuses before installing any core3 guards',t=>{
 const f=core3Fixture(t);f.initialize();f.bind();const third=f.owners.flashback;f.owners.flashback={namespace:'flashback'};
 assert.throws(()=>f.qualify(),{code:'INVALID_OWNER_STORE'});for(const n of OWNERS)assert.equal(f.databases[n].prepare('PRAGMA user_version').get().user_version,1);
 assert.equal(f.control.readInitialQualification(),null);assert.equal(f.control.readWitness().status,'preparing');f.owners.flashback=third;assert.equal(f.qualify().currentQualification.status,'ready');missingRetired(f);
});
test('core3 historical qualification stays committed while ordinary work is pending',t=>{
 const f=core3Fixture(t);f.initialize();f.bind();const first=f.qualify().receipt;
 f.control.publishIntent({generation:first.generation,namespace:'hayaku',operationId:'pending',fingerprint:'b'.repeat(64),operationClass:'kv'});
 const result=f.qualify();assert.equal(result.outcome,'committed');assert.deepEqual(result.receipt,first);assert.deepEqual(result.currentQualification,{status:'busy',reason:'ordinary_pending'});missingRetired(f);
});
test('historical five-owner marker and receipt bytes stay v1 under reopen and rejected conversion',t=>{
 const f=require('./fixtures/authority_initial_fixture.cjs').initialFixture(t),receipt=f.qualifier().qualifyInitialOwners().receipt;
 const markerBytes=fs.readFileSync(f.markerPath),db=new DatabaseSync(f.controlPath,{readOnly:true});let journal;try{journal=db.prepare('SELECT journal_json FROM lifecycle_operations').get().journal_json;assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);}finally{db.close();}
 const reopened=f.track(Core.openAuthorityStore({dataDir:f.dataDir,authorityProfile:C.LEGACY_AUTHORITY_PROFILE}));
 assert.deepEqual(reopened.readInitialQualification(),receipt);assert.equal(receipt.contract,'memory-suite.initial-owner-qualification.v1');assert.equal(Object.hasOwn(receipt,'authorityProfile'),false);assert.equal(receipt.ownerProofs.length,5);assert.equal(Object.hasOwn(reopened.readWitness(),'authorityProfile'),false);
 assert.throws(()=>Core.initializeAuthorityStore({...f,authorityProfile:PROFILE}),{code:'AUTHORITY_PROFILE_MISMATCH'});
 assert.throws(()=>require('../server/authority/initial-qualification.cjs').createInitialOwnerQualifier({dataDir:f.dataDir,control:f.control,authorityProfile:PROFILE,resolveOwnerStore:n=>f.owners[n]}),{code:'AUTHORITY_PROFILE_MISMATCH'});
 assert.deepEqual(fs.readFileSync(f.markerPath),markerBytes);const after=new DatabaseSync(f.controlPath,{readOnly:true});try{assert.equal(after.prepare('SELECT journal_json FROM lifecycle_operations').get().journal_json,journal);}finally{after.close();}
});
