'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const file='../src/wm-server-connection.source.js';
const M=fs.existsSync(require('node:path').join(__dirname,file))?require(file):{};
const C=require('../src/wm-storage-contracts.source.js');
const credential='mscap1.'+Buffer.from(JSON.stringify({schema:'memory-suite.capability-token.v1',pluginId:'libra_world_manager'})).toString('base64url')+'.'+ 'a'.repeat(43);
const clone=v=>JSON.parse(JSON.stringify(v));
const caps={schema:'wm.service-capabilities.v1',owner:'wm',protocol:C.PROTOCOL,backendId:'fake-wm-server',limits:{maxBodyBytes:524288,maxChunkBytes:262144,maxCanonicalBytes:1048576},storage:true,inventory:{chunkReads:true,put:'complete_payload_only',partialChunkUpload:false,migrationStaging:true},externalFenceVerification:false};
const status={schema:'wm.service-status.v1',available:true,initialized:false,closed:false};
function fixture(){
 assert.equal(typeof M.createWmServerConnection,'function','default connection controller must exist');
 const data=new Map(),calls=[],writes=[];let reply={capabilities:caps,'dataset/status':status};
 const storage={async getItem(k){return data.get(k)??null},async setItem(k,v){writes.push(k);data.set(k,v);return true}};
 const fetch=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({ok:true,result:reply[url.split('/v1/wm/')[1]]}),{status:200})};
 const controller=M.createWmServerConnection({storage,fetch});
 return {data,calls,writes,storage,fetch,controller,setReply:v=>reply=v};
}
test('saved connection bootstraps without any request and exposes no credential',async()=>{
 const f=fixture();await f.controller.saveConfiguration({baseUrl:'https://wm.example.test/',credential});
 assert.equal(f.calls.length,0);assert.deepEqual(f.writes,[M.STORAGE_KEY]);
 const reopened=M.createWmServerConnection({storage:f.storage,fetch:f.fetch});
 const view=await reopened.inspectConfiguration();assert.equal(view.baseUrl,'https://wm.example.test');assert.equal(view.credentialSaved,true);assert.equal(view.configured,true);assert(!JSON.stringify(view).includes(credential));
});
test('explicit check sends only WM authenticated GET metadata and leaves storage/data unchanged',async()=>{
 const f=fixture();await f.controller.saveConfiguration({baseUrl:'http://127.0.0.1:3210',credential});const before=JSON.stringify([...f.data]);
 const result=await f.controller.checkConnection();assert.equal(result.ok,true);assert.equal(result.backendId,caps.backendId);assert.equal(result.protocol,C.PROTOCOL);
 assert.deepEqual(f.calls.map(x=>x.url),['http://127.0.0.1:3210/v1/wm/capabilities','http://127.0.0.1:3210/v1/wm/dataset/status']);
 for(const x of f.calls){assert.equal(x.init.method,'GET');assert.equal(x.init.headers.Authorization,'Bearer '+credential);assert.equal(x.init.headers['X-Memory-Suite-Plugin'],'libra_world_manager');assert.equal(x.init.redirect,'error');assert.equal(x.init.credentials,'omit');assert.equal(x.init.body,undefined);}
 assert.equal(JSON.stringify([...f.data]),before);assert(!JSON.stringify(result).includes(credential));assert(!('createBackend' in f.controller));
});
test('unsafe destinations and foreign credentials fail before save or transport',async()=>{
 const f=fixture();for(const baseUrl of ['http://remote.example.test','https://user:pw@wm.example.test','https://wm.example.test/?key=x','https://wm.example.test/#x','file:///tmp/x','https://wm.example.test/path'])await assert.rejects(f.controller.saveConfiguration({baseUrl,credential}),/connection_url_invalid/);
 const foreign='mscap1.'+Buffer.from(JSON.stringify({schema:'memory-suite.capability-token.v1',pluginId:'libra'})).toString('base64url')+'.'+'a'.repeat(43);
 await assert.rejects(f.controller.saveConfiguration({baseUrl:'https://wm.example.test',credential:foreign}),/connection_credential_invalid/);
 assert.equal(f.writes.length,0);assert.equal(f.calls.length,0);
});
test('editing the endpoint cannot silently reuse a saved credential',async()=>{
 const f=fixture();await f.controller.saveConfiguration({baseUrl:'https://wm.example.test',credential});
 await f.controller.saveConfiguration({baseUrl:'https://other.example.test',credential:''});assert.equal((await f.controller.inspectConfiguration()).credentialSaved,false);
 await assert.rejects(f.controller.checkConnection(),/connection_configuration_required/);assert.equal(f.calls.length,0);
});
test('credential remains private on malformed replies, failed checks and forget',async()=>{
 const f=fixture();await f.controller.saveConfiguration({baseUrl:'https://wm.example.test',credential});
 f.setReply({capabilities:{...clone(caps),protocol:'wrong'},'dataset/status':status});
 await assert.rejects(f.controller.checkConnection(),/connection_response_invalid/);
 await f.controller.clearConfiguration();assert.equal((await f.controller.inspectConfiguration()).configured,false);assert(!JSON.stringify([...f.data]).includes(credential));
});
module.exports={credential,caps,status,fixture};
test('connection result limits expose only the documented metadata fields',async()=>{
 const f=fixture();await f.controller.saveConfiguration({baseUrl:'https://wm.example.test',credential});
 f.setReply({capabilities:{...clone(caps),limits:{...caps.limits,PRIVATE_RESPONSE_FIELD:1}},'dataset/status':status});
 const result=await f.controller.checkConnection();assert.deepEqual(result.limits,caps.limits);
});
test('readback failure and disposal cannot certify saved configuration or a connection',async()=>{
 const data=new Map();const c=M.createWmServerConnection({storage:{getItem:async()=>null,setItem:async(k,v)=>{data.set(k,v);return true}},fetch:async()=>{throw Error('not called')}});
 await assert.rejects(c.saveConfiguration({baseUrl:'https://wm.example.test',credential}),/connection_settings_unverified/);c.dispose();await assert.rejects(c.checkConnection(),/connection_disposed/);
});
test('clear during a pending configuration read prevents the old credential from being sent',async()=>{
 const f=fixture();await f.controller.saveConfiguration({baseUrl:'https://wm.example.test',credential});
 const original=f.storage.getItem;let started,release;const pending=new Promise(r=>started=r),held=new Promise(r=>release=r);let armed=true;
 f.storage.getItem=async key=>{const old=await original(key);if(armed){armed=false;started();await held;}return old;};
 const check=f.controller.checkConnection();await pending;await f.controller.clearConfiguration();release();
 await assert.rejects(check,/connection_configuration_changed/);assert.equal(f.calls.length,0);
});
test('oversized metadata is cancelled while streaming without an unbounded text read',async()=>{
 const f=fixture();let textReads=0,reads=0,cancelled=false;
 const c=M.createWmServerConnection({storage:f.storage,fetch:async()=>({ok:true,status:200,headers:{get:()=>null},text:async()=>{textReads++;return 'x'.repeat(200000)},body:{getReader:()=>({read:async()=>{reads++;return {done:false,value:new Uint8Array(65536)}},cancel:async()=>{cancelled=true},releaseLock(){}})}})});
 await c.saveConfiguration({baseUrl:'https://wm.example.test',credential});await assert.rejects(c.checkConnection(),/connection_response_invalid/);assert.equal(textReads,0);assert.equal(cancelled,true);assert.equal(reads,3);
});
test('nominal connection requires the documented capacity metadata',async()=>{
 const f=fixture();await f.controller.saveConfiguration({baseUrl:'https://wm.example.test',credential});f.setReply({capabilities:{...caps,limits:{unknown:1}},'dataset/status':status});await assert.rejects(f.controller.checkConnection(),/connection_response_invalid/);
});

test('explicit ordinary LIB bootstrap obtains WM-scoped authorization without startup issuance',async()=>{
 const store=new Map(),requests=[];const storage={getItem:async k=>store.get(k)??null,setItem:async(k,v)=>{store.set(k,v);return true;}};
 const credential='mscap1.'+Buffer.from(JSON.stringify({schema:'memory-suite.capability-token.v1',pluginId:'libra_world_manager'})).toString('base64url')+'.'+'a'.repeat(43);
 const connection=require(file).createWmServerConnection({storage,fetch:async(url,init)=>{requests.push({url,init});return {status:200,ok:true,data:JSON.stringify({ok:true,schema:'memory-suite.storage.bootstrap.v1',protocol:{major:1,minor:0},token:credential,dataInstanceId:'A'.repeat(32),dataIdentityContract:'memory-suite.physical-data-identity.v1',authorization:{schema:'memory-suite.bootstrap-authorization.v1',pluginId:'libra_world_manager',namespace:'wm',readNamespaces:['wm'],writeNamespaces:['wm']},capabilities:{'wm.storage.v1':true,'wm.inventory.v1':true}})};}});
 assert.equal(requests.length,0);assert.equal(typeof connection.connectUsingBootstrap,'function');await assert.rejects(connection.connectUsingBootstrap({baseUrl:'https://wm.example.test',confirmed:false}),/confirmation/);await connection.connectUsingBootstrap({baseUrl:'https://wm.example.test',confirmed:true});assert.equal(requests.length,1);assert.equal(requests[0].url,'https://wm.example.test/bootstrap');assert.equal(requests[0].init.headers['X-Memory-Suite-Plugin'],'libra_world_manager');assert.equal(requests[0].init.logFetch,false);assert.equal((await connection.inspectConfiguration()).credentialSaved,true);assert(!JSON.stringify(await connection.inspectConfiguration()).includes(credential));
});
test('physical transport remains drained after its outer timeout has already rejected',async()=>{const C=require('../src/wm-server-connection.source.js'),data=new Map(),c=C.createWmServerConnection({storage:{getItem:async k=>data.get(k)??null,setItem:async(k,v)=>{data.set(k,v);return true;}}});let settle;c.trackPhysical(new Promise(r=>{settle=r;}));let drained=false;const work=c.drain().then(()=>{drained=true;});await new Promise(r=>setTimeout(r,10));assert.equal(drained,false);settle();await work;assert.equal(drained,true);});
