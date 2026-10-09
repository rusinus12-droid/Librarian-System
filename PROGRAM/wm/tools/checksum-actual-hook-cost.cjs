'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
const {fixture,hook,plain}=require('./wm-native-cache-support.cjs'),instrument=require('./checksum-cost-instrument.cjs');
const {performance}=require('node:perf_hooks');
const root=path.resolve(__dirname,'..'),base=path.resolve(root,'../wm-native-cache-dispatch-repair-20261006T1221Z');
(async()=>{const results=[];
 for(const flavor of ['Full','Min'])for(const size of [12,64]){
  const rows=[];
  for(const artifact of [base,root]){
   const dist=artifact+'/dist/'+(flavor==='Full'?'LIBRA World Manager Full.js':'LIBRA World Manager.js'),f=await fixture({artifact:dist,transform:instrument});
   const record=f.r.signed({checksumBatchFixture:true,turnLog:Array.from({length:size},(_,i)=>({turn:i+1,worldSummary:'ACTUAL_PUBLIC_WORLD_'+i,currentLocation:'CITY',notes:['owned marker '+i]})),consolidated:[]},'world','world_state');
   const envelope=JSON.parse(f.raw);envelope.entries.push(f.r.entry('lmai_world_states','lmai_world_states::core',record));f.r.store.set(f.key,JSON.stringify(envelope));
   const count=f.r.context.__CHECKSUM_COST__;for(const key of Object.keys(count))count[key]=0;f.physical.length=0;
   const cpuStart=process.cpuUsage(),wallStart=performance.now();
   const output=plain(await hook(f));const wallMs=performance.now()-wallStart,cpu=process.cpuUsage(cpuStart),cpuMs=(cpu.user+cpu.system)/1000;
   const consumer=plain(f.r.context.__QUEUE_TEST__.rollout.inspect().last?.consumer);assert.equal(consumer?.ok,true);assert.match(JSON.stringify(output),/ACTUAL_PUBLIC_WORLD_/);assert.equal(f.r.state.calls.length,0);
   rows.push({artifact,counts:{...count},wallMs,cpuMs,output,physical:f.physical.map(({key,bytes})=>({kind:key===f.key?'root':'chunk',bytes})),consumer});
  }
  assert.deepEqual(rows[0].output,rows[1].output);assert.deepEqual(rows[0].physical,rows[1].physical);assert.ok(rows[1].counts.checksums<rows[0].counts.checksums,'whole actual beforeRequest checksum count must improve');assert.ok(rows[1].counts.markedParents<rows[0].counts.markedParents);assert.ok(rows[1].counts.decisions>=rows[0].counts.decisions,'checks cannot disappear');
  const result={flavor,size,rows};results.push(result);console.log('ACTUAL_HOOK_COST '+JSON.stringify({flavor,size,rows:rows.map(({output,physical,consumer,...r})=>({...r,physicalReads:physical.length,outputSha256:crypto.createHash('sha256').update(JSON.stringify(output)).digest('hex')}))}));
 }
 fs.writeFileSync(root+'/evidence/ACTUAL-HOOK-COST.json',JSON.stringify(results,null,2)+'\n');
})().catch(e=>{console.error(e);process.exitCode=1});
