'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const transfer=require('./transfer.cjs');
let last=0;
const onProgress=p=>{if(Date.now()-last>150){last=Date.now();parentPort.postMessage({type:'progress',...p});}};
(async()=>{
 let result;
 if(workerData.action==='export')result=await transfer.exportStart({...workerData.params,onProgress});
 else if(workerData.action==='import')result=await transfer.importAuto({...workerData.params,onProgress});
 else throw Error('portable_worker_action_invalid');
 parentPort.postMessage({type:'result',result});
})().catch(e=>{parentPort.postMessage({type:'error',code:String(e?.message||'portable_worker_failed').slice(0,240),statusCode:Number(e?.statusCode)||422});process.exitCode=1;});
