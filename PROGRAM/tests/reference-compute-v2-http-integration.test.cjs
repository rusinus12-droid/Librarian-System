'use strict';
// 0.3.18 retires the unsafe route. This replaces its former unauthenticated-200
// expectation with real server/auth/owner-store non-disclosure assertions.
// All data is temporary; no external server, provider, or user DATA is used.
const assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path'), http=require('node:http'), crypto=require('node:crypto');
const createServerBefore=http.createServer;
const {createMemorySuiteServer}=require('../server/server.cjs');
assert.equal(http.createServer,createServerBefore,'loading server must not monkeypatch the HTTP router');
const ref=require('../server/core/reference-compute-v2.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'librarian-retired-reference-'));
const marker='retired_'+crypto.randomBytes(12).toString('hex');
(async()=>{
 const app=createMemorySuiteServer({dataDir:dir,port:0,autoBackup:false,computeEnabled:false});
 const addr=await app.listen(), base=`http://127.0.0.1:${addr.port}`; const cases=[];
 const request=async(route,body,headers={})=>{
  const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:r.status,data:await r.json()};
 };
 try {
  assert.equal(ref.disabled,true);assert.equal(await ref.tryHandle({url:'/v1/compute/reference-v2/query'},new Proxy({},{set(){throw Error('retired handler wrote response');}})),false);cases.push('retired module is inert; no response interception');
  const health=await request('/health');assert.equal(health.data.compute.enabled,false);cases.push('normal Compute disabled flag intact');
  const denied=await request('/v1/kv/get?namespace=hayaku&space=plugin&key='+encodeURIComponent(marker));assert.equal(denied.status,403);cases.push('normal KV remains authenticated');
  const auth={Authorization:`Bearer ${app.token}`,'X-Memory-Suite-Admin':'1'};
  // Seed an active owner: retired LIA writes are correctly refused with403.
  // Query/clear must preserve both private records regardless of route retirement.
  for(const suffix of ['','-other-scope']){
   const saved=await request('/v1/kv/set',{namespace:'hayaku',space:'plugin',key:marker+suffix,operationId:marker+suffix,value:{packet_schema_rev:2,id:'private'+suffix,summary:'non-disclosure fixture'},expectedRevision:0},auth);assert.equal(saved.status,200);
  }
  for(const credentials of [{},auth])for(const endpoint of ['query','clear','status']){
   const r=await request('/v1/compute/reference-v2/'+endpoint,endpoint==='status'?undefined:{kind:'hayaku',scopeId:marker,query:'non-disclosure fixture'},credentials);
   assert([403,404,410].includes(r.status),JSON.stringify(r));assert(!JSON.stringify(r.data).includes('non-disclosure fixture'));assert(!r.data.items);cases.push(`${endpoint}: ${Object.keys(credentials).length?'authenticated':'anonymous'} access denied`);
  }
  // Alternate legacy env token must not restore the retired route.
  process.env.LIBRARIAN_TOKEN=marker;
  const alternate=await request('/v1/compute/reference-v2/query',{kind:'hayaku',scopeId:marker,query:'non-disclosure fixture'},{Authorization:`Bearer ${marker}`});
  assert([403,404,410].includes(alternate.status));cases.push('alternate legacy token does not enable a bypass');
  for(const suffix of ['','-other-scope']){const r=await request('/v1/kv/get?namespace=hayaku&space=plugin&key='+encodeURIComponent(marker+suffix),undefined,auth);assert.equal(r.status,200);assert(JSON.stringify(r.data).includes('non-disclosure fixture'));}
  cases.push('owner data and other-scope data unchanged after retired clear/query');
  assert.equal(http.createServer,createServerBefore);cases.push('HTTP routing remains unmodified');
  console.log(JSON.stringify({test:'reference-compute-v2-http-integration',passed:cases.length,cases}));
 } finally {delete process.env.LIBRARIAN_TOKEN;await app.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
