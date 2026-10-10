'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{fork}=require('node:child_process'),{once}=require('node:events');
const {createMemorySuiteServer}=require('../server/server.cjs');
const results=[];async function test(name,fn){await fn();results.push(name);console.log('PASS',name);}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'memory-suite-batch-'));
const fresh=(key,value)=>({kind:'set',space:'plugin',key,value,expectedRevision:0,expectedDigest:'',expectedExists:false,expectedTombstone:false});
const cond=(key,row)=>({space:'plugin',key,expectedRevision:row.revision,expectedDigest:row.digest,expectedExists:row.exists,expectedTombstone:row.tombstone});
async function client(port,plugin='libra'){
 const base=`http://127.0.0.1:${port}`,boot=await fetch(base+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':plugin}}).then(r=>r.json());assert.ok(boot.token);
 const send=async(method,route,body)=>{const r=await fetch(base+route,{method,headers:{Authorization:`Bearer ${boot.token}`,'X-Memory-Suite-Plugin':plugin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,...await r.json()};};
 return {send,boot,batch:(op,mutations,conditions=[])=>send('POST','/v1/kv/batch',{namespace:'libra',operationId:op,mutations,conditions}),get:async key=>(await send('GET',`/v1/kv/get?namespace=libra&space=plugin&key=${encodeURIComponent(key)}`)).result};
}
async function child(dir){const p=fork(path.join(__dirname,'fixtures/server_atomic_batch_child.cjs'),[dir],{stdio:['ignore','ignore','pipe','ipc']});let errors='';p.stderr.on('data',d=>errors+=d);const [address]=await Promise.race([once(p,'message'),once(p,'exit').then(()=>{throw Error(errors)}),new Promise((_,reject)=>setTimeout(()=>reject(Error('child startup timeout')),10000).unref())]);return {p,c:await client(address.port),errors:()=>errors};}
async function stop(p){if(p.exitCode!=null||p.signalCode)return;const exit=once(p,'exit');p.send({kind:'close'});await exit;}
(async()=>{
 let app,one,two;
 try{
  app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:path.join(root,'normal'),autoBackup:false});const addr=await app.listen(),c=await client(addr.port);
  await test('authenticated capability advertises bounded conditional batch; set/check commits atomically',async()=>{
   assert.equal(c.boot.capabilities['conditional-batch.v1'],true);
   const first=await c.batch('batch_first_0001',[fresh('libra:test:basis',{source:1}),fresh('libra:test:head',{turn:5})]);assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.result.receipts.length,2);assert.equal(first.result.atomicScope,'single_namespace_sqlite');
   const basis=await c.get('libra:test:basis'),head=await c.get('libra:test:head');
   const out=await c.batch('batch_checked_0002',[{...cond('libra:test:head',head),kind:'set',value:{turn:10}}],[cond('libra:test:basis',basis)]);assert.equal(out.status,200);assert.equal(out.result.checked,1);assert.equal((await c.get('libra:test:basis')).revision,1);assert.equal((await c.get('libra:test:head')).revision,2);
  });
  await test('stale prerequisite or one stale key rejects every write',async()=>{
   const head=await c.get('libra:test:head'),before=JSON.stringify(head);const out=await c.batch('batch_stale_0003',[fresh('libra:test:should-not-exist',1),{...cond('libra:test:head',head),expectedRevision:1,kind:'set',value:999}]);assert.equal(out.status,409);assert.equal((await c.get('libra:test:should-not-exist')).exists,false);assert.equal(JSON.stringify(await c.get('libra:test:head')),before);
   const bad=await c.batch('batch_stale_read_0003',[fresh('libra:test:should-not-exist',1)],[{...cond('libra:test:head',head),expectedDigest:'0'.repeat(64)}]);assert.equal(bad.status,409);assert.equal((await c.get('libra:test:should-not-exist')).exists,false);
  });
  await test('idempotent retry returns original committed receipt even after response loss and later writes',async()=>{
   const body=[fresh('libra:test:idem',{first:true})],a=await c.batch('batch_idempotent_0004',body),row=await c.get('libra:test:idem');assert.equal(a.status,200);
   await c.batch('batch_later_0004',[{...cond('libra:test:idem',row),kind:'set',value:'later'}]);const b=await c.batch('batch_idempotent_0004',body);assert.deepEqual(b,a);assert.equal((await c.get('libra:test:idem')).value,'later');
   const conflict=await c.batch('batch_idempotent_0004',[fresh('libra:test:idem','different')]);assert.equal(conflict.status,409);assert.equal(conflict.error,'operation_id_payload_conflict');
  });
  await test('SQLite failure after the first row rolls back rows and operation receipt together',async()=>{
   app.repositories.libra.database.exec("CREATE TEMP TRIGGER fixture_fail BEFORE INSERT ON kv WHEN NEW.key='libra:test:fail-second' BEGIN SELECT RAISE(ABORT,'fixture_write_failure'); END;");
   const out=await c.batch('batch_rollback_0005',[fresh('libra:test:fail-first','one'),fresh('libra:test:fail-second','two')]);assert.equal(out.status,500);assert.equal((await c.get('libra:test:fail-first')).exists,false);assert.equal((await c.get('libra:test:fail-second')).exists,false);assert.equal(app.repositories.libra.operation('batch_rollback_0005'),null);
   app.repositories.libra.database.exec('DROP TRIGGER fixture_fail');const retry=await c.batch('batch_rollback_0005',[fresh('libra:test:fail-first','one'),fresh('libra:test:fail-second','two')]);assert.equal(retry.status,200);
  });
  await test('batch removal preserves tombstone revision and rejects ABA reuse',async()=>{
   await c.batch('batch_tomb_0006',[fresh('libra:test:tomb','old')]);const row=await c.get('libra:test:tomb');const out=await c.batch('batch_tomb_remove_0006',[{...cond('libra:test:tomb',row),kind:'remove'}]);assert.equal(out.status,200);const tomb=await c.get('libra:test:tomb');assert.equal(tomb.tombstone,true);assert.equal(tomb.revision,2);assert.equal((await c.batch('batch_tomb_stale_0006',[fresh('libra:test:tomb','incorrect')])).status,409);
   assert.equal((await c.batch('batch_tomb_revive_0006',[{...cond('libra:test:tomb',tomb),kind:'set',value:'restored'}])).status,200);assert.equal((await c.get('libra:test:tomb')).revision,3);
  });
  await test('strict item bounds, duplicate keys, purge, missing exact predicates and credential keys are rejected',async()=>{
   const checks=[{mutations:[{...fresh('libra:test:shape',1),expectedRevision:null}]},{mutations:[{...fresh('libra:test:shape',1),expectedDigest:undefined}]},{mutations:[{...fresh('libra:test:shape',1),kind:'purge'}]}, {mutations:[fresh('libra:test:shape',1),fresh('libra:test:shape',2)]}, {mutations:Array.from({length:65},(_,i)=>fresh('libra:test:large'+i,i))}, {mutations:[fresh('provider_api_key','not-a-real-secret')]}];
   for(let i=0;i<checks.length;i++){const out=await c.send('POST','/v1/kv/batch',{namespace:'libra',operationId:'batch_bad_0007_'+i,...checks[i]});assert.equal(out.status,400,JSON.stringify(out));}assert.equal((await c.get('libra:test:shape')).exists,false);
  });
  await test('namespace owner authorization is enforced and manager/peer cannot escalate via batch',async()=>{
   const flash=await client(addr.port,'flashback_memory'),manager=await client(addr.port,'flashback_hayaku_bridge'),peer=await client(addr.port,'flashback_hayaku_bridge:peer:libra');
   for(const x of [flash,manager,peer])assert.equal((await x.batch('batch_cross_owner_0008',[fresh('libra:test:forbidden',true)])).status,403);assert.equal((await c.get('libra:test:forbidden')).exists,false);
  });
  await test('receipt and revisions survive actual close/restart without a second mutation',async()=>{
   const body=[fresh('libra:test:restart','value')],first=await c.batch('batch_restart_0009',body);await app.close();app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:path.join(root,'normal'),autoBackup:false});const address=await app.listen(),next=await client(address.port);assert.deepEqual(await next.batch('batch_restart_0009',body),first);assert.equal((await next.get('libra:test:restart')).revision,1);
  });
  await test('two actual server processes race on same SQLite namespace and exactly one revision wins',async()=>{
   const dir=path.join(root,'shared');one=await child(dir);two=await child(dir);
   await one.c.batch('batch_seed_race_0010',[fresh('libra:test:race-head',0),fresh('libra:test:race-registry',0)]);const a=await one.c.get('libra:test:race-head'),b=await one.c.get('libra:test:race-registry');
   const payload=n=>[{...cond('libra:test:race-head',a),kind:'set',value:n},{...cond('libra:test:race-registry',b),kind:'set',value:n}];
   const out=await Promise.all([one.c.batch('batch_race_one_0010',payload(1)),two.c.batch('batch_race_two_0010',payload(2))]);assert.deepEqual(out.map(r=>r.status).sort(),[200,409]);const head=await one.c.get('libra:test:race-head'),registry=await two.c.get('libra:test:race-registry');assert.equal(head.value,registry.value);assert.equal(head.revision,2);assert.equal(registry.revision,2);
  });
  await test('process killed between two SQLite writes leaves neither committed and retry succeeds',async()=>{
   const pending=once(one.p,'message');one.p.send({kind:'crash-trigger'});assert.equal((await pending)[0].triggerReady,true);const exit=once(one.p,'exit');
   await assert.rejects(()=>one.c.batch('batch_crash_recovery_0011',[fresh('libra:test:crash-first','first'),fresh('libra:test:crash-second','second')]));await exit;
   assert.equal((await two.c.get('libra:test:crash-first')).exists,false);assert.equal((await two.c.get('libra:test:crash-second')).exists,false);
   const out=await two.c.batch('batch_crash_recovery_0011',[fresh('libra:test:crash-first','first'),fresh('libra:test:crash-second','second')]);assert.equal(out.status,200);assert.equal(out.result.receipts.length,2);
  });
  console.log(JSON.stringify({test:'server_conditional_batch_v1',passed:results.length,results,boundary:'real local HTTP and SQLite; one namespace file; not cross-namespace or plugin mirror consistency'}));
 }finally{if(one)await stop(one.p);if(two)await stop(two.p);if(app)await app.close();fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
