'use strict';
// Offline evaluator and physical IO instrumentation. No evaluator input is passed
// to product scoring, admission or packing. Protected context remains enabled.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const ROOT=path.resolve(__dirname,'..'),ART=path.join(ROOT,'test-output/wm-hme-v6-20261003'),FIX=path.join(ART,'fixture');
const shared=require(path.join(FIX,'shared-adapter.cjs'));
const {nativeCurrentCorpus}=require(path.join(FIX,'native-current-corpus.cjs'));
const {questions,evaluate}=require(path.join(FIX,'panel.cjs'));
const SCOPE='wm-provenance-cost',sha=x=>crypto.createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const clone=x=>JSON.parse(JSON.stringify(x)),gc=()=>{assert.equal(typeof global.gc,'function','explicit GC required');global.gc();};
function editSource(rows){
 const next=clone(rows),n=next.filter(r=>r.role==='assistant').length;
 for(const id of ['a1','a'+n]){
  const row=next.find(r=>r.chatId===id),match=row.data.match(/<!-- HAYAKU_STATE_PACKET_START ([\s\S]*?) HAYAKU_STATE_PACKET_END -->/);
  let body=match[1];if(id==='a1')body=body.replaceAll('BENCH_A0','BENCH_A1');
  else {const packet=JSON.parse(body);packet.entity.characters[0].current_state='Source-edited current public Archivist state at turn '+n;packet.world.world_rules[0].summary='Source-edited world rule at turn '+n;packet.narrative.current_arc='source-edited-arc-'+n;body=JSON.stringify(packet);}
  row.data=row.data.replace(match[1],body);
 }
 return next;
}
function instrumentStore(directory){
 const store=shared.diskStore(directory);let active=null,canonicalKey='';
 const classify=k=>String(k).endsWith(':typed-graph')?'hme_source_graph':String(k).includes('hme-derived:')?'hme_other':canonicalKey&&String(k).startsWith(canonicalKey)?'canonical':'other';
 const sample=()=>{if(active){const mem=process.memoryUsage();active.heapSampleCount++;active.sampledPeakHeap=Math.max(active.sampledPeakHeap,mem.heapUsed);active.sampledPeakRss=Math.max(active.sampledPeakRss,mem.rss);}};
 for(const [method,operation]of [['getItem','read'],['setItem','write'],['removeItem','remove']]){
  const original=store[method].bind(store);
  store[method]=async(key,...args)=>{
   sample();const before={...store.stats},pending=original(key,...args),delta=Object.fromEntries(Object.keys(before).map(k=>[k,store.stats[k]-before[k]]));
   if(active){const group=classify(key);const k=group+':'+sha(String(key)).slice(0,16);const row=active.byKey[k]||(active.byKey[k]={group,keyHash:sha(String(key)),reads:0,readBytes:0,writes:0,writeBytes:0,removes:0});for(const field of Object.keys(delta))row[field]+=delta[field];
    if(operation==='write'&&group==='hme_source_graph'){const value=JSON.parse(String(args[0]));active.graphWrites.push({wholeGraph:true,nodes:value.graph?.nodes?.length,edges:value.graph?.edges?.length,serializedBytes:Buffer.byteLength(String(args[0]))});}}
   const result=await pending;sample();return result;
  };
 }
 return {store,setCanonicalKey:k=>canonicalKey=k,async measure(operation){
  assert.equal(active,null);gc();const before=process.memoryUsage(),io={...store.stats};active={byKey:{},graphWrites:[],heapSampleCount:0,sampledPeakHeap:before.heapUsed,sampledPeakRss:before.rss};
  const at=performance.now();let value,error;try{value=await operation();}catch(e){error=e;}
  const wallMs=performance.now()-at;sample();const end=process.memoryUsage(),record=active;active=null;gc();const settled=process.memoryUsage();
  const measurement={wallMs,physicalIo:Object.fromEntries(Object.keys(io).map(k=>[k,store.stats[k]-io[k]])),byKey:record.byKey,graphWrites:record.graphWrites,heap:{startGcBytes:before.heapUsed,endBeforeGcBytes:end.heapUsed,endGcBytes:settled.heapUsed,settledDeltaBytes:settled.heapUsed-before.heapUsed,sampledPeakBytes:record.sampledPeakHeap,sampledPeakDeltaBytes:record.sampledPeakHeap-before.heapUsed,sampledPeakRssBytes:record.sampledPeakRss,samples:record.heapSampleCount,limit:'IO-boundary/request-boundary samples, not instruction-level peak; GC outside timed request'}};
  if(error)throw Object.assign(error,{measurement});return {value,measurement};
 }};
}
async function prepare(n){
 const output=path.join(ART,'prepared-'+n+'.json');if(fs.existsSync(output))return JSON.parse(fs.readFileSync(output));
 const initialSource=shared.recipe().messages(n),updatedSource=editSource(initialSource),v3='C:/Users/rusin/AppData/Local/Temp/LIB-WM-RestorePhase2-20261002/WM-general-read-reuse/dist/LIBRA World Manager Full.js';
 const a=await shared.startAdapter(initialSource,SCOPE,shared.diskStore(path.join(ART,'preparation-store-'+n)),v3);
 let initial,updated;try{initial=nativeCurrentCorpus(initialSource,SCOPE,a);const replacement=nativeCurrentCorpus(updatedSource,SCOPE,a),byKey=new Map(replacement.map(e=>[e.key,e]));
  // Only entries whose source actually changed are replaced. Whole remapping's
  // new timestamps must not manufacture updates to every unchanged source.
  const changedKeys=new Set(['lmai_memory::a1','lmai_memory::a'+n,...initial.filter(e=>e.comment!=='lmai_memory').map(e=>e.key)]);
  updated=initial.map(e=>changedKeys.has(e.key)?byKey.get(e.key):e);assert(updated.every(Boolean));
 }finally{a.dispose();}
 const changed=initial.filter((e,i)=>sha(e)!==sha(updated[i])).map((e,i)=>({key:e.key,oldSha256:sha(e),newSha256:sha(updated.find(x=>x.key===e.key))}));
 const result={schema:'wm.identical-prepared-source.v1',n,initialSource,updatedSource,initial,updated,sourceSha256:sha(initialSource),updatedSourceSha256:sha(updatedSource),canonicalSha256:sha(initial),updatedCanonicalSha256:sha(updated),changed,preparation:'once with frozen v3 official codec; fixture authoring only, realModels0'};
 fs.writeFileSync(output,JSON.stringify(result));return result;
}
function provenance(question,returned,last){
 if(!last?.retrieval?.trace||!last?.consumer){
  // Record a product path that did not reach the typed consumer as failed. Raw
  // substring presence cannot substitute for missing source-bound provenance.
  const messages=Array.isArray(returned)?returned:returned?.messages||[];
  const context=messages.filter(r=>!(r.role==='user'&&r.content===question.query)).map(r=>String(r.content||'')).join('\n');
  return {pipelineStatus:'TYPED_RETRIEVAL_OR_CONSUMER_NOT_REACHED',allRequiredFinalFacts:false,integratedEnvironment:false,census:{},forbidden:['BENCH_FA','BENCH_FB','BENCH_FC','PRIVATE_ENTITY_CANARY'].filter(s=>context.includes(s)),facts:question.required.map(f=>({...f,candidate:false,selected:false,recallEmitted:false,baselineEmitted:false,finalContextContains:context.includes(f.value),finalSourceBound:false,paths:[],route:'missing',firstMissingRecallStage:'typed_path_not_reached'})),emitted:[],returnedSha256:sha(returned),recallOnlyFacts:0,baselineOnlyFacts:0,observation:{lastKeys:Object.keys(last||{}),reason:last?.reason||'',retrievalReason:last?.retrieval?.trace?.reason||'',consumerReason:last?.consumer?.trace?.reason||''}};
 }
 const e=evaluate(question,returned,last),facts=e.stages.map(s=>({...s,recallEmitted:s.paths.some(p=>p.kind==='recall'),baselineEmitted:s.paths.some(p=>p.kind!=='recall')}));
 for(const f of facts)f.route=f.recallEmitted?(f.baselineEmitted?'both':'recall_only'):(f.baselineEmitted?'baseline_only':'missing');
 return {allRequiredFinalFacts:e.allRequiredFinalFacts,integratedEnvironment:e.integratedEnvironment,census:e.census,forbidden:e.forbidden,facts,emitted:e.emitted.map(b=>({identity:b.identity,kind:b.kind,family:b.family,roles:b.roles,sourceRefs:b.sourceRefs,textSha256:sha(b.text)})),returnedSha256:e.rawSha256,recallOnlyFacts:facts.filter(f=>f.recallEmitted).length,baselineOnlyFacts:facts.filter(f=>f.route==='baseline_only').length};
}
function traceOf(last){
 last=last||{};
 const t=last.retrieval?.trace||{},h=t.lanes?.heuristic||{},s=t.lanes?.semantic||{};
 return {reason:t.reason||'',byType:t.byType,heuristic:{status:h.status,reason:h.reason,memory:h.trace?.memory&&{stage:h.trace.memory.stage,scoredCount:h.trace.memory.scoredCount,detailCandidateBound:h.trace.memory.detailCandidateBound}},semantic:{status:s.status,reason:s.reason},graph:h.trace?.graph,consumer:{reason:last.consumer?.trace?.reason,chars:last.consumer?.trace?.chars,tokens:last.consumer?.trace?.tokens}};
}
async function run(version,n,repeat){
 assert(['base','v3','v4','v5','v6'].includes(version));assert([10,100,1000,2000].includes(n));assert([1,2,3].includes(repeat));
 const dist=version==='base'?'C:/Users/rusin/AppData/Local/Temp/WM-base-v4-20261003/dist/LIBRA World Manager Full.js':version==='v3'?'C:/Users/rusin/AppData/Local/Temp/LIB-WM-RestorePhase2-20261002/WM-general-read-reuse/dist/LIBRA World Manager Full.js':version==='v4'?'C:/Users/rusin/AppData/Local/Temp/WM-HME-v4-20261003/dist/LIBRA World Manager Full.js':version==='v5'?'C:/Users/rusin/AppData/Local/Temp/WM-HME-v5-20261003/dist/LIBRA World Manager Full.js':path.join(ROOT,'dist/LIBRA World Manager Full.js');
 const name=version+'-'+n+'-repeat'+repeat,output=path.join(ART,name+'.json');assert(!fs.existsSync(output),'preserve earlier result');
 const prepared=await prepare(n),rows=[],writes=[];let a=null,io=null,source=prepared.initialSource,entries=prepared.initial;
 const write=()=>fs.writeFileSync(output,JSON.stringify({schema:'wm.provenance-cost.registered.v1',version,n,repeat,bundleSha256:sha(fs.readFileSync(dist)),sourceSha256:prepared.sourceSha256,canonicalSha256:prepared.canonicalSha256,updatedCanonicalSha256:prepared.updatedCanonicalSha256,changed:prepared.changed,rows,writes,realModels:0,limits:['Protected product context stays enabled; recall-only evaluation does not alter admission or packing.','Identical once-prepared canonical bytes and source transcript for all versions.','Incremental fixture replacement is not model/native source authoring.','Explicit GC outside timed requests and IO-boundary heap samples; not full transient-heap gate.','Shared-PC timing; external LIB process ownership unverified.']},null,2));
 try{for(const phase of ['cold','warm','update']){
  if(phase==='update'){
   source=prepared.updatedSource;entries=prepared.updated;
   const measured=await io.measure(async()=>{await a.install(source,SCOPE,false);const scope=a.api.LibraDataStorage.scopeKeyFor(a.char,a.chat);await a.typed.compat.pluginStorage.setItem(a.api.LibraDataStorage.storageKeyFor(scope),JSON.stringify({scopeKey:scope,entries,resetGeneration:0}));const checked=await a.api.LibraDataStorage.readVerified(scope);assert.equal(sha(checked.entries),sha(entries));});
   writes.push({phase,kind:'incremental fixture source replacement through existing canonical adapter',changedUnits:prepared.changed.length,canonicalBytes:Buffer.byteLength(JSON.stringify(entries)),...measured.measurement});write();
  }
  const cases=questions(source).map(q=>phase==='update'?{...q,required:q.required.map(f=>({...f,value:f.value.replaceAll('BENCH_A0','BENCH_A1')}))}:q);
  for(const question of cases){
   if(phase==='cold'){
    a?.dispose();a=null;gc();io=instrumentStore(path.join(ART,name+'-store-measurement2','cold-'+question.id));a=await shared.startAdapter(source,SCOPE,io.store,dist,true,{expectedCanonicalEntries:prepared.initial});
    const scope=a.api.LibraDataStorage.scopeKeyFor(a.char,a.chat),key=a.api.LibraDataStorage.storageKeyFor(scope);io.setCanonicalKey(key);
    await a.typed.compat.pluginStorage.setItem(key,JSON.stringify({scopeKey:scope,entries,resetGeneration:0}));assert.equal(sha((await a.api.LibraDataStorage.readVerified(scope)).entries),sha(entries));
   }
   const measured=await io.measure(()=>a.request(question.query)),last=a.typed.rollout.inspect().last,evaluated=provenance(question,measured.value,last);
   assert.equal(sha(source),phase==='update'?prepared.updatedSourceSha256:prepared.sourceSha256);assert.equal(a.calls.actualModel,0);assert.equal(a.calls.blockedTransport,0);
   const staleForbidden=phase==='update'&&JSON.stringify(measured.value).includes('BENCH_A0');
   rows.push({phase,question,sourceSha256:sha(source),...measured.measurement,evaluated,trace:traceOf(last),staleForbidden});write();
   console.log(JSON.stringify({version,n,repeat,phase,q:question.id,ms:Math.round(measured.measurement.wallMs),final:evaluated.allRequiredFinalFacts,recall:evaluated.recallOnlyFacts,baselineOnly:evaluated.baselineOnlyFacts,graphWrites:measured.measurement.graphWrites.length,rebuild:rows.at(-1).trace.graph?.maintenance?.rebuiltNodes,reason:rows.at(-1).trace.reason}));
  }
 }}finally{a?.dispose();}
 return output;
}
module.exports={run,prepare,instrumentStore,provenance,traceOf,shared,ART,SCOPE};
if(require.main===module)run(process.argv[2],Number(process.argv[3]),Number(process.argv[4]||1)).catch(e=>{console.error(e.stack);process.exitCode=1;});
