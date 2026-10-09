'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{test}=require('node:test'),f=require('./fixtures/server_repair_fixture.cjs');
const factory=require('../server/core/flashback-server-repair.cjs'),base={scopeKey:f.scope,dataInstanceId:'A'.repeat(32),epoch:0,mode:'server_only',authorityDigest:'b'.repeat(64)};
const big='X'.repeat(2*1024**2+1),operationId='ordinary_operation_000001',journal=f.prefix+'server_physical_repair:v2:'+operationId,head=f.prefix+'server_physical_repair:v2';
const put=(repo,space,key,value,deleted=0,revision=1)=>repo.database.prepare('INSERT OR REPLACE INTO kv(space,key,value_json,deleted,revision,digest,updated_at) VALUES(?,?,?,?,?,?,?)').run(space,key,deleted?null:JSON.stringify(value),deleted,revision,f.digest(value),0);
async function fixture(fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'repair-v4-metadata-')),x=f.open(dir);try{const api=factory({getRepository:()=>x.repo,dataInstanceId:base.dataInstanceId,epochs:()=>({flashback:0}),canWrite:()=>true});await fn({...x,dir,call:(a,b)=>api(f.owner,a,{...base,...b})});}finally{await x.app.close();}}
for(const kind of ['journal','head'])test('exact '+kind+' cap ignores earlier case variants and prefix neighbours',()=>fixture(x=>{
 const key=kind==='journal'?journal:head,earlier=kind==='journal'?f.prefix+'server_physical_repair:v2:Ordinary_operation_000001':f.prefix+'SERVER_physical_repair:v2';
 put(x.repo,'plugin',earlier,{});put(x.repo,'plugin',key,big);put(x.repo,'plugin',key+'.suffix',{});
 if(kind==='head')put(x.repo,'plugin',journal,{schema:'flashback.server-vector-repair.v2',operationId,binding:base,state:'reserved',stageInputs:{}});
 let gets=0;const get=x.repo.get;x.repo.get=(space,k,...rest)=>{if(k===key)gets++;return get(space,k,...rest)};
 assert.throws(()=>x.call(kind==='journal'?'status':'submitted',{operationId,...(kind==='head'?{requestId:'ordinary_request_000001'}:{})}),/REPAIR_VALUE_LIMIT/);assert.equal(gets,0,'exact oversized value must be refused before get');
}));
test('metadata is exact binary-key, space/namespace isolated, payload-free and survives reopen',()=>fixture(async x=>{
 assert.equal(typeof x.repo.getMetadata,'function','exact metadata API is required');
 const key="metadata:_percent%_quote'",upper="METADATA:_percent%_quote'";put(x.repo,'plugin',key,{sentinel:'PRIVATE_VALUE',n:1});put(x.repo,'plugin',upper,'different');put(x.repo,'local',key,'local');put(x.app.repositories.libra,'plugin',key,'libra');put(x.repo,'plugin',key+'.child','child');put(x.repo,'plugin','metadata:tomb',null,1,4);
 const m=x.repo.getMetadata('plugin',key);assert.equal(m.key,key);assert.equal(m.namespace,'flashback');assert.equal(m.space,'plugin');assert.equal(m.valueBytes,Buffer.byteLength(JSON.stringify({sentinel:'PRIVATE_VALUE',n:1})));assert.equal(m.digest,f.digest({sentinel:'PRIVATE_VALUE',n:1}));assert.equal(m.exists,true);assert.equal(m.revision,1);assert(!JSON.stringify(m).includes('PRIVATE_VALUE'));assert(!Object.hasOwn(m,'value'));assert(!Object.hasOwn(m,'value_json'));
 assert.notEqual(x.repo.getMetadata('plugin',upper).digest,m.digest);assert.equal(x.repo.getMetadata('local',key).digest,f.digest('local'));assert.equal(x.app.repositories.libra.getMetadata('plugin',key).namespace,'libra');assert.equal(x.app.repositories.libra.getMetadata('plugin',key).digest,f.digest('libra'));assert.equal(x.repo.getMetadata('plugin','metadata:missing').revision,0);assert.equal(x.repo.getMetadata('plugin','metadata:missing').valueBytes,0);assert.equal(x.repo.getMetadata('plugin','metadata:tomb').tombstone,true);assert.equal(x.repo.getMetadata('plugin','metadata:tomb').revision,4);
 await x.app.close();const fresh=f.open(x.dir);try{assert.deepEqual(fresh.repo.getMetadata('plugin',key),m);}finally{await fresh.app.close();}
}));
test('growth after exact metadata read is still blocked by the single-SELECT decoder bound',()=>fixture(x=>{
 put(x.repo,'plugin',journal,{});const get=x.repo.get,bigJson=JSON.stringify(big),parse=JSON.parse;let parsedLarge=0;
 x.repo.get=(space,key,...opts)=>{if(key===journal)put(x.repo,'plugin',key,big);return get(space,key,...opts)};JSON.parse=function(v,...args){if(v===bigJson)parsedLarge++;return parse(v,...args)};
 try{assert.throws(()=>x.call('status',{operationId}),/REPAIR_VALUE_LIMIT/);assert.equal(parsedLarge,0);}finally{JSON.parse=parse;}
}));
