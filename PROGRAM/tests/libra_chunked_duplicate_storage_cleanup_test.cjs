'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const variant=variants.find(row=>row[0]==='libra'),size=512*1024,key='libra.A';
const payload=JSON.stringify({text:'기억'.repeat(size/2+20)});
async function chunkedFixture(){
 const f=await fixture(variant);
 f.values.set(key,payload);await f.bridge.setGlobalMode('server_only');
 const chunks=[];
 for(let offset=0;offset<payload.length;offset+=size){const chunk=key+'::chunk:v1:review:'+String(chunks.length).padStart(4,'0');chunks.push(chunk);f.values.set(chunk,payload.slice(offset,offset+size));}
 const manifest={__libraChunkedStorageV1:true,schemaVersion:1,key,length:payload.length,chunks};
 f.values.set(key,JSON.stringify(manifest));
 // Reproduce LIBRA re-registering the raw host adapter after migration.
 f.bridge.createPluginStorageProxy(f.store);
 const serverDump=()=>JSON.stringify(f.app.repositories.libra.database.prepare('SELECT space,key,value_json,digest,revision,deleted FROM kv ORDER BY space,key').all());
 return{...f,chunks,manifest,serverDump};
}
test('LIBRA duplicate cleanup compares the hydrated chunk body and only removes local copies',async()=>{
 const f=await chunkedFixture();try{
  assert.equal((await f.bridge.serverGet('plugin',key)).value,payload);
  const before=f.serverDump(),verified=await f.bridge.globalVerifyPreservation();
  assert.equal(verified.ok,true);assert.equal(verified.checked,2);
  const result=await f.bridge.globalDeletePluginStorageAfterVerification();
  assert.equal(result.ok,true);assert.equal(result.deleted,2+f.chunks.length);
  for(const localKey of [key,...f.chunks,'libra.B'])assert.equal(f.values.has(localKey),false);
  assert.equal(f.serverDump(),before,'cleanup leaves server records unchanged');
 }finally{await f.close();}
});
for(const fault of ['missing','truncated','different','foreign_chunk','root_changed'])test(`LIBRA rejects ${fault} chunks without deleting data`,async()=>{
 const f=await chunkedFixture();try{
  if(fault==='missing')f.values.delete(f.chunks[0]);
  if(fault==='truncated')f.values.set(f.chunks[0],f.values.get(f.chunks[0]).slice(1));
  if(fault==='different')f.values.set(f.chunks[0],'X'+f.values.get(f.chunks[0]).slice(1));
  if(fault==='foreign_chunk'){f.values.set('unrelated',f.values.get(f.chunks[0]));f.manifest.chunks[0]='unrelated';f.values.set(key,JSON.stringify(f.manifest));}
  if(fault==='root_changed'){const get=f.store.getItem;f.store.getItem=async k=>{const value=await get(k);if(k===f.chunks.at(-1))f.values.set(key,payload);return value;};}
  const before=f.serverDump(),writes=f.writes.length;
  await assert.rejects(f.bridge.globalDeletePluginStorageAfterVerification(),e=>e.code==='MEMORY_SUITE_GLOBAL_PRESERVATION_FAILED');
  assert.equal(f.values.has(key),true);assert.equal(f.values.has('libra.B'),true);assert.equal(f.writes.length,writes,'failed verification does not delete any root or chunk');
  assert.equal(f.serverDump(),before);
 }finally{await f.close();}
});
test('LIBRA rechecks chunk contents after verification before deleting a duplicate',async()=>{
 const f=await chunkedFixture();try{
  const before=f.serverDump();
  await assert.rejects(f.bridge.globalDeletePluginStorageAfterVerification({beforeDelete:async()=>{f.values.set(f.chunks[0],'X'+f.values.get(f.chunks[0]).slice(1));}}));
  assert.equal(f.values.has(key),true);for(const chunk of f.chunks)assert.equal(f.values.has(chunk),true);
  assert.equal(f.serverDump(),before);
 }finally{await f.close();}
});
