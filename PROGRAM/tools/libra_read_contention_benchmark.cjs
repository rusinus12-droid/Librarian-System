'use strict';
// Manual benchmark, not a test-suite gate. Built-ins + repository product fixtures.
// node PROGRAM/tools/libra_read_contention_benchmark.cjs --commits=cd78b9f,75b0859
// Optional: --arms=idle,contention --output=contention8-repeat-results.json
// Artifacts stay under .development/evidence. Product storage/schema is not changed.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {AsyncLocalStorage}=require('node:async_hooks'),phase=new AsyncLocalStorage();
const root=path.resolve(__dirname,'../..');
const {fixture,QUOTE}=require(path.join(root,'PROGRAM/tests/fixtures/libra_memory_graph_reader_fixture.cjs'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),arg=(key,fallback)=>process.argv.find(x=>x.startsWith('--'+key+'='))?.split('=').slice(1).join('=')||fallback;
const commits=arg('commits','76b1a5d,cd78b9f,75b0859').split(','),arms=arg('arms','idle,contention').split(','),results=[];
const evidence=path.join(root,'.development/evidence');fs.mkdirSync(evidence,{recursive:true});
const out=()=>fs.writeFileSync(path.join(evidence,path.basename(arg('output','contention8-results.json'))),JSON.stringify({
 boundary:'Reconstructed 8s server_only + 10 actual producer Micro fixture; original unversioned measurement script unavailable. Product plugin/SDK and server handlers + disk SQLite; in-process HTTP dispatch, synthetic RisuAI/LLM. Contention arm adds a 5ms single-slot FIFO transport to exercise queue competition. Not live RisuAI or historical absolute latency replication.',results},null,2)+'\n');
const percentile=(values,p)=>values.length?Number([...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor((values.length-1)*p))].toFixed(2)):0;
async function run(commit,arm){
 const source=commit==='working-tree'?fs.readFileSync(path.join(root,'PROGRAM/plugins/LIBRA.js'),'utf8'):cp.execFileSync('git',['show',commit+':PROGRAM/plugins/LIBRA.js'],{cwd:root,maxBuffer:16e6}).toString();
 const anchor='    const captureGradiaMemoryEvidenceOnce = async (request, authority) => {';
 if(source.split(anchor).length!==2||source.split('    const stateDerivedWorldlineSuffix =').length!==2)throw Error('benchmark seam absent '+commit);
 const x=await fixture({mode:'server_only',microCount:10,transformSource:()=>source.replace(anchor,
  '    globalThis.__contention8={capture:captureGradiaMemoryEvidence,verify:verifyGradiaMemoryEvidence,release:releaseGradiaMemoryEvidence};\n'+anchor)
  .replace('    const stateDerivedWorldlineSuffix =','    globalThis.__benchIO=state.memoryNetworkIO;\n    const stateDerivedWorldlineSuffix =')});
 const originalFetch=globalThis.fetch,requests=[],reads=[];let tail=Promise.resolve(),enabled=true;
 const start=performance.now(),windowMs=8000,windowDone=sleep(windowMs);
 globalThis.fetch=async(url,init)=>{
  if(!enabled||!String(url).startsWith(x.server.url+'/'))return originalFetch(url,init);
  const row={phase:phase.getStore()||'background',route:new URL(url).pathname,arrivalMs:performance.now()-start};requests.push(row);
  const serve=async()=>{
   row.waitMs=performance.now()-start-row.arrivalMs;
   if(arm==='contention')await sleep(5);
   try{const r=await originalFetch(url,init);row.status=r.status;row.bytes=Buffer.byteLength(await r.clone().text());row.finishedMs=performance.now()-start;return r;}
   catch(e){row.error=e.code||e.message;row.finishedMs=performance.now()-start;throw e;}
  };
  if(arm!=='contention')return serve();
  const task=tail.catch(()=>{}).then(serve);tail=task.then(()=>{},()=>{});return task;
 };
 const state=()=>JSON.parse(JSON.stringify(x.f.r.context.__benchIO));
 const before=state();
 const query=label=>phase.run(label,async()=>{
  const opened=performance.now(),id='contention8-'+label,scopeRow=Object.values(JSON.parse(x.server.local.get('libra:v1:scope-registry:v1'))).find(r=>r.scopeKey===x.scopeKey);
  const request={id,operationId:id,queryText:QUOTE,maxCorpusBytes:4*1024*1024,scope:{scopeKey:x.scopeKey,characterId:scopeRow.characterId,chatId:scopeRow.chatId}};
  let receipt=null,execution=null,captureEnd;
  const authority={bindGraph:graph=>(receipt=Object.freeze({selectionReceiptId:id,ownerCorpusDigest:crypto.createHash('sha256').update(JSON.stringify({frame:graph.readerFrame,nodes:graph.nodes.map(n=>[n.id,n.bindingId])})).digest('hex')})),verifyReceipt:value=>JSON.stringify(value)===JSON.stringify(receipt)};
  try{
   execution=await x.f.r.context.__contention8.capture(request,authority);captureEnd=performance.now();
   const verified=await x.f.r.context.__contention8.verify(execution);
   reads.push({label,startedMs:Number((opened-start).toFixed(2)),captureMs:Number((captureEnd-opened).toFixed(2)),verifyMs:Number((performance.now()-captureEnd).toFixed(2)),eligible:execution.modelDispatchEligible===true,verified:verified===true,evidenceChars:String(execution.packet?.renderedText||'').length});
  }catch(e){reads.push({label,startedMs:Number((opened-start).toFixed(2)),elapsedMs:Number((performance.now()-opened).toFixed(2)),error:e.code||e.message});}
  finally{if(execution)x.f.r.context.__contention8.release(execution);}
 });
 try{
  const work=arm==='contention'?(async()=>{await sleep(250);await query('cold');await sleep(100);await query('warm');})():Promise.resolve();
  await windowDone;const after=state();await work;enabled=false;await tail;
  const inWindow=requests.filter(r=>r.arrivalMs<windowMs),byPhase={};
  for(const label of ['background','cold','warm']){const rows=inWindow.filter(r=>r.phase===label);byPhase[label]={requests:rows.length,kvReads:rows.filter(r=>r.route==='/v1/kv/get'||r.route==='/v1/kv/get-many').length,
   completedWithin8s:rows.filter(r=>r.finishedMs<=windowMs).length,responseBytesCompletedWithin8s:rows.filter(r=>r.finishedMs<=windowMs).reduce((n,r)=>n+(r.bytes||0),0),queueWaitP50Ms:percentile(rows.map(r=>r.waitMs||0),.5),queueWaitP95Ms:percentile(rows.map(r=>r.waitMs||0),.95)};}
  const metrics={};for(const k of ['ownerReads','storedReads','parsedRows','parsedBytes','parseWallMs'])metrics[k]=Number(((after[k]||0)-(before[k]||0)).toFixed(2));
  const totalByPhase=Object.fromEntries(['background','cold','warm'].map(label=>[label,requests.filter(r=>r.phase===label).length]));
  const result={commit,sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),arm,windowMs,microCount:10,transport:{inProcess:true,addedLatencyMs:arm==='contention'?5:0,concurrency:arm==='contention'?1:'unlimited'},byPhase,totalByPhase,reads,networkIODelta:metrics};
  results.push(result);out();console.log(JSON.stringify(result));
 }finally{enabled=false;globalThis.fetch=originalFetch;await x.cleanup();}
}
(async()=>{for(const commit of commits)for(const arm of arms)await run(commit,arm);})().catch(e=>{out();console.error(e);process.exitCode=1;});
