'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const code=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuitePortableTransfer.source.js'),'utf8');
const ctx=vm.createContext({console,setTimeout,clearTimeout,Uint8Array,Uint32Array,DataView,ArrayBuffer,TextEncoder,AbortController,btoa,atob,crypto:null});vm.runInContext(code+'\nglobalThis.createClient=createMemorySuitePortableTransferClient',ctx);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{let checks=0;for(const length of [1,55,56,63,64,65,127,128,129,1024,262144,800123]){
 const bytes=crypto.randomBytes(length),calls=[],state={transferId:'test',transferToken:'secret',dataInstanceId:'A',status:'ready',kind:'export',totalBytes:length,chunkBytes:65536,sha256:sha(bytes)};
 const c=ctx.createClient({request:async(a,b)=>{calls.push(a);if(a==='download-chunk'){const part=bytes.subarray(b.offset,b.offset+65536);return {offset:b.offset,totalBytes:length,base64:part.toString('base64'),sha256:sha(part)};}if(a==='cancel')return {};throw Error(a);},pollMs:20});
 const chunks=[];let closed=false;const r=await c.download(state,{write:async b=>chunks.push(Buffer.from(b)),close:async()=>closed=true});assert.equal(r.clientSha256,sha(bytes));assert.deepEqual(Buffer.concat(chunks),bytes);assert.equal(closed,true);checks++;
 }
 // End-to-end client upload protocol uses File.slice; whole file arrayBuffer must never be called.
 const bytes=crypto.randomBytes(700001),received=[],cap={limits:{maxArchiveBytes:2000000,chunkBytes:65536},dataInstanceId:'A'},ref={transferId:'upload',transferToken:'secret',dataInstanceId:'A',kind:'upload',status:'receiving'};
 let maxSlice=0,finishHash='',cancelled=false;
 const c=ctx.createClient({request:async(a,b)=>{
 if(a==='capabilities')return cap;if(a==='upload-start')return ref;if(a==='upload-chunk'){const p=Buffer.from(b.base64,'base64');assert.equal(b.offset,received.reduce((n,p)=>n+p.length,0));assert.equal(b.sha256,sha(p));received.push(p);return {receivedBytes:b.offset+p.length,sha256:sha(p)};}
 if(a==='upload-finish'){finishHash=b.sha256;return {...ref,status:'inspecting'};}if(a==='status')return {...ref,status:'ready'};if(a==='cancel'){cancelled=true;return {};};throw Error(a);
 },pollMs:20});
 await c.upload({size:bytes.length,arrayBuffer:()=>{throw Error('whole-file read forbidden');},slice:(a,b)=>{maxSlice=Math.max(maxSlice,b-a);return {arrayBuffer:async()=>Uint8Array.from(bytes.subarray(a,b)).buffer};}});
 assert.equal(finishHash,sha(bytes));assert.deepEqual(Buffer.concat(received),bytes);assert.ok(maxSlice<=65536);checks++;
 // No disk publication of a bad whole-file digest even if chunk hashes match.
 let closed=false,aborted=false;const fail=ctx.createClient({request:async(a,b)=>a==='download-chunk'?{offset:0,totalBytes:3,base64:'YWJj',sha256:sha(Buffer.from('abc'))}:{}});
 await assert.rejects(()=>fail.download({status:'ready',kind:'export',totalBytes:3,chunkBytes:3,sha256:'0'.repeat(64)},{write:async()=>{},close:async()=>closed=true,abort:async()=>aborted=true}),/whole_digest/);assert.equal(closed,false);assert.equal(aborted,true);checks++;
 const controller=new AbortController();controller.abort();await assert.rejects(()=>c.upload({size:30,slice(){}},{signal:controller.signal}),/cancelled/);checks++;
 console.log(JSON.stringify({test:'portable_transfer_client_contract',checks,incrementalShaWithoutWebCrypto:true,boundedSlices:true}));
})().catch(e=>{console.error(e);process.exitCode=1;});
