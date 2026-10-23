'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const context=vm.createContext({setTimeout,clearTimeout,Uint8Array,Uint32Array,DataView,ArrayBuffer,AbortController,btoa,atob,crypto:null});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuitePortableTransfer.source.js'),'utf8')+'\nglobalThis.createClient=createMemorySuitePortableTransferClient',context);
const bytes=Buffer.from('synthetic portable backup'),hash=crypto.createHash('sha256').update(bytes).digest('hex');
const receipt={status:'ready',kind:'export',transferId:'synthetic',transferToken:'not-exported',totalBytes:bytes.length,chunkBytes:bytes.length,sha256:hash};
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:v=>resolve(v)};};
const within=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('finalization did not settle')),500);})]);}finally{clearTimeout(timer);}};
const client=extra=>context.createClient({fileOperationTimeoutMs:40,request:async action=>{
 if(action==='download-chunk')return {offset:0,totalBytes:bytes.length,base64:bytes.toString('base64'),sha256:hash};
 if(action==='cancel')return extra?.cancel?extra.cancel():{};
 throw Error(action);
}});
(async()=>{
 const cleanup=deferred();let saved=false;const phases=[];
 try{
  const result=await within(client({cancel:()=>cleanup.promise}).download(receipt,{write:async()=>{},close:async()=>{saved=true;}},{onProgress:p=>phases.push(p.phase)}));
  assert.equal(result.ok,true);assert.equal(saved,true);assert.equal(result.clientSha256,hash);
  for(const phase of ['download','verifying','saving','complete'])assert.ok(phases.includes(phase),phase+' is observable');
 }finally{cleanup.resolve({});}
 for(const stage of ['prepare','write','close']){
  const gate=deferred(),entered=deferred(),controller=new AbortController();let aborted=false;
  const sink={prepare:async()=>{},write:async()=>{},close:async()=>{},abort:async()=>{aborted=true;}};
  sink[stage]=async()=>{entered.resolve();await gate.promise;};
  const outcome=client().download(receipt,sink,{signal:controller.signal}).then(value=>({value}),error=>({error}));
  try{await entered.promise;controller.abort();const {error}=await within(outcome);assert.equal(error?.code,'PORTABLE_CANCELLED',stage);assert.equal(error.name,'AbortError');assert.equal(aborted,true);}
  finally{gate.resolve();await outcome;}
 }
 const never=deferred();let aborted=false;
 try{await assert.rejects(()=>within(client().download(receipt,{write:async()=>{},close:()=>never.promise,abort:async()=>{aborted=true;}})),/portable_file_save_timeout_check_downloads/);assert.equal(aborted,true);}
 finally{never.resolve();}
 for(const action of ['capabilities','export-start','status','download-chunk']){
  const gate=deferred(),entered=deferred(),controller=new AbortController(),cancelled=[];
  const c=context.createClient({pollMs:20,request:async name=>{
   if(name===action){entered.resolve();await gate.promise;}
   if(name==='capabilities')return {};
   if(name==='export-start'||name==='status')return receipt;
   if(name==='download-chunk')return {offset:0,totalBytes:bytes.length,base64:bytes.toString('base64'),sha256:hash};
   if(name==='cancel'){cancelled.push(true);return {};}
   throw Error(name);
  }});
  const run=action==='download-chunk'?c.download(receipt,{write:async()=>{},close:async()=>{}},{signal:controller.signal}):c.startExport({signal:controller.signal});
  const outcome=run.then(value=>({value}),error=>({error}));
  try{await entered.promise;controller.abort();assert.equal((await within(outcome)).error?.code,'PORTABLE_CANCELLED',action);}
  finally{gate.resolve();await outcome;await new Promise(r=>setTimeout(r,0));}
  if(action==='export-start')assert.equal(cancelled.length,1,'late export receipt is cleaned up after cancellation');
 }
 console.log('portable transfer finalization: PASS (nonblocking cleanup, explicit phases, cancellation during file operations, bounded save wait)');
})().catch(error=>{console.error(error);process.exitCode=1;});
