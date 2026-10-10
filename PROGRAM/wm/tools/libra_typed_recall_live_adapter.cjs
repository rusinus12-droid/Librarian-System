'use strict';
const fs=require('node:fs'),path=require('node:path'),{performance}=require('node:perf_hooks');
const {runtime}=require('./libra_typed_recall_queue_test.cjs'),{policy:fixturePolicy,request}=require('./libra_typed_recall_rollout_test.cjs'),{sha}=require('./libra_typed_recall_benchmark.cjs');
const copy=x=>JSON.parse(JSON.stringify(x)),families=['memory','entity','world','narrative'];
function local(url){const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password)throw new Error('local_endpoint_required');return u;}
function transport({provider,budget,live=true,authorization={},sender}){
 local(provider.endpoint);if(live&&(!authorization.gpuSlotReturned||!authorization.allowLocalCalls))throw new Error('gpu_slot_return_and_local_authorization_required');
 if(live&&(!authorization.modelVerified||authorization.modelDigest!==provider.modelRevision))throw new Error('verified_model_digest_required');
 if(!budget||!['maxCalls','maxInputBytes','maxInputTokens'].every(k=>Number.isInteger(budget[k])&&budget[k]>0)||budget.maxCalls>64||budget.concurrency!==1)throw new Error('explicit_bounded_budget_required');
 const p=Object.freeze(copy(provider)),limit=Object.freeze(copy(budget)),capture={calls:[],blocked:[],inputBytes:0,inputTokens:0,active:0,maxActive:0,modelKind:live?'actual_local_endpoint':'fake_provider'};
 let phase='query',send=sender||(async(url,init)=>fetch(url,{method:init.method,headers:init.headers,body:init.body,signal:init.signal,redirect:'error'}));
 const request=async(url,init={})=>{
  local(url);if(url!==p.endpoint)throw new Error('immutable_provider_endpoint_changed');const body=JSON.parse(init.body);
  if(body.model!==p.model||typeof body.input!=='string'||body.truncate!==false)throw new Error('immutable_provider_body_changed');
  const bytes=Buffer.byteLength(body.input),tokens=bytes; // conservative byte proxy, not measured model tokens
  if(capture.calls.length>=limit.maxCalls||capture.inputBytes+bytes>limit.maxInputBytes||capture.inputTokens+tokens>limit.maxInputTokens){capture.blocked.push({role:phase,reason:'measurement_budget',bytes});throw new Error('measurement_budget_exhausted');}
  if(capture.active)throw new Error('measurement_concurrency_bound');
  const call={role:phase,url,body:copy(body),requestSha256:sha(init.body),inputSha256:sha(body.input),inputBytes:bytes,inputTokensProxy:tokens,attempted:true,uncertain:true,startedAt:new Date().toISOString()};
  capture.calls.push(call);capture.inputBytes+=bytes;capture.inputTokens+=tokens;capture.active++;capture.maxActive=Math.max(capture.maxActive,capture.active);const start=performance.now();
  try{const response=await send(url,init),raw=await response.text();if(Buffer.byteLength(raw)>1048576)throw new Error('response_bytes_bound');call.status=response.status;call.response=raw;call.responseSha256=sha(raw);call.uncertain=false;return{ok:response.ok,status:response.status,text:async()=>raw};}
  catch(error){call.error=error.message;throw error;}
  finally{call.elapsedMs=performance.now()-start;capture.active--;}
 };
 return{request,capture,provider:p,setPhase:value=>{if(!['query','document'].includes(value))throw new Error('phase');phase=value;},setSender:value=>{if(live)throw new Error('live_sender_immutable');send=value;}};
}
function installCorpus(r,corpus){
 if(!corpus)return;const graphEntry=r.chat.localLore.find(e=>e.comment==='lmai_world_graph'),graph=JSON.parse(graphEntry.content),narrativeEntry=r.chat.localLore.find(e=>e.comment==='lmai_narrative'),narrative=JSON.parse(narrativeEntry.content);
 const partner=r.all.find(u=>u.family==='entity').record.name;
 for(const[i,arc]of corpus.arcs.entries()){
  const memoryId='memory_'+arc.id,entityId='entity_'+arc.id,worldId='world_'+arc.id,turn=4;
  r.chat.localLore.push({comment:'lmai_memory',key:'lmai_memory::'+memoryId,content:'[META:'+JSON.stringify({t:turn,ttl:-1,imp:8,ent:[arc.person],summary:arc.memory})+']\n'+arc.memory});
  r.chat.localLore.push(r.entry('lmai_entity','lmai_entity::'+arc.person,r.signed({id:entityId,name:arc.person,meta:{created:2},identity:{roleInStory:arc.name},currentState:{summary:arc.entity}},'entity',arc.person)));
  r.chat.localLore.push(r.entry('lmai_relation','lmai_relation::'+arc.id,r.signed({id:'relation_'+arc.id,entityA:arc.person,entityB:partner,currentStatus:{summary:arc.relation,publicLayer:arc.relation},meta:{created:turn}},'relation','relation_'+arc.id)));
  graph.nodes.push([worldId,{id:worldId,name:arc.world,parent:graph.rootId,isActive:false,meta:{created:turn,worldSummary:arc.rule},rules:{custom:{entry:arc.rule}}}]);
  narrative.storylines.push({id:101+i,arcKey:arc.id,name:arc.name,turns:[turn],continuityBrief:arc.narrative,activeThreads:[arc.narrative],evidenceTurns:[String(turn)],memoryRefs:[memoryId]});
 }
 graphEntry.content=JSON.stringify(graph);narrativeEntry.content=JSON.stringify(r.signed(narrative,'narrative','narrative_state'));
 r.snapshot=r.snap();r.all=r.corpus.enumerate(r.snapshot).filter(u=>r.corpus.adapters[u.family].eligibility(u,r.snapshot).eligible);
}
async function observeHost(observer,frame){
 if(!observer)return{status:'unavailable',reason:'no_connected_actual_risu_host_observer',readbackObserved:false,assembledPromptObserved:false,modelConsumption:false};
 try{const read=await observer.readback(frame),assembled=await observer.assembled(frame),text=typeof assembled?.body==='string'?assembled.body:JSON.stringify(assembled?.body||{});
  const projectionPresent=frame.projectionEntries.every(e=>text.includes(e.content)),sameScope=read.scopeKey===frame.scopeKey;
  return{status:observer.kind==='risu_host'?'reported_host_observation':'synthetic_observation',scopeMatched:sameScope,
   readbackObserved:sameScope&&frame.projectionEntries.every(e=>(read.entries||[]).some(row=>row.key===e.key&&row.content===e.content)),
   assembledPromptObserved:observer.kind==='risu_host'&&assembled?.kind==='model_request'&&sameScope&&projectionPresent,
   modelConsumption:false,reason:'assembled request is distinct from model response/independent quality evidence',readback:read,assembled};
 }catch(error){return{status:'unavailable',reason:error.message,readbackObserved:false,assembledPromptObserved:false,modelConsumption:false};}
}
async function session(options){
 const t=transport(options);let stageCapture=null;
 const r=await runtime(options.shared,{admittedHost:true,countEnumeration:options.countEnumeration,dist:options.dist,observeStages:value=>{stageCapture=copy(value);}});installCorpus(r,options.corpus);
 // Restore actual wall time and deadlines after the synthetic host fixture loads.
 const timers=new Set();r.context.Date=Date;
 r.context.setTimeout=(fn,ms,...args)=>{const timer=setTimeout(()=>{timers.delete(timer);fn(...args);},ms);timers.add(timer);return timer;};
 r.context.clearTimeout=timer=>{timers.delete(timer);clearTimeout(timer);};
 r.chat.message=Array.from({length:10},()=>[{role:'user',data:'Please continue the scene.'},{role:'assistant',data:'The scene continues.'}]).flat();
 r.host.nativeFetch=t.request;r.api.MemoryEngine.CONFIG.injectionUnknownHostCapTokens=8000;r.api.MemoryEngine.CONFIG.injectionBudgetMaxTokens=16000;
 const rollout=r.context.__QUEUE_TEST__.rollout,policy=copy(options.policy||fixturePolicy()),provider=t.provider;
 const writes=[],nativeSet=r.api.MemoryEngine.setLorebook;r.api.MemoryEngine.setLorebook=(char,chat,lore)=>{nativeSet(char,chat,lore);writes.push(copy(chat.localLore));};
 rollout.configureFixture(provider,policy);
 const snapshot=()=>r.snap({viewerId:'main_request'});
 const beforeRequest=async(query,{mode='dual',injectionMode='direct',caseId=null}={})=>{
  t.setPhase('query');stageCapture=null;writes.length=0;rollout.setMode(mode);r.api.MemoryEngine.CONFIG.libraInjectionMode=injectionMode;r.api.MemoryEngine.CONFIG.libraProjectionAlwaysActive=true;
  const req=request();req.messages[0].content='Synthetic fixture scene. Use only the supplied context.';req.messages[1].content=query;const start=performance.now(),beforeCalls=t.capture.calls.length;
  const output=await r.api.libraBeforeRequestReplacer(req,'model'),elapsedMs=performance.now()-start,trace=mode==='legacy'?null:rollout.inspect().last;
  const projectionEntries=(writes.at(-1)||[]).filter(e=>e.comment==='lmai_projection_typed_recall'),snap=snapshot();
  const host=await observeHost(options.hostObserver,{scopeKey:snap.scopeKey,projectionEntries,messages:output.messages});
  return{caseId,requestedQuery:query,request:req,output,projectionEntries,trace,stages:stageCapture,elapsedMs,calls:t.capture.calls.slice(beforeCalls),host,
   evidence:{hostKind:'synthetic_vm',modelKind:t.capture.modelKind,projection:'actual_setLorebook_local_argument; no live host persistence proof',legacyProfile:'default legacy heuristic, embedding disabled; no claim of a configured legacy semantic baseline'}};
 };
 const backfill=async(b={maxCalls:Math.min(20,options.budget.maxCalls),maxRows:32,maxBytes:1048576,maxMillis:120000})=>{t.setPhase('document');return r.jobs.backfill(snapshot(),provider,policy,{explicit:true,budget:b});};
 const publishVector=async(handle,snap,unit,vector)=>{
  const row={schema:r.index.ROW_SCHEMA,scopeKey:snap.scopeKey,branchId:snap.branchId,identity:unit.identity,family:unit.family,subtype:unit.subtype,locator:unit.locator,
   contentHash:unit.persistentContentHash,dependencyHash:unit.persistentDependencyHash,representationVersion:unit.representationVersion,sourceHash:r.index.sourceHash(unit.text),provider:r.index.providerDescriptor(provider),mode:provider.documentMode,dimension:provider.dimension,viewerId:snap.viewerId,vector,vectorChecksum:r.index.vectorChecksum(vector)};
  const published=await r.index.publish(handle,[row],snap);if(!published.ok)throw new Error('pilot_publish:'+published.reason);return published;
 };
 const pilotDocuments=async(ids)=>{
  t.setPhase('document');const snap=snapshot(),units=r.corpus.enumerate(snap,policy).filter(u=>r.corpus.adapters[u.family].eligibility(u,snap).eligible);
  const chosen=ids?ids.map(id=>units.find(u=>u.identity===id)):families.map(f=>units.find(u=>u.family===f));if(chosen.some(u=>!u))throw new Error('pilot_canonical_unit_missing');
  const handle=await r.index.open(snap,provider,policy),reports=[];
  for(const unit of chosen){const result=await r.api.MemoryEngine.getEmbeddingWithSnapshot(unit.text,provider,{mode:provider.documentMode,signal:new AbortController().signal,deadline:Date.now()+120000});
   if(!result.ok)throw new Error('pilot_document:'+result.reason);
   const published=await publishVector(handle,snap,unit,result.vector);reports.push({identity:unit.identity,family:unit.family,inputSha256:sha(unit.text),publish:copy(published)});
  }
  return{documents:reports,coverage:copy(r.index.read(handle,units).readiness)};
 };
 const importCapturedDocuments=async(source)=>{
  if(policy.mode!=='fixture'||JSON.stringify(source.provider)!==JSON.stringify(provider))throw new Error('captured_provider_mismatch');
  const snap=snapshot(),units=r.corpus.enumerate(snap,policy),handle=await r.index.open(snap,provider,policy),reports=[];
  for(const document of source.documents){const unit=units.find(u=>u.identity===document.identity),call=source.calls.find(c=>c.role==='document'&&c.inputSha256===document.inputSha256);
   if(!unit||!r.corpus.adapters[unit.family].eligibility(unit,snap).eligible||!call||call.url!==provider.endpoint||call.body.model!==provider.model||call.body.input!==unit.text||sha(unit.text)!==document.inputSha256||sha(call.response)!==call.responseSha256||call.status!==200)throw new Error('captured_canonical_input_mismatch');
   const vector=JSON.parse(call.response).embeddings?.[0];reports.push({identity:unit.identity,publish:copy(await publishVector(handle,snap,unit,vector))});
  }
  return{reports,modelCalls:0,evidence:'reconstructed fixture rows from exact captured product document inputs/real response vectors; not disk reload of the original pilot runtime'};
 };
 return{runtime:r,provider,policy,capture:t.capture,backfill,pilotDocuments,importCapturedDocuments,beforeRequest,setSender:t.setSender,snapshot,
  readiness:async()=>{const snap=snapshot(),units=r.corpus.enumerate(snap,policy);return copy(r.index.read(await r.index.open(snap,provider,policy),units).readiness);},
  close:async()=>{r.jobs.pause(r.snapshot.scopeKey);rollout.setMode('legacy');for(const timer of timers)clearTimeout(timer);timers.clear();await r.close();},
  storage:()=>({keys:r.store.size,bytes:[...r.store].reduce((n,[k,v])=>n+Buffer.byteLength(k)+Buffer.byteLength(String(v)),0)})};
}
module.exports={transport,session,observeHost,installCorpus,local};
