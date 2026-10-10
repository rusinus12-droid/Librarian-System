'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,insertSource,OWNERS}=require('./fixtures/authority_sqlite_fixture.cjs');
const O=require('../server/authority/owner-store.cjs');
const {createAuthorityCoordinator}=require('../server/authority/coordinator.cjs');
const {DatabaseSync}=require('node:sqlite');
const strict=require('./fixtures/authority_strict_guard_probe.cjs').capture();
const input=id=>({namespace:'libra',operationId:id,fingerprint:'a'.repeat(64),operationClass:'maintenance'});
function coordinator(f,c){return createAuthorityCoordinator({control:c,resolveOwnerStore:n=>f.owners[n]});}
function put(tx,key){tx.run('INSERT INTO kv VALUES(?,?,?,0,1,?,0)','plugin',key,'"value"','digest');}
for(const namespace of OWNERS)test('public_close_terminal_'+namespace,t=>{
 const f=fixture(t),c=f.activate(),store=f.owners[namespace],key={generation:c.readWitness().generation,namespace,operationId:'retired'};store.close();store.close();
 for(const run of [()=>O.verifyOwnerGuards(store),()=>O.readOwnerReceipt(store,key),()=>O.readOwnerOperationResult(store,key),()=>O.readSourceStamps(store,[])])assert.throws(run,{code:'AUTHORITY_CLOSED'});
 strict?.verify();
});
test('retired_owner_refuses_before_new_intent',t=>{
 const f=fixture(t),c=f.activate(),runner=coordinator(f,c);f.owners.libra.close();let called=false;
 assert.throws(()=>runner.runMutation(input('no-intent'),()=>{called=true;}),{code:'AUTHORITY_CLOSED'});
 assert.equal(called,false);assert.equal(c.readOperation({...input('no-intent'),generation:c.readWitness().generation}),null);
});
test('active_transaction_close_refuses_without_retiring_and_stale_facade_ends',t=>{
 const f=fixture(t),c=f.activate(),runner=coordinator(f,c);let held;
 const result=runner.runMutation(input('active-close'),tx=>{held=tx;assert.throws(()=>f.owners.libra.close(),{code:'AUTHORITY_BUSY'});put(tx,'active-close');});
 assert.equal(result.status,'committed');assert.doesNotThrow(()=>O.verifyOwnerGuards(f.owners.libra));f.owners.libra.close();assert.throws(()=>held.get('SELECT 1'),{code:'OWNER_TRANSACTION_ENDED'});
});
test('private_rollback_failure_close_success_remains_recoverable',t=>{
 const f=fixture(t),c=f.activate(),runner=coordinator(f,c),exec=DatabaseSync.prototype.exec,prepare=DatabaseSync.prototype.prepare;
 let failedCommit=false,failedRollback=false,failedDb;
 DatabaseSync.prototype.exec=function(sql){const isOwner=prepare.call(this,'PRAGMA database_list').all().some(r=>r.file===f.ownerBindings.libra.filePath);if(isOwner&&sql==='COMMIT'&&!failedCommit){failedCommit=true;failedDb=this;throw Error('TEST_COMMIT_FAILURE');}if(this===failedDb&&sql==='ROLLBACK'&&!failedRollback){failedRollback=true;throw Error('TEST_ROLLBACK_FAILURE');}return exec.call(this,sql);};
 try{assert.throws(()=>runner.runMutation(input('private-close'),tx=>put(tx,'rolled-back')),/TEST_COMMIT_FAILURE/);}finally{DatabaseSync.prototype.exec=exec;}
 assert.equal(failedCommit,true);assert.equal(failedRollback,true);assert.equal(c.readOperation({...input('private-close'),generation:c.readWitness().generation}).status,'aborted');
 assert.throws(()=>failedDb.prepare('SELECT 1'),/closed|open/i);
 const next=runner.runMutation(input('private-new'),tx=>put(tx,'private-new'));assert.equal(next.status,'committed');
 const db=new DatabaseSync(f.ownerBindings.libra.filePath,{readOnly:true});try{assert.equal(db.prepare("SELECT COUNT(*) n FROM kv WHERE key='rolled-back'").get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM kv WHERE key='private-new'").get().n,1);}finally{db.close();}
 f.owners.libra.close();assert.throws(()=>O.verifyOwnerGuards(f.owners.libra),{code:'AUTHORITY_CLOSED'});
});
test('public_close_failure_preserves_fatal_exit70',async t=>{
 const f=fixture(t);f.activate();const {spawn}=require('node:child_process'),path=require('node:path');
 const child=spawn(process.execPath,[path.join(__dirname,'fixtures/authority_owner_retirement_driver.cjs'),JSON.stringify({dataDir:f.dataDir})],{env:{...process.env,LANG:'C',TZ:'UTC',NODE_OPTIONS:process.env.NODE_OPTIONS,LIBRA_NETWORK_AUDIT:process.env.LIBRA_NETWORK_AUDIT},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});f.children.add({child,done});const result=await done;
 assert.equal(result.code,70);assert.equal(result.signal,null);assert.equal(stdout,'');assert.equal(stderr,'AUTHORITY_UNSAFE_TRANSACTION_END\n');
});
