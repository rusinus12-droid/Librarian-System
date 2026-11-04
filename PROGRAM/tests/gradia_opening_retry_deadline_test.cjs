'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('opening reacquisition shares the first attempt deadline and aborts its transport',async()=>{
 const source=fs.readFileSync(require.resolve('../plugins/GRADIA.js'),'utf8');
 const start=source.indexOf('  const openResponseLibEvidenceRun ='),end=source.indexOf('  let inputWriterDialogCancel =',start);
 assert.ok(start>0&&end>start);
 let now=0,serial=0,calls=0,secondSignal,ready;const entered=new Promise(resolve=>ready=resolve),timers=new Map(),delays=[];
 const context={Date:{now:()=>now},AbortController,Runtime:{settings:{}},LIB_MEMORY_OWNER_READ_TIMEOUT_MS:110000,
  requestSettingsSignature:JSON.stringify,libReadFailureDetails:()=>({}),libEvidenceError:code=>Object.assign(Error(code),{code}),
  LibReadConnection:{status:()=>({state:'connected'})},
  setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:now+ms});delays.push(ms);return id;},clearTimeout:id=>timers.delete(id),
  openLibEvidenceRun:async(_m,_s,_r,_id,_native,controller)=>{
   if(++calls===1){now=90000;throw Object.assign(Error('LIB_READ_UNIFIED_UNAVAILABLE'),{code:'LIB_READ_UNIFIED_UNAVAILABLE'});}
   secondSignal=controller.signal;ready();return await new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Object.assign(Error('LIB_READ_CANCELED'),{code:'LIB_READ_CANCELED'})),{once:true}));
  }};
 const open=vm.runInNewContext(source.slice(start,end)+';openResponseLibEvidenceRun',context);
 const pending=open([],{},{},'deadline',{assertCurrent:async()=>true}),rejection=assert.rejects(pending,error=>error.code==='LIB_READ_TIMEOUT');
 await entered;assert.equal(calls,2);assert.equal(secondSignal.aborted,false);assert.equal(delays.at(-1),20000);
 now=110001;for(const [id,timer]of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}
 await rejection;assert.equal(secondSignal.aborted,true);assert.equal(calls,2);assert.equal(context.Runtime.lastLibReadDiagnostic.code,'LIB_READ_TIMEOUT');
 assert.equal(timers.size,0);
});
