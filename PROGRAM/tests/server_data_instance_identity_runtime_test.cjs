'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createMemorySuiteServer,createRecoverySafeModeServer}=require('../server/server.cjs');
const {validateServerIdentity}=require('../tools/platform_launcher.cjs');
const sharedToken=crypto.randomBytes(36).toString('base64url');
const fixture=()=>fs.mkdtempSync(path.join(os.tmpdir(),'suite-data-identity-'));
const removeFixture=dir=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(dir).startsWith('suite-data-identity-'));fs.rmSync(dir,{recursive:true,force:true});};
const start=async(dir,options={})=>{const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false,computeEnabled:false,token:sharedToken,...options});const a=await app.listen();return {app,url:`http://127.0.0.1:${a.port}`};};
const json=async(url,options={})=>{const r=await fetch(url,options);return {status:r.status,value:await r.json()};};
const bootstrap=async s=>(await json(s.url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'libra'}})).value;
const identityPath=dir=>path.join(dir,'config','data-instance.json');

test('independent physical DATA roots using the same master token have distinct identities on health/bootstrap',async()=>{
 const a=fixture(),b=fixture();let x,y;
 try{x=await start(a);y=await start(b);const hx=(await json(x.url+'/health')).value,hy=(await json(y.url+'/health')).value;
  assert.notEqual(hx.dataInstanceId,hy.dataInstanceId,'transport credentials must not establish DATA identity');
  const bx=await bootstrap(x),by=await bootstrap(y);assert.equal(bx.dataInstanceId,hx.dataInstanceId);assert.equal(by.dataInstanceId,hy.dataInstanceId);
  assert.equal(bx.capabilities['data-instance-binding.v1'],true);assert.equal(hx.dataIdentityContract,'memory-suite.physical-data-identity.v1');
  assert.ok(!hx.dataInstanceId.includes(sharedToken.slice(0,8)));assert.ok(!JSON.stringify(hx).includes(a));
 }finally{await x?.app.close();await y?.app.close();removeFixture(a);removeFixture(b);}
});
test('restart and auth rotation keep identity and exact stored owner bytes; direct fresh SQLite readback',async()=>{
 const dir=fixture();let s;const marker={body:'RAW_IDENTITY_43\n\uD55C\uAD6D\uC5B4\u3068\u65E5\u672C\u8A9E',origin:'closed-owner-71'};
 try{s=await start(dir);const first=(await json(s.url+'/health')).value.dataInstanceId,boot=await bootstrap(s);
  const raw=JSON.stringify(marker);const set=await json(s.url+'/v1/kv/set',{method:'POST',headers:{Authorization:`Bearer ${boot.token}`,'X-Memory-Suite-Plugin':'libra','Content-Type':'application/json','X-Memory-Suite-Data-Instance':first},body:JSON.stringify({namespace:'libra',space:'plugin',key:'libra:v1:identity:retained',operationId:'identity_retained_001',value:raw,expectedRevision:0})});assert.equal(set.status,200);
  const identityBytes=fs.readFileSync(identityPath(dir));await s.app.close();s=null;
  const db=new DatabaseSync(path.join(dir,'stores','libra','libra.sqlite'),{readOnly:true});try{assert.equal(JSON.parse(db.prepare('SELECT value_json FROM kv WHERE key=? AND deleted=0').get('libra:v1:identity:retained').value_json),raw);}finally{db.close();}
  s=await start(dir,{token:crypto.randomBytes(36).toString('base64url')});assert.equal((await json(s.url+'/health')).value.dataInstanceId,first);assert.deepEqual(fs.readFileSync(identityPath(dir)),identityBytes);
  assert.equal((await bootstrap(s)).dataInstanceId,first);
 }finally{await s?.app.close();removeFixture(dir);}
});
test('a byte-identical copied DATA tree is a separate physical root; read-only launcher validation detects it',async()=>{
 const a=fixture(),b=fixture();let x,y;
 try{x=await start(a);const old=(await json(x.url+'/health')).value;await x.app.close();x=null;fs.cpSync(a,b,{recursive:true});
  x=await start(a);y=await start(b);const hx=(await json(x.url+'/health')).value,hy=(await json(y.url+'/health')).value;assert.equal(hx.dataInstanceId,old.dataInstanceId);assert.notEqual(hx.dataInstanceId,hy.dataInstanceId);
  const identityBytes=fs.readFileSync(identityPath(a));assert.equal(validateServerIdentity(hx,a).dataInstanceId,hx.dataInstanceId);assert.throws(()=>validateServerIdentity(hy,a),/server_data_instance_mismatch/);assert.deepEqual(fs.readFileSync(identityPath(a)),identityBytes);
 }finally{await x?.app.close();await y?.app.close();removeFixture(a);removeFixture(b);}
});
test('malformed existing identity is refused and preserved, never silently regenerated',async()=>{
 const dir=fixture();let created;try{fs.mkdirSync(path.dirname(identityPath(dir)),{recursive:true});const raw='{"schema":"broken","nonce":"RETAIN_CORRUPT_IDENTITY"}';fs.writeFileSync(identityPath(dir),raw);assert.throws(()=>{created=createMemorySuiteServer({dataDir:dir,computeEnabled:false,token:sharedToken});},/data_instance_identity_invalid/);assert.equal(fs.readFileSync(identityPath(dir),'utf8'),raw);}finally{await created?.close();removeFixture(dir);}
});
test('same DATA path and identical seed bytes still reject a replaced physical DATA directory',async()=>{
 const container=fixture(),dir=path.join(container,'DATA'),replacement=path.join(container,'replacement'),prior=path.join(container,'prior');let s;
 try{s=await start(dir);const first=(await json(s.url+'/health')).value.dataInstanceId,identityBytes=fs.readFileSync(identityPath(dir));await s.app.close();s=null;
  fs.cpSync(dir,replacement,{recursive:true});
  for(const target of [dir,replacement,prior])assert.ok(path.resolve(target).startsWith(path.resolve(container)+path.sep));
  fs.renameSync(dir,prior);fs.renameSync(replacement,dir);assert.deepEqual(fs.readFileSync(identityPath(dir)),identityBytes);
  s=await start(dir);assert.notEqual((await json(s.url+'/health')).value.dataInstanceId,first,'same token/path/portable seed cannot certify a replaced physical directory');
 }finally{await s?.app.close();removeFixture(container);}
});
test('same loopback URL after server replacement rejects a cached old DATA binding even with still-valid credentials',async()=>{
 const a=fixture(),b=fixture();let x,y;
 try{x=await start(a);const oldUrl=x.url,oldPort=Number(new URL(oldUrl).port),old=await bootstrap(x);await x.app.close();x=null;
  y=await start(b,{port:oldPort});assert.equal(y.url,oldUrl);const fresh=await bootstrap(y);assert.notEqual(fresh.dataInstanceId,old.dataInstanceId);
  const key='libra:v1:identity:late-old-backend';const r=await json(oldUrl+'/v1/kv/set',{method:'POST',headers:{Authorization:`Bearer ${old.token}`,'X-Memory-Suite-Plugin':'libra','Content-Type':'application/json','X-Memory-Suite-Data-Instance':old.dataInstanceId},body:JSON.stringify({namespace:'libra',space:'plugin',key,value:'DO_NOT_ADOPT_OLD_ROOT_72',expectedRevision:0,operationId:'identity_late_old_root_001'})});
  assert.equal(r.status,409);assert.equal(r.value.error,'data_instance_binding_changed');assert.equal(r.value.dataInstanceId,fresh.dataInstanceId);assert.equal(y.app.repositories.libra.database.prepare('SELECT COUNT(*) AS n FROM kv WHERE key=?').get(key).n,0);
 }finally{await x?.app.close();await y?.app.close();removeFixture(a);removeFixture(b);}
});
test('wrong root binding rejects a write before mutation, and correct binding publishes exact owner data',async()=>{
 const a=fixture(),b=fixture();let x,y;
 try{x=await start(a);y=await start(b);const bx=await bootstrap(x),by=await bootstrap(y),body={namespace:'libra',space:'plugin',key:'libra:v1:identity:bound-write',operationId:'identity_bound_write_001',expectedRevision:0,value:'ROOT_BOUND_RAW_9287'};
  const send=identity=>json(y.url+'/v1/kv/set',{method:'POST',headers:{Authorization:`Bearer ${by.token}`,'X-Memory-Suite-Plugin':'libra','Content-Type':'application/json','X-Memory-Suite-Data-Instance':identity},body:JSON.stringify(body)});
  const rejected=await send(bx.dataInstanceId);assert.equal(rejected.status,409);assert.equal(rejected.value.error,'data_instance_binding_changed');assert.equal(y.app.repositories.libra.database.prepare('SELECT COUNT(*) AS n FROM kv WHERE key=?').get(body.key).n,0);
  const accepted=await send(by.dataInstanceId);assert.equal(accepted.status,200);assert.equal(accepted.value.dataInstanceId,by.dataInstanceId);assert.equal(JSON.parse(y.app.repositories.libra.database.prepare('SELECT value_json FROM kv WHERE key=?').get(body.key).value_json),body.value);
 }finally{await x?.app.close();await y?.app.close();removeFixture(a);removeFixture(b);}
});
test('actual safe-mode health shares persisted identity and rejects wrong DATA binding',async()=>{
 const dir=fixture();let s,safe;try{s=await start(dir);const first=(await json(s.url+'/health')).value;await s.app.close();s=null;
  safe=createRecoverySafeModeServer({host:'127.0.0.1',port:0,dataDir:dir},new Error('fixture recovery gate'));const a=await safe.listen();const url=`http://127.0.0.1:${a.port}`;
  assert.equal((await json(url+'/health')).value.dataInstanceId,first.dataInstanceId);
  const wrong=await json(url+'/v1/admin/integrity',{headers:{'X-Memory-Suite-Data-Instance':'wrong-root-71'}});assert.equal(wrong.status,409);assert.equal(wrong.value.error,'data_instance_binding_changed');
 }finally{await s?.app.close();await safe?.close();removeFixture(dir);}
});
