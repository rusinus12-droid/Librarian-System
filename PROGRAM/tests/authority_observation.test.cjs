'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {observationFixture}=require('./fixtures/authority_observation_fixture.cjs');
function factory(){const p=path.join(__dirname,'../server/authority/observation.cjs');assert.equal(fs.existsSync(p),true,'genuine backend observer must exist');return require(p).createAuthorityObserver;}
function observer(t,f){const o=factory()({dataDir:f.dataDir,control:f.control});t.after(()=>o.close());return o;}
test('genuine core3 receipt captures immutable complete facts without writer binder',t=>{
 const f=observationFixture(t),O=require('../server/authority/owner-store.cjs'),old=O.bindOwnerStore;O.bindOwnerStore=()=>assert.fail('read cannot bind writer');t.after(()=>O.bindOwnerStore=old);
 const before=f.databases.libra.prepare('SELECT * FROM kv').all(),o=observer(t,f),capture=o.observeCanonicalFacts(f.request());
 assert.equal(capture.summary.usage,'backend-verification-only');assert.equal(capture.summary.qualificationScope,'isolated-core3-owner-backend.v2');assert.equal(capture.summary.bindingModel,'qualified-writer-observed-path.v1');
 assert.equal(capture.summary.routeAuthority,'unavailable');assert.equal(capture.summary.nativeAuthority,'unavailable');assert.equal(capture.summary.recallEligibility,'unqualified');
 const args={handle:capture.handle,requestId:'request1'},view=o.readCaptured(args);assert.equal(view.items[0].text,f.memory.text);assert.equal(view,o.readCaptured(args));assert.equal(Object.isFrozen(view.items[0]),true);assert.throws(()=>view.items[0].text='changed');
 assert.deepEqual(f.databases.libra.prepare('SELECT * FROM kv').all(),before);assert.equal(o.assertCurrent(args).status,'current');
 o.release(args);o.release(args);assert.throws(()=>o.readCaptured(args),{code:'OBSERVATION_RELEASED'});assert.equal(view.items[0].text,f.memory.text);
 assert.equal(o.getUsage(args).issuerRetainedCreditBytes,0);for(const n of ['lia','retrace'])assert.equal(fs.existsSync(path.join(f.dataDir,'stores',n)),false);
});
test('forged controls, handles, request shapes and stronger corpus claims refuse',t=>{
 const f=observationFixture(t),create=factory();for(const control of [{}, {...f.control}])assert.throws(()=>create({dataDir:f.dataDir,control}),{code:'INVALID_AUTHORITY_STORE'});
 const o=observer(t,f),capture=o.observeCanonicalFacts(f.request());
 for(const handle of [{},{...capture.handle},JSON.parse(JSON.stringify(capture.handle))])assert.throws(()=>o.readCaptured({handle,requestId:'request1'}),{code:'INVALID_OBSERVATION_HANDLE'});
 assert.throws(()=>o.readCaptured({handle:capture.handle,requestId:'other'}),{code:'INVALID_OBSERVATION_HANDLE'});
 for(const change of [{namespace:'lia'},{space:'local'},{starts:[1,1]},{scopeKey:'bad\u0000key'},{codec:'custom'},{proof:'gradia.owner-corpus.v2'}])assert.throws(()=>o.observeCanonicalFacts({...f.request(),...change}));
 assert.throws(()=>o.captureCorpus({}),{code:'SOURCE_PROOF_UNAVAILABLE'});
});
test('unrelated genuine writes allow newer sequence but relevant body changes revoke',t=>{
 const f=observationFixture(t),o=observer(t,f),capture=o.observeCanonicalFacts(f.request()),args={handle:capture.handle,requestId:'request1'};
 f.mutate('unrelated',{ok:true});const current=o.assertCurrent(args);assert.ok(current.checkedControlSequence>capture.summary.captureWitness.controlSequence);
 f.mutate(f.key,{...f.memory,text:'changed'});assert.throws(()=>o.assertCurrent(args),{code:'SOURCE_CHANGED'});assert.throws(()=>o.readCaptured(args),{code:'SOURCE_CHANGED'});
});
test('optional never-present creation and retained purge history invalidate old facts',t=>{
 const f=observationFixture(t),o=observer(t,f),capture=o.observeCanonicalFacts(f.request()),args={handle:capture.handle,requestId:'request1'},key=`libra:v1:scope:${f.scopeKey}:recall-catalog:v1`;
 f.mutate(key,{schema:'catalog'});f.mutate(key,null,{purge:true});assert.throws(()=>o.assertCurrent(args),{code:'SOURCE_CHANGED'});
 const second=o.observeCanonicalFacts(f.request('request2'));assert.equal(second.summary.captureWitness.controlSequence,5);assert.equal(o.assertCurrent({handle:second.handle,requestId:'request2'}).status,'current');
});
test('pending control work is temporary busy and does not destroy historical qualification or handles',t=>{
 const f=observationFixture(t),o=observer(t,f),capture=o.observeCanonicalFacts(f.request()),args={handle:capture.handle,requestId:'request1'};
 const intent=f.control.publishIntent({generation:f.initial.generation,namespace:'hayaku',operationId:'pending',fingerprint:'a'.repeat(64),operationClass:'maintenance'});
 assert.throws(()=>o.assertCurrent(args),{code:'AUTHORITY_BUSY'});assert.equal(o.readCaptured(args).items.length,1);assert.deepEqual(f.control.readInitialQualification(),f.initial);
 f.control.withExclusiveGate(permit=>f.control.finalizeIntent(permit,intent,{status:'aborted'}));assert.equal(o.assertCurrent(args).status,'current');assert.equal(o.getUsage(args).currentnessCalls,2);
});
test('initial receipt missing and nonempty journal fail closed without bootstrap',t=>{
 const f=observationFixture(t),create=factory(),db=new DatabaseSync(f.controlPath);t.after(()=>db.close());db.exec('DELETE FROM lifecycle_operations');
 const o=create({dataDir:f.dataDir,control:f.control});t.after(()=>o.close());assert.throws(()=>o.observeCanonicalFacts(f.request()),{code:'INITIAL_QUALIFICATION_REQUIRED'});
});
test('unsafe nonempty sidecar refuses without changing its bytes',t=>{
 const f=observationFixture(t),o=observer(t,f),file=f.ownerBindings.libra.filePath+'-journal';fs.writeFileSync(file,'not safe');
 assert.throws(()=>o.observeCanonicalFacts(f.request()),{code:'SOURCE_PROOF_UNAVAILABLE'});assert.equal(fs.readFileSync(file,'utf8'),'not safe');fs.unlinkSync(file);
 const capture=o.observeCanonicalFacts(f.request());assert.equal(o.readCaptured({handle:capture.handle,requestId:'request1'}).items.length,1);
});
test('four retained handles, eight currentness calls and closed genuine control are enforced',t=>{
 const f=observationFixture(t),o=observer(t,f),captures=Array.from({length:4},(_,i)=>o.observeCanonicalFacts(f.request('r'+i)));
 assert.throws(()=>o.observeCanonicalFacts(f.request('overflow')),{code:'RESOURCE_LIMIT'});
 const args={handle:captures[0].handle,requestId:'r0'};for(let i=0;i<8;i++)assert.equal(o.assertCurrent(args).status,'current');assert.throws(()=>o.assertCurrent(args),{code:'OBSERVATION_CHECK_LIMIT'});
 o.release(args);assert.ok(o.observeCanonicalFacts(f.request('replacement')).handle);f.control.close();assert.throws(()=>o.assertCurrent({handle:captures[1].handle,requestId:'r1'}),{code:'AUTHORITY_CLOSED'});
});
test('genuine SQLite commit between bracket reads retries without publishing the mixed attempt',t=>{
 const f=observationFixture(t),o=observer(t,f),original=DatabaseSync.prototype.prepare;let injected=false;
 DatabaseSync.prototype.prepare=function(sql){const stmt=original.call(this,sql);if(sql.startsWith('SELECT CASE WHEN typeof(k.value_json)')){const get=stmt.get;stmt.get=function(...args){const result=get.apply(this,args);if(!injected){injected=true;f.mutate('unrelated-between-brackets',{ok:true});}return result;};}return stmt;};
 try{const capture=o.observeCanonicalFacts(f.request());assert.equal(injected,true);assert.equal(capture.summary.captureCounters.attempts,2);assert.equal(capture.summary.captureWitness.controlSequence,3);assert.equal(o.readCaptured({handle:capture.handle,requestId:'request1'}).items[0].text,f.memory.text);}finally{DatabaseSync.prototype.prepare=original;}
});
test('capture and currentness issue only readonly SQL; currentness never reloads source bodies',t=>{
 const f=observationFixture(t),o=observer(t,f),originalPrepare=DatabaseSync.prototype.prepare,originalExec=DatabaseSync.prototype.exec;let checking=false,statements=0;
 DatabaseSync.prototype.exec=function(sql){assert.match(sql,/^(?:BEGIN|ROLLBACK|PRAGMA query_only=ON; PRAGMA busy_timeout=0;)/);return originalExec.call(this,sql);};
 DatabaseSync.prototype.prepare=function(sql){assert.match(sql,/^(?:SELECT|WITH|PRAGMA)/);if(checking){assert.doesNotMatch(sql,/json_(?:tree|each|extract|valid)|THEN CAST\(k\.value_json AS BLOB\)/);assert.doesNotMatch(sql,/authority_routes|intent_json/);}statements++;return originalPrepare.call(this,sql);};
 try{const capture=o.observeCanonicalFacts(f.request()),args={handle:capture.handle,requestId:'request1'};checking=true;assert.equal(o.assertCurrent(args).status,'current');const before=statements;assert.equal(o.readCaptured(args),o.readCaptured(args));assert.equal(statements,before);}finally{DatabaseSync.prototype.prepare=originalPrepare;DatabaseSync.prototype.exec=originalExec;}
});
test('unsupported lifecycle refuses without loading its journal payload',t=>{
 const f=observationFixture(t),o=observer(t,f),db=new DatabaseSync(f.controlPath);t.after(()=>db.close());
 db.prepare('INSERT INTO lifecycle_operations VALUES(?,?,?,?)').run('future-reset','reset','pending','large-untrusted-journal');
 assert.throws(()=>o.observeCanonicalFacts(f.request()),{code:'SOURCE_PROOF_UNAVAILABLE'});assert.deepEqual(db.prepare('SELECT journal_json FROM lifecycle_operations WHERE operation_id=?').get('future-reset').journal_json,'large-untrusted-journal');
});
