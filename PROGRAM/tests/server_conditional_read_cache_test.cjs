'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMemorySuiteServer}=require('../server/server.cjs');
test('real HTTP conditional reads validate current revisions, missing keys, ABA and response budgets',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'conditional-read-'));
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false});
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const address=await app.listen(),url=`http://127.0.0.1:${address.port}`;
 const boot=await fetch(url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'libra'}}).then(r=>r.json());
 const call=async(method,route,body)=>{const r=await fetch(url+route,{method,headers:{Authorization:`Bearer ${boot.token}`,'X-Memory-Suite-Plugin':'libra','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,...await r.json()};};
 const keys=['libra:v1:scope:cache:micro-memory-head:main:e0:t1','libra:v1:scope:cache:lens:head','libra:v1:scope:cache:manifest','libra:v1:scope:cache:continuity-state'];
 const get=async key=>(await call('GET','/v1/kv/get?namespace=libra&space=plugin&key='+encodeURIComponent(key))).result;
 const pin=row=>({exists:row.exists,tombstone:row.tombstone,revision:row.revision,digest:row.digest});
 const put=async(key,value)=>{const r=await call('POST','/v1/kv/set',{namespace:'libra',space:'plugin',key,value,operationId:'test-'+crypto.randomUUID()});assert.equal(r.status,200,JSON.stringify(r));};
 const read=knownValues=>call('POST','/v1/kv/get-many',{namespace:'libra',space:'plugin',keys,knownValues,paged:true,maxResponseBytes:16384});
 const absent=Object.fromEntries(await Promise.all(keys.map(async key=>[key,pin(await get(key))])));
 const missing=await read(absent);for(const key of keys)assert.equal(missing.result.values[key].unchanged,true);
 for(const key of keys)await put(key,'large'.repeat(20000));
 const known=Object.fromEntries(await Promise.all(keys.map(async key=>[key,pin(await get(key))])));
 const same=await read(known);assert.equal(same.status,200);assert.equal(same.result.continuation.complete,true);
 for(const key of keys){assert.equal(same.result.values[key].unchanged,true);assert.ok(!Object.hasOwn(same.result.values[key],'value'));}
 assert.ok(Buffer.byteLength(JSON.stringify(same))<16384,'unchanged bodies do not exhaust the page budget');
 const key=keys[0],old=known[key];await put(key,'temporary');await put(key,'large'.repeat(20000));
 const aba=await read(known);assert.ok(aba.result.oversizedKeys.includes(key)
  || aba.result.values[key]?.revision>old.revision && aba.result.values[key]?.unchanged!==true && Object.hasOwn(aba.result.values[key],'value'),
  'same bytes with a new revision require a full observation, or the normal oversized-value fallback');
 assert.ok((await get(key)).revision>old.revision);
 const added=await read(absent);assert.ok(added.result.oversizedKeys.includes(key)
  || added.result.values[key]?.exists===true && added.result.values[key]?.unchanged!==true,'missing-to-present cannot reuse absence');
 const invalid=await read({[keys[0]]:{...known[keys[0]],revision:'1'}});assert.equal(invalid.status,400);
 const peer=await fetch(url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'flashback'}}).then(r=>r.json());
 const denied=await fetch(url+'/v1/kv/get-many',{method:'POST',headers:{Authorization:`Bearer ${peer.token}`,'X-Memory-Suite-Plugin':'flashback','Content-Type':'application/json'},
  body:JSON.stringify({namespace:'libra',space:'plugin',keys,knownValues:known})});assert.equal(denied.status,403,'conditional reads retain namespace authorization');
});
