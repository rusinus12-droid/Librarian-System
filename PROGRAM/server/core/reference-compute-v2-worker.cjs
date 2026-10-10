"use strict";
const { parentPort }=require("node:worker_threads");
const engine=require("./reference-compute-v2.cjs");
parentPort.on("message",async job=>{try{const result=await engine._worker.query(job.payload);parentPort.postMessage({id:job.id,ok:true,result});}catch(e){parentPort.postMessage({id:job.id,ok:false,error:{code:e?.code||"WORKER_QUERY_FAILED",message:e instanceof Error?e.message:String(e)}});}});
