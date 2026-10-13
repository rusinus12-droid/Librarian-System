'use strict';
const assert=require('node:assert/strict');
const {performance,monitorEventLoopDelay}=require('node:perf_hooks');
const create=require('../tools/libra_memory_network.cjs');
const {seedSnapshot,finalProofFixture,REQUEST}=require('./fixtures/libra_associative_final_proof_fixture.cjs');
const {traceSource}=require('./helpers/libra_network_cost_trace.cjs');
const plain=x=>JSON.parse(JSON.stringify(x));
const deliveredIds=f=>f.r.api.getLastMemoryRecallViewer().rows.filter(row=>row.injected).map(row=>({memoryId:row.memoryId,revision:row.revision}));
const diff=(a,b)=>Object.fromEntries(Object.keys(b).filter(k=>typeof b[k]==='number').map(k=>[k,b[k]-(a[k]||0)]));
const p95=xs=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*.95)-1];
// These are diagnostic stop controls, never product corpus/resource limits.
const args=process.argv.slice(2),allowed=new Set(['--factory-only','--runtime-only','--skip-scaled']);
if(args.some(arg=>!allowed.has(arg)&&!/^--sizes=\d+(,\d+)*$/.test(arg)))throw new Error('Use --factory-only, --runtime-only, --skip-scaled, --sizes=100,1000. No 100k run is authorized.');
if(args.filter(arg=>arg.startsWith('--sizes=')).length>1)throw new Error('Specify --sizes once');
if(args.includes('--factory-only')&&(args.includes('--runtime-only')||args.includes('--skip-scaled')))throw new Error('Choose one probe mode');
if(args.includes('--runtime-only')&&args.includes('--skip-scaled'))throw new Error('Choose one probe mode');
const sizes=(args.find(arg=>arg.startsWith('--sizes='))?.slice(8)||'100').split(',').map(Number);
if(sizes.some(n=>!Number.isSafeInteger(n)||n<1||n>10000))throw new Error('Diagnostic sizes must be explicit integers from 1 to 10000; default is 100');
const memory=()=>{const {heapUsed,rss,external,arrayBuffers}=process.memoryUsage();return {heapUsed,rss,external,arrayBuffers};};
const HEAP_STOP=1024**3,RSS_STOP=2*1024**3;
let cancelled=null;
const checkpoint=()=>{if(cancelled)throw new Error(`diagnostic_cancelled:${cancelled}`);const use=memory();if(use.heapUsed>=HEAP_STOP||use.rss>=RSS_STOP)throw new Error('diagnostic_memory_stop');};
const stage=(phase,n=null)=>{console.log(JSON.stringify({diagnosticStage:phase,n,...memory()}));checkpoint();};
process.once('SIGINT',()=>{cancelled='SIGINT';});process.once('SIGTERM',()=>{cancelled='SIGTERM';});
// A timer can stop async fixture construction/requests even before the next stage.
// Synchronous work is additionally bounded by explicit small sizes/checkpoints.
const watch=setInterval(()=>{try{checkpoint();}catch(error){console.error(JSON.stringify({diagnosticStop:error.message,...memory()}));process.exit(cancelled==='SIGINT'?130:cancelled==='SIGTERM'?143:2);}},100);
watch.unref();
console.log(JSON.stringify({diagnosticConfig:{sizes,heapStop:HEAP_STOP,rssStop:RSS_STOP,scope:'experiment_only'}}));
async function hookProbe(){
 stage('before_seed');const snapshot=await seedSnapshot();stage('after_seed');const f=await finalProofFixture(snapshot,false,{transformSource:source=>traceSource(source).replace('const recall = async (context, queryInput, guard = null) => {', 'globalThis.__a2Signature=recallCatalogSignature;\n const recall = async (context, queryInput, guard = null) => {').replace('const recallCatalog = { ...canonicalCatalog,','globalThis.__a2Catalog=canonicalCatalog;\n const recallCatalog = { ...canonicalCatalog,')});
 try{
  stage('baseline_fixture_ready');const input=()=>[{role:'user',content:REQUEST}],samples=[],requests=[];
  const before=plain(f.r.context.__libraA2Trace);
  stage('baseline_before_cold');await f.control.hooks.beforeRequest(input(),'model');stage('baseline_after_cold');
  const cold=diff(before,plain(f.r.context.__libraA2Trace));
  const warmBefore=plain(f.r.context.__libraA2Trace),reads=f.r.storageReads.length,cpu=process.cpuUsage();
  for(let i=0;i<5;i++){
   stage('baseline_before_warm',i);const trace=plain(f.r.context.__libraA2Trace),readStart=f.r.storageReads.length,requestCPU=process.cpuUsage();
   const t=performance.now();await f.control.hooks.beforeRequest(input(),'model');const wallMs=performance.now()-t;samples.push(wallMs);
   requests.push({request:i,hook:'registered.beforeRequest',wallMs,cpuMicros:process.cpuUsage(requestCPU),trace:diff(trace,plain(f.r.context.__libraA2Trace)),ownerStorageReads:f.r.storageReads.length-readStart,deliveredIds:deliveredIds(f)});
   stage('baseline_after_warm',i);
  }
  const warm=diff(warmBefore,plain(f.r.context.__libraA2Trace));
  const result={mode:'plugin_only',catalogN:10,cold,warmRequests:5,warm,requests,ownerStorageReads:f.r.storageReads.length-reads,
   wallMs:samples,p95Ms:p95(samples),cpuMicros:process.cpuUsage(cpu),documentEmbeddingCalls:f.counts.document,
   delivered:f.r.api.getLastMemoryRecallViewer().injectedMemories};
  console.log(JSON.stringify({actualBeforeRequest:result}));
  if(process.env.LIBRA_A2_BASELINE==='1')return;
  assert.equal(typeof f.r.api.inspectMemoryNetwork,'function','A2 real runtime must expose measured cost diagnostics');
  const inspection=f.r.api.inspectMemoryNetwork({});
  assert.equal(inspection.io.signatureRefs,f.r.context.__libraA2Trace.signatureRefs);
  assert.equal(inspection.io.rawHistoryRowsValidated,f.r.context.__libraA2Trace.rawHistoryRows);
  assert.equal(inspection.io.catalogMetadataReconstructions,f.r.context.__libraA2Trace.catalogReconstructions);
  assert.ok(inspection.io.fallbacks>0);
  assert.equal(inspection.coverage.candidateDiscovery,'unchanged_A1');
  assert.ok(warm.signatureRefs>0,'fallback full signatures must be reported');
  assert.ok(warm.rawHistoryRows>0,'inherited exact raw readset checks must not be called zero');
  assert.equal(warm.catalogReconstructions,0,'unchanged catalog must not serially rebuild corpus');
  assert.equal(result.documentEmbeddingCalls,0);
  assert.ok(result.delivered>0);
  console.log(JSON.stringify({inspection}));
  return {snapshot:{chat:plain(f.chat),values:[...f.r.values]},catalog:plain(f.r.context.__a2Catalog)};
 }finally{await f.r.cleanup();}
}

async function runtimeScaleProbe(seed){
 const {snapshot,catalog}=seed;
 for(const n of sizes){
  stage('runtime_before_manifest',n);
  const backendValues=new Map(snapshot.values),manifestKey=[...backendValues.keys()].find(k=>k.endsWith(':manifest'));
  const manifest=JSON.parse(backendValues.get(manifestKey)),originalRef=Object.values(manifest.memories)[0],template=JSON.parse(backendValues.get(originalRef.key));
  manifest.memories={};const entries=[];
  for(let i=0;i<n;i++){
   if(i%64===0)checkpoint();
   const key=`${originalRef.key}:a2-synthetic:${i}`,id=`a2_${i}`;
   manifest.memories[String(i+1)]={...originalRef,key,memoryId:id,summary:'예전 은빛 열쇠',turnRange:{...originalRef.turnRange}};
   entries.push({...catalog.entries[0],memoryKey:key,memoryId:id,searchText:`예전 은빛 열쇠 term${i}`,summary:'예전 은빛 열쇠'});
  }
  backendValues.set(manifestKey,JSON.stringify(manifest));
  let reads=0,readBytes=0;
  const backend={async getItem(key){if(reads%64===0)checkpoint();reads++;let value=backendValues.get(key)||null;const m=/:a2-synthetic:(\d+)$/.exec(key);if(m)value=JSON.stringify({...template,memoryId:`a2_${m[1]}`});if(typeof value==='string')readBytes+=Buffer.byteLength(value);return value;},async setItem(key,value){backendValues.set(key,value);return true;},async removeItem(key){backendValues.delete(key);return true;},async keys(){return [...backendValues.keys()];}};
  stage('runtime_before_fixture',n);
  const f=await finalProofFixture({chat:snapshot.chat,values:[...backendValues]},false,{host:{pluginStorage:backend,safeLocalStorage:backend,getLocalPluginStorage:async()=>backend},transformSource:source=>traceSource(source).replace('const recall = async (context, queryInput, guard = null) => {','globalThis.__a2Signature=recallCatalogSignature;\n const recall = async (context, queryInput, guard = null) => {')});
  try{
   // Seed explicit fixed synthetic metadata, not raw history, with the exact
   // runtime signature. Cold restore cost and warm requests are separate.
   const signature=f.r.context.__a2Signature(manifest);
   backendValues.set(manifestKey.replace(/:manifest$/,':recall-catalog:v1'),JSON.stringify({...catalog,signature,entries,complete:true}));
   const input=()=>[{role:'user',content:REQUEST}];
   stage('runtime_before_cold_hook',n);
   const coldStart=performance.now();await f.control.hooks.beforeRequest(input(),'model');const coldMs=performance.now()-coldStart;stage('runtime_after_cold_hook',n);
   const cold=plain(f.r.api.inspectMemoryNetwork({})),traceBefore=plain(f.r.context.__libraA2Trace),readBefore=reads,bytesBefore=readBytes,cpu=process.cpuUsage(),samples=[],requests=[];
   const delay=monitorEventLoopDelay({resolution:10});delay.enable();await new Promise(r=>setTimeout(r,20));
   for(let repeat=0;repeat<3;repeat++){
    stage('runtime_before_warm_hook',n);const prior=plain(f.r.api.inspectMemoryNetwork({})),priorTrace=plain(f.r.context.__libraA2Trace),priorReads=reads,priorBytes=readBytes,requestCPU=process.cpuUsage();
    const t=performance.now();await f.control.hooks.beforeRequest(input(),'model');const wallMs=performance.now()-t;samples.push(wallMs);
    const after=plain(f.r.api.inspectMemoryNetwork({}));
    requests.push({request:repeat,hook:'registered.beforeRequest',wallMs,cpuMicros:process.cpuUsage(requestCPU),trace:diff(priorTrace,plain(f.r.context.__libraA2Trace)),io:diff(prior.io,after.io),indexIO:diff(prior.io.index,after.io.index),coverage:after.coverage,ownerStorageReads:reads-priorReads,ownerStorageBytes:readBytes-priorBytes,deliveredIds:deliveredIds(f)});
    stage('runtime_after_warm_hook',n);await new Promise(r=>setTimeout(r,0));
   }
   delay.disable();const warm=plain(f.r.api.inspectMemoryNetwork({})),trace=diff(traceBefore,plain(f.r.context.__libraA2Trace));
   assert.equal(warm.coverage.indexed,n,'all synthetic catalog rows must remain in derived postings');
   assert.equal(warm.io.index.metadataRows,cold.io.index.metadataRows);
   assert.equal(trace.catalogReconstructions,0);
   assert.equal(f.counts.document,0);
   assert.ok(f.r.api.getLastMemoryRecallViewer().injectedMemories>0,'actual scaled registered hook must emit validated canonical sources');
   console.log(JSON.stringify({actualScaledBeforeRequest:{mode:'plugin_only',n,rawChatRows:100,coldMs,warmRequests:3,requests,wallMs:samples,p95Ms:p95(samples),cpuMicros:process.cpuUsage(cpu),eventLoopDelayMs:{max:delay.max/1e6,p95:delay.percentile(95)/1e6},trace,io:diff(cold.io,warm.io),indexIO:diff(cold.io.index,warm.io.index),ownerStorageReads:reads-readBefore,ownerStorageBytes:readBytes-bytesBefore,retainedBytes:warm.bytes,delivered:f.r.api.getLastMemoryRecallViewer().injectedMemories}}));
  }finally{await f.r.cleanup();stage('runtime_after_cleanup',n);}
 }
}

async function syntheticProbe(){
 for(const n of sizes){
  stage('factory_before_rows',n);
  const d=256,frame={owner:'synthetic-owner',scopeKey:`n${n}`,worldlineId:'main',asOf:null,authorityEpoch:1,activeSourceMapping:'1'};
  const index=create({hash:s=>s.length}).createPagedIndex({pageSize:256});
  const rows=Array.from({length:n},(_,i)=>({id:`id${i}`,fingerprint:`v1:${i}`,postings:{token:[`term${i}`,'common']},dependencies:[`source${i}`],vector:Array.from({length:d},(_,k)=>((i+k)%17)/17)}));
  stage('factory_before_reconcile',n);const cpuCold=process.cpuUsage(),t=performance.now();index.reconcile({frame,revision:1,items:rows});const coldMs=performance.now()-t,coldCpu=process.cpuUsage(cpuCold),cold=index.inspect();stage('factory_after_reconcile',n);
  const samples=[],cpu=process.cpuUsage(),delay=monitorEventLoopDelay({resolution:10});delay.enable();await new Promise(r=>setTimeout(r,20));
  let scan;
  for(let repeat=0;repeat<7;repeat++){checkpoint();const t=performance.now();index.reconcile({frame,revision:1,trustedRevision:true});scan=index.scanDense(new Float64Array(d).fill(.5));samples.push(performance.now()-t);await new Promise(r=>setTimeout(r,0));}
  await new Promise(r=>setTimeout(r,20));delay.disable();const warm=index.inspect(),warmCpu=process.cpuUsage(cpu);
  assert.equal(scan.vectorsScanned,n);assert.equal(scan.dotTerms,n*d);assert.equal(warm.io.metadataRows,cold.io.metadataRows);
  let cursor,ids=[];do{const page=index.query({tokens:Array.from({length:Math.min(n,180)},(_,i)=>`term${i}`),cursor});ids.push(...page.ids);cursor=page.cursor;}while(cursor);
  assert.equal(ids.length,Math.min(n,180));assert.equal(ids[0],'id0');
  stage('factory_before_fallback',n);const tFallback=performance.now();index.reconcile({frame,revision:1,items:rows});const fallbackMs=performance.now()-tFallback;
  console.log(JSON.stringify({syntheticPackedAccess:{n,d,coldMs,coldCpu,bytes:warm.bytes,warmMs:samples,p95Ms:p95(samples),cpuMicros:warmCpu,eventLoopDelayMs:{max:delay.max/1e6,p95:delay.percentile(95)/1e6},scan,trustedWarmMetadataRows:warm.io.metadataRows-cold.io.metadataRows,fallbackMs,fallbackRefComparisons:index.inspect().io.refComparisons-cold.io.refComparisons,...memory()}}));
 }
}
(async()=>{stage('start');if(args.includes('--factory-only')){await syntheticProbe();}else{const seed=await hookProbe();if(process.env.LIBRA_A2_BASELINE!=='1'){if(!args.includes('--skip-scaled'))await runtimeScaleProbe(seed);if(!args.includes('--runtime-only'))await syntheticProbe();}}stage('done');console.log('libra_network_search_cost_probe: PASS (small synthetic cost evidence; no final envelope target)');})().catch(e=>{console.error(JSON.stringify({diagnosticStop:e.message,...memory()}));console.error(e.stack);process.exitCode=e.message.startsWith('diagnostic_')?2:1;}).finally(()=>clearInterval(watch));
