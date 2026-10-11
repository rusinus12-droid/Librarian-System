'use strict';const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');const sha=b=>crypto.createHash('sha256').update(b).digest('hex');const fixture=__dirname+'/fixtures/hayaku_cache_rediscovery_frozen.json';
 const source=process.argv[2]||path.resolve(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),label='rediscovery-'+process.pid+'-'+Date.now();assert(source&&/^[a-z0-9-]+$/.test(label));const out=path.join(require('os').tmpdir(),label+'.json');assert(!fs.existsSync(out));const bytes=fs.readFileSync(fixture),data=JSON.parse(bytes),observations=[];let h;
 (async()=>{
  const originalSource=fs.readFileSync(source,'utf8'),anchor='        localRecallPrepareSources,\n';assert.equal(originalSource.split(anchor).length,2);
  const clockAnchor='  const now = () => Date.now();';assert.equal(originalSource.split(clockAnchor).length,2);
  // Isolated observer VM only: semantic cases control elapsed work time, while
  // real host timers/storage remain unchanged. Production source bytes stay exact.
  const observedSource=originalSource.replace(clockAnchor,'  let rediscoveryTestClock=null;\n  const now = () => rediscoveryTestClock ? rediscoveryTestClock() : Date.now();').replace(anchor,"        setRediscoveryClock: clock => { rediscoveryTestClock=clock; },\n        cachePresenceProbe: (scopeKey,raw) => [...localRecallPacketCache].some(([key,entry])=>key.split('\\u0001')[3]===scopeKey&&entry.sourceProof===raw),\n"+anchor);
  const probe=require('path').join(require('os').tmpdir(),label+'-cache-presence-probe.js');assert(!fs.existsSync(probe));fs.writeFileSync(probe,observedSource);
  h=await createHayakuRuntime({pluginSourceFile:probe,autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,arguments:{memory_suite_server_mode:'plugin_only',hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('FORBIDDEN_MODEL');}});
  const t=h.hayaku._test,settings={...h.hayaku.settings(),mode:'auto',effectiveMode:'fast',maxItemsPerAxis:3,retrievalRecentContext:{topics:[]},hierarchicalEpisodeMemoryEnabled:false};
  const scopeStores=new Map();const storeFor=scope=>{if(!scopeStores.has(scope))scopeStores.set(scope,t.emptyStore());return scopeStores.get(scope);};
  const prepare=async(scope,query,sources=data.sources)=>{const store=storeFor(scope),s={...settings,retrievalCurrentQuery:query};const budget={remaining:64},semanticAt=Date.now();let coverage;
   t.setRediscoveryClock(()=>semanticAt);try{coverage=await t.localRecallPrepareSources(sources,store,s,scope,semanticAt+10000,budget);}finally{t.setRediscoveryClock(null);}
   const candidates=t.localRecallCandidates(store,query,s),prepared=t.prepareHayakuRecallRows(candidates,query,s,store,[],[]),plan=t.selectHayakuEvidencePlan(prepared,query,s,12000);
   assert(coverage.processedThisRequest<=64&&coverage.processedTotalThisRequest<=64);assert(candidates.length<=48&&plan.renderedEntries<=16&&plan.text.length<=12000);
   if(coverage.cache)assert(coverage.cache.sources<=512&&coverage.cache.chars<=16000000&&coverage.cache.matchedHintSources<=48&&coverage.cache.hintScopeCount<=8);
   return {store,coverage,candidates,plan};};
  // Discover a common query first. Different later questions cannot borrow its answer oracle.
  for(let i=0;i<12;i++){const result=await prepare('eviction-scope',data.query);observations.push({phase:'fill-and-evict',iteration:i,coverage:result.coverage,markers:data.targets.filter(x=>result.candidates.some(r=>String(r.publicText||'').includes(x.body))).map(x=>x.turn)});await new Promise(r=>setTimeout(r,5));}
  for(let i=0;i<9;i++){const result=await prepare('evicting-other-scope',data.query);observations.push({phase:'other-scope-forced-eviction',iteration:i,coverage:result.coverage});}
  const beforeNovel=data.targets.map(target=>({turn:target.turn,cached:t.cachePresenceProbe('eviction-scope',data.sources[target.turn-1].raw)}));assert(beforeNovel.some(target=>!target.cached),'novel cases actually include an evicted source');
  for(const target of data.targets){const cachedBeforeQuestion=t.cachePresenceProbe('eviction-scope',data.sources[target.turn-1].raw),r=await prepare('eviction-scope',target.query);observations.push({phase:'first-novel-after-eviction',turn:target.turn,query:target.query,cachedBeforeQuestion,hit:r.plan.text.includes(target.body),coverage:r.coverage});}
  // Fresh scope and different source-set bindings; no prior matched hint is available.
  for(let i=0;i<10;i++){const target=data.targets[(i*5)%data.targets.length],scope='alternating-scope-'+i;const r=await prepare(scope,target.query);observations.push({phase:'cold-alternating-scope',scope,turn:target.turn,hit:r.plan.text.includes(target.body),coverage:r.coverage});}
  for(let i=0;i<24;i++){const target=data.targets[(i*7)%data.targets.length],scope='alternating-scope-'+(i%10);const r=await prepare(scope,target.query);observations.push({phase:'diverse-queries-revisit-scope',scope,turn:target.turn,hit:r.plan.text.includes(target.body),coverage:r.coverage});}
  // Separate exhaustion case: advance the actual production now() checks by
  // 10ms per call. The unchanged 150ms temporary routing bound must stop before
  // all 600 sources; the unchanged 64-source projection budget still applies.
  // This is one forced deadline observation, never retried to obtain a fact.
  const deadlineAt=Date.now(),deadlineScope='forced-routing-deadline',deadlineStore=t.emptyStore(),deadlineTarget=data.targets.find(row=>row.turn===471);assert(deadlineTarget);
  let clockReads=0,deadlineCoverage,deadlinePlan;const deadlineBudget={remaining:64};
  t.setRediscoveryClock(()=>deadlineAt+(clockReads++)*10);
  try{
   deadlineCoverage=await t.localRecallPrepareSources(data.sources,deadlineStore,{...settings,retrievalCurrentQuery:deadlineTarget.query},deadlineScope,deadlineAt+10000,deadlineBudget);
   const candidates=t.localRecallCandidates(deadlineStore,deadlineTarget.query,settings),prepared=t.prepareHayakuRecallRows(candidates,deadlineTarget.query,settings,deadlineStore,[],[]);
   deadlinePlan=t.selectHayakuEvidencePlan(prepared,deadlineTarget.query,settings,12000);
  }finally{t.setRediscoveryClock(null);}
  assert.equal(deadlineCoverage.routing.reason, 'bounded_paged_source_postings', 'forced cap control must reach actual posting branch, not40ms binding fallback');
  assert(deadlineCoverage.routing.scanned>0&&deadlineCoverage.routing.scanned<data.sources.length);
  // A fresh scope has no reusable documents. Each missing-source gate consumes
  // at least one 10ms clock step, so the actual150ms window permits at most15.
  assert(deadlineCoverage.routing.scanned<=Math.floor(150/10),'temporary posting routing must obey the150ms window at10ms per gate');
  assert.equal(deadlineCoverage.routing.pending,data.sources.length-deadlineCoverage.routing.scanned);
  assert.equal(deadlineCoverage.routing.complete,false);assert.equal(deadlineCoverage.routing.index.current,false);assert.equal(deadlineCoverage.routing.index.durable,false);
  assert(deadlineCoverage.processedThisRequest<=64&&deadlineCoverage.processedTotalThisRequest<=64);assert.equal(deadlineCoverage.processedTotalThisRequest,64-deadlineBudget.remaining);
  assert.equal(deadlinePlan.text.includes(deadlineTarget.body),false,'unrouted target must not fabricate a fact');
  const deadlineControl={clock:'deterministic advancing now; real timers and storage unchanged',clockStepMs:10,clockReads,coverage:deadlineCoverage,targetTurn:deadlineTarget.turn,targetAbsent:true};
  const target=data.targets[0],edited=data.sources.map(p=>({...p}));edited[0].raw=JSON.stringify(createValidPacket({turn:1,subject:'Observatory steward',scene:'observatory',summary:`${target.subject} transferred the ${target.instrument} to the eastern gallery.`}));
  const e=await prepare('eviction-scope',target.query,edited);observations.push({phase:'same-identity-edit',oldAbsent:!e.plan.text.includes(target.body),replacementPresent:e.plan.text.includes('eastern gallery'),coverage:e.coverage});
  const deleted=await prepare('eviction-scope',target.query,edited.slice(1));observations.push({phase:'accepted-source-deletion',oldAbsent:!deleted.plan.text.includes(target.body),replacementAbsent:!deleted.plan.text.includes('eastern gallery'),coverage:deleted.coverage});
  assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  const positives=observations.filter(x=>typeof x.hit==='boolean'),failures=positives.filter(x=>!x.hit);
  assert.equal(fs.readFileSync(source,'utf8'),originalSource);
  const result={at:new Date().toISOString(),source,sourceSha:sha(fs.readFileSync(source)),probe,probeSha:sha(observedSource),observer:'isolated cache-presence accessor and controllable now() seam; source/preparation/ranking/selection and production bounds unchanged',semanticClock:'held during each of46 question preparations; also holds related now()-based timestamps in that interval; first-query facts preserved; no real-time latency claim',deadlineControl,beforeNovel,fixture,fixtureSha:sha(bytes),observations,positiveRequests:positives.length,fullFactSuccess:positives.length-failures.length,failed:failures.map(x=>({phase:x.phase,turn:x.turn,scope:x.scope})),editDeletionPass:observations.slice(-2).every(x=>x.oldAbsent&&(x.replacementPresent??x.replacementAbsent)),modelCalls:0,embeddingCalls:0,boundary:data.boundary};
  fs.writeFileSync(out,JSON.stringify(result,null,2));
  assert.equal(result.fullFactSuccess,result.positiveRequests);assert.equal(result.editDeletionPass,true);console.log(JSON.stringify({out,expectedCount:result.positiveRequests,passed:result.fullFactSuccess,positiveRequests:result.positiveRequests,fullFactSuccess:result.fullFactSuccess,failed:result.failed,editDeletionPass:result.editDeletionPass}));
 })().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{await h?.dispose();});
