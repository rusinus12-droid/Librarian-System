'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
let fake;
try { fake = require('fake-indexeddb'); }
catch (_) { fake = require('../build-support/node_modules/fake-indexeddb'); }
const createStore = require('../tools/libra_memory_graph_local_store.cjs');
const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');
const prefix = scope => 'libra:v1:scope:' + scope + ':memory-graph:v1:corpus:';
const rawRows = async (factory, name) => {
  const db = await new Promise((resolve,reject) => { const r=factory.open(name,1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error); });
  try { return await new Promise((resolve,reject) => { const r=db.transaction('records').objectStore('records').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error); }); }
  finally { db.close(); }
};
function setup(t) {
  const indexedDB = new fake.IDBFactory(), databaseName = crypto.randomUUID();
  let clock = Date.now();
  const options = {indexedDB,fingerprint:hash,databaseName,now:()=>clock};
  const a=createStore(options),b=createStore(options);
  t.after(async()=>{await a.close();await b.close();});
  return {a,b,indexedDB,databaseName,rows:()=>rawRows(indexedDB,databaseName),advance:n=>{clock+=n;},options};
}
const {publish}=require('./fixtures/libra_local_store_fixture.cjs');

test('six rebuilds reclaim superseded roots and their full transitive closure',async t=>{
  const x=setup(t);let count;
  for(let n=0;n<6;n++){
    const current=await publish(x.a,n);const gc=await x.a.collectGarbage('test');
    assert.equal(gc.status,'completed');assert.equal(gc.backend,'indexeddb');
    const rows=await x.rows();count??=rows.length;assert.equal(rows.length,count);
    for(const record of current.records)assert.ok(rows.some(row=>row.key===record.key&&row.raw===record.raw));
    if(n)assert.ok(gc.deletedKeys.length>=count);
  }
});
test('independent connections preserve pinned readers, including a replaced root key',async t=>{
  const x=setup(t),old=await publish(x.a,1,{root:'same'}),reader=await x.b.acquire('test','read');
  try {
    assert.equal(await reader.read(old.key),old.raw);
    const current=await publish(x.a,2,{root:'same',previous:old.raw});
    const gc=await x.a.collectGarbage('test');assert.equal(gc.protectedReaderCount,1);
    assert.equal(await reader.read(old.page.key),old.records.find(row=>row.key===old.page.key).raw);
    assert.ok((await x.rows()).some(row=>row.key===current.manifest.key));
  } finally {await reader.release();}
  const gc=await x.a.collectGarbage('test');assert.ok(gc.deletedKeys.includes(old.page.key));
});
test('active builds block reclamation; expired crashed builders cannot write or publish',async t=>{
  const x=setup(t),builder=await x.a.acquire('test','build'),key=prefix('test')+'page:orphan';
  try {
    await builder.putImmutable(key,'[]');
    assert.equal((await x.b.collectGarbage('test')).status,'blocked_active_builds');
    x.advance(60001);
    assert.ok((await x.b.collectGarbage('test')).deletedKeys.includes(key));
    await assert.rejects(builder.putImmutable(key,'[]'),/LEASE_EXPIRED/);
    await assert.rejects(builder.publish({key:prefix('test')+'root:r',raw:'{}',previous:null,manifestKey:key,manifestRaw:'[]'}),/LEASE_EXPIRED/);
  } finally {await builder.release();}
});
test('fresh store restores published records; read expiry prevents access after reclamation',async t=>{
  const x=setup(t),old=await publish(x.a,1),reader=await x.a.acquire('test','read');
  await reader.read(old.key);await publish(x.b,2);x.advance(60001);
  const gc=await x.b.collectGarbage('test');assert.ok(gc.deletedKeys.includes(old.page.key));
  await assert.rejects(reader.read(old.page.key),/LEASE_EXPIRED/);await reader.release();
  await x.a.close();const restarted=createStore(x.options);
  try{const r=await restarted.acquire('test','read');try{assert.ok(await r.read(prefix('test')+'root:r2'));}finally{await r.release();}}
  finally{await restarted.close();}
});
test('dry run, candidate restriction, checkpoints and other scopes preserve their records',async t=>{
  const x=setup(t),old=await publish(x.a,1);await publish(x.a,2);await publish(x.a,1,{scope:'other'});
  const builder=await x.a.acquire('test','build'),checkpoint=prefix('test')+'checkpoint:recent';
  await builder.putImmutable(checkpoint,'{}');await builder.release();
  const before=await x.rows(),dry=await x.a.collectGarbage('test',{dryRun:true,candidateKeys:[old.page.key]});
  assert.deepEqual(dry.candidateKeys,[old.page.key]);assert.deepEqual(await x.rows(),before);
  const gc=await x.a.collectGarbage('test',{candidateKeys:[old.page.key]});assert.deepEqual(gc.deletedKeys,[old.page.key]);
  assert.ok((await x.rows()).some(row=>row.key===checkpoint));
  x.advance(86400001);await x.a.collectGarbage('test');
  assert.ok(!(await x.rows()).some(row=>row.key===checkpoint));
  assert.ok((await x.rows()).some(row=>row.key.startsWith(prefix('other'))));
});
test('publication rejects dangling references, immutable conflicts, foreign keys and stale roots',async t=>{
  const x=setup(t),current=await publish(x.a,1),builder=await x.b.acquire('test','build');
  try{
    await assert.rejects(builder.putImmutable(current.page.key,'changed'),/IMMUTABLE_CONFLICT/);
    assert.throws(()=>builder.putImmutable(prefix('other')+'page:x','[]'),/KEY_UNOWNED/);
    const manifestRaw=JSON.stringify({schema:'libra.graph_corpus.v1',refs:[{key:prefix('test')+'page:missing',digest:hash('[]')}]}),digest=hash(manifestRaw),manifestKey=prefix('test')+'manifest:'+digest;
    await builder.putImmutable(manifestKey,manifestRaw);
    const input={key:current.key,raw:JSON.stringify({schema:'libra.graph_corpus.v1',manifestKey,digest}),manifestKey,manifestRaw};
    await assert.rejects(builder.publish({...input,previous:null}),/ROOT_CONFLICT/);
    await assert.rejects(builder.publish({...input,previous:current.raw}),/REFERENCE_MISSING/);
    assert.equal(await builder.read(current.key),current.raw);
  }finally{await builder.release();}
});
test('corrupt reachable metadata aborts the sweep without deleting orphan records',async t=>{
  const x=setup(t),current=await publish(x.a,1),orphan=prefix('test')+'page:orphan',builder=await x.a.acquire('test','build');
  await builder.putImmutable(orphan,'[]');await builder.release();
  const db=await x.a.ready();await new Promise((resolve,reject)=>{const tx=db.transaction('records','readwrite');tx.objectStore('records').put({scope:'test',key:current.manifest.key,raw:'{}',updatedAt:Date.now()});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  await assert.rejects(x.b.collectGarbage('test'),/REFERENCE_CORRUPT/);
  assert.ok((await x.rows()).some(row=>row.key===orphan));
});

test('scope discard revokes existing leases and cannot delete a prefix-shaped other scope',async t=>{
  const x=setup(t),a=await publish(x.a,1),other='test:memory-graph:v1:corpus:nested';
  const b=await publish(x.b,1,{scope:other}),reader=await x.a.acquire('test','read');
  await reader.read(a.key);await x.b.discardScope('test');
  await assert.rejects(reader.read(a.key),/LEASE_EXPIRED/);await reader.release();
  assert.ok(!(await x.rows()).some(row=>row.scope==='test'));
  assert.ok((await x.rows()).some(row=>row.scope===other&&row.key===b.key));
});

test('a mid-sweep transaction abort rolls back earlier scheduled deletions',async t=>{
  const x=setup(t);await publish(x.a,1);await publish(x.a,2);
  const before=await x.rows(),remove=fake.IDBObjectStore.prototype.delete;let count=0;
  fake.IDBObjectStore.prototype.delete=function(key){if(this.name==='records'&&++count===2)throw new Error('injected_disk_failure');return remove.call(this,key);};
  try{await assert.rejects(x.a.collectGarbage('test'),/injected_disk_failure/);}
  finally{fake.IDBObjectStore.prototype.delete=remove;}
  assert.deepEqual(await x.rows(),before);
});

test('shared retained-budget refusal aborts reclamation without storage mutation',async t=>{
  const x=setup(t);await publish(x.a,1);await publish(x.a,2);const before=await x.rows();
  const resources={check(){},reserveRetained(){throw new Error('LIBRA_GRAPH_RESOURCE_RETAINED_BYTE_BUDGET');}};
  await assert.rejects(x.a.collectGarbage('test',{resources}),/RETAINED_BYTE_BUDGET/);
  assert.deepEqual(await x.rows(),before);
});

test('expiration during publication validation cannot commit a late root',async t=>{
  const x=setup(t),current=await publish(x.a,1),builder=await x.b.acquire('test','build');
  const get=fake.IDBObjectStore.prototype.get;let armed=true;
  fake.IDBObjectStore.prototype.get=function(key){
    if(armed&&this.name==='records'&&Array.isArray(key)&&key[1]===current.key){armed=false;x.advance(60001);}
    return get.call(this,key);
  };
  try{
    await assert.rejects(builder.publish({key:current.key,raw:current.raw,previous:current.raw,
      manifestKey:current.manifest.key,manifestRaw:current.records.find(row=>row.key===current.manifest.key).raw}),/LEASE_EXPIRED/);
  }finally{fake.IDBObjectStore.prototype.get=get;await builder.release();}
  assert.equal((await x.rows()).find(row=>row.key===current.key).raw,current.raw);
});

test('release aborts an in-flight immutable write before native transaction commit',async t=>{
  const x=setup(t),builder=await x.a.acquire('test','build'),key=prefix('test')+'page:cancelled';
  const get=fake.IDBObjectStore.prototype.get;let revoked=null;
  fake.IDBObjectStore.prototype.get=function(input){
    if(this.name==='records'&&Array.isArray(input)&&input[1]===key&&!revoked)revoked=builder.release();
    return get.call(this,input);
  };
  try{await assert.rejects(builder.putImmutable(key,'[]'));await revoked;}
  finally{fake.IDBObjectStore.prototype.get=get;await builder.release();}
  assert.ok(!(await x.rows()).some(row=>row.key===key));
});

test('failed durable release stays fenced until expiration without masking cleanup errors',async t=>{
  const x=setup(t),builder=await x.a.acquire('test','build'),key=prefix('test')+'page:abandoned';
  await builder.putImmutable(key,'[]');const put=fake.IDBObjectStore.prototype.put;
  fake.IDBObjectStore.prototype.put=function(...args){if(this.name==='controls')throw new Error('injected_release_failure');return put.apply(this,args);};
  try{await builder.release();}finally{fake.IDBObjectStore.prototype.put=put;}
  await assert.rejects(builder.read(key),/LEASE_CLOSED/);
  assert.equal((await x.b.collectGarbage('test')).status,'blocked_active_builds');
  x.advance(60001);assert.ok((await x.b.collectGarbage('test')).deletedKeys.includes(key));
});
