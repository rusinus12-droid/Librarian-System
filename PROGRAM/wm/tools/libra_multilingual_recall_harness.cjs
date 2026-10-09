'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{performance}=require('perf_hooks');
const {load}=require('./libra_recall_test_runtime.cjs');
const fixture=require('./fixtures/multilingual-recall.cjs');
const DIST=process.env.LIBRA_RECALL_TEST_DIST||path.join(__dirname,'..','dist','LIBRA World Manager Full.js');
const conditions=['pre_unicode_anchor','unicode','intent_domain_ablation'];
const clone=x=>JSON.parse(JSON.stringify(x));
const ids=rows=>Array.from(rows||[],x=>String((x.entry||x).key));
function replaceOnce(code,from,to){if(code.split(from).length!==2)throw new Error('hook boundary missing or ambiguous: '+from.slice(0,95));return code.replace(from,to);}
function transform(source,condition,initializationProbe=''){
  let code=source;
  if(condition==='pre_unicode_anchor')code=replaceOnce(code,'.replace(/[^\\p{L}\\p{M}\\p{N}_\\s]/gu, \' \')','.replace(/[^\\w가-힣\\s]/g, \' \')');
  if(condition==='intent_domain_ablation'){
    code=replaceOnce(code,"const classifyRecallIntent = (query = '') => {","const classifyRecallIntent = (query = '') => { return {origin:false,transition:false,current:false,relationship:false,worldRule:false,aftermath:false,any:false,labels:[]};");
    code=replaceOnce(code,'externalMismatch: !!(externalMismatch || explicitExternalMismatch),','externalMismatch: false,');
  }
  const hooks=[
    ['const allCandidatesByKey = new Map(candidatePool','globalThis.__probe(\'protected\',candidatePool);\n                const allCandidatesByKey = new Map(candidatePool'],
    ['let filtered = filterRecallEligibleEntries(candidatePool, eligibilityContext).entries;','globalThis.__probe(\'scope\',candidatePool);\n                let filtered = filterRecallEligibleEntries(candidatePool, eligibilityContext).entries;'],
    ['let hmeGraphRecallDebug = null;','globalThis.__probe(\'hybrid\',filtered);\n                let hmeGraphRecallDebug = null;'],
    ['let belowThresholdCount = 0;','globalThis.__probe(\'graph_overlap\',filtered);\n                let belowThresholdCount = 0;'],
    ['const cheapDetails = await Promise.all(preparedCandidates.map','globalThis.__probe(\'detail\',preparedCandidates);\n                const cheapDetails = await Promise.all(preparedCandidates.map'],
    ['let queryEmbedding = undefined;','globalThis.__probe(\'embedding_signal\',preparedCandidates);\n                let queryEmbedding = undefined;'],
    ['const accepted = scoredResults.filter(item => item && item.accepted)','globalThis.__probe(\'scored\',scoredResults);\n                const accepted = scoredResults.filter(item => item && item.accepted)'],
    ['            inspectRecallEligibility,','            __offline:{buildHybridScopeIndexFromEntries,cacheHybridScopeIndex,EmbeddingEngine},\n            inspectRecallEligibility,']
  ];
  for(const [from,to] of hooks)code=replaceOnce(code,from,to);
  code=replaceOnce(code,'getEmbedding: async (text, options = {}) => {','getEmbedding: async (text, options = {}) => { return globalThis.__blockEmbedding();');
  const bootstrap='globalThis.fetch=globalThis.__blockNetwork;risuai.nativeFetch=globalThis.__blockNetwork;\n';
  const probe=initializationProbe==='fetch'?"\nvoid fetch('offline-init-control').catch(()=>{});":initializationProbe==='nativeFetch'?"\nvoid risuai.nativeFetch('offline-init-control').catch(()=>{});":initializationProbe==='embedding'?"\nvoid globalThis.__blockEmbedding().catch(()=>{});":'';
  return bootstrap+code+probe;
}
function metrics(selected,relevant,forbidden,k){
  const rows=selected.slice(0,k),found=rows.filter(x=>relevant.includes(x)),rank=rows.findIndex(x=>relevant.includes(x));
  const dcg=rows.reduce((sum,x,i)=>sum+(relevant.includes(x)?1/Math.log2(i+2):0),0);
  const ideal=Array.from({length:Math.min(k,relevant.length)},(_,i)=>1/Math.log2(i+2)).reduce((a,b)=>a+b,0);
  return {recall:relevant.length?new Set(found).size/relevant.length:null,mrr:relevant.length?(rank<0?0:1/(rank+1)):null,ndcg:ideal?dcg/ideal:null,inappropriate:rows.filter(x=>!relevant.includes(x)).length,safetyViolations:rows.filter(x=>forbidden.includes(x)).length};
}
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
function aggregate(rows){const average=stage=>mean(rows.map(x=>x.coverage[stage]).filter(x=>x!==null));return {queryCount:rows.length,recallAt4:mean(rows.map(x=>x.metrics.recall).filter(x=>x!==null)),mrrAt4:mean(rows.map(x=>x.metrics.mrr).filter(x=>x!==null)),ndcgAt4:mean(rows.map(x=>x.metrics.ndcg).filter(x=>x!==null)),stageCoverage:Object.fromEntries(['protected','scope','hybrid','graph_overlap','detail','embedding_signal','accepted'].map(stage=>[stage,average(stage)])),detailCoverage:average('detail'),lexicalSignalCoverage:average('embedding_signal'),inappropriate:rows.reduce((n,x)=>n+x.metrics.inappropriate,0),safetyViolations:rows.reduce((n,x)=>n+x.metrics.safetyViolations,0),explicitNegationViolations:rows.reduce((n,x)=>n+x.excludedReturned.length,0),unparsedNegationQueries:rows.filter(x=>x.category==='explicit_negation'&&x.negationTerms.length===0).length,canonicalMutations:rows.filter(x=>x.canonicalMutated).length,externalCalls:rows.reduce((n,x)=>n+x.externalCalls,0),latencyMs:{mean:mean(rows.map(x=>x.latencyMs)),p95:rows.map(x=>x.latencyMs).sort((a,b)=>a-b)[Math.ceil(rows.length*.95)-1]},finalDropStages:rows.reduce((o,x)=>(o[x.finalDrop]=(o[x.finalDrop]||0)+1,o),{}),firstCandidateLoss:rows.reduce((o,x)=>(o[x.firstCandidateLoss]=(o[x.firstCandidateLoss]||0)+1,o),{}),graphRecovered:rows.filter(x=>x.graphRecovered).length};}
async function run(options={}){
  const selectedDist=options.dist||DIST;
  const raw=fs.readFileSync(selectedDist,'utf8'),sourceSha256=crypto.createHash('sha256').update(raw).digest('hex');
  if(options.expectedSourceSha256 && sourceSha256!==options.expectedSourceSha256)throw new Error('Explicit historical snapshot mismatch: '+sourceSha256);
  const all=[];let externalCalls=0,providerCalls=0;
  for(const condition of conditions){
    let trace={},networkAttempts=0,embeddingAttempts=0;
    const block=async()=>{networkAttempts++;throw new Error('OFFLINE network call blocked');};
    const blockEmbedding=async()=>{embeddingAttempts++;throw new Error('OFFLINE embedding call blocked');};
    const runtime=await load({dist:selectedDist,transformCode:code=>transform(code,condition,options.initializationProbe),globals:{__blockNetwork:block,__blockEmbedding:blockEmbedding,__probe:(stage,rows)=>{
      trace[stage]=ids(rows);
      if(stage==='embedding_signal')trace.embeddingSignals=Array.from(rows,x=>({key:x.entry.key,reasons:Array.from(x.embeddingPrefilter?.reasons||[]),score:x.embeddingPrefilter?.score||0,actualEligible:!!x.embeddingPrefilter?.eligible}));
      if(stage==='scored')trace.scoreDetails=Array.from(rows,x=>({key:x.entry.key,accepted:x.accepted,reason:x.rejectReason||'',score:x.finalScore,sparse:x.detail?.sparseScore,negativeReject:!!x.scoringV2?.negativeAnchorHardReject}));
    }}});
    if(networkAttempts||embeddingAttempts)throw new Error('OFFLINE startup attempts: '+networkAttempts+'/'+embeddingAttempts);
    const api=runtime.api,ME=api.MemoryEngine,H=ME.__offline;
    ME.CONFIG.debug=true;ME.CONFIG.coldArchiveHydrationEnabled=false;ME.CONFIG.hmeAssociativeGraphMode='light';
    if(condition==='intent_domain_ablation')ME.CONFIG.recallDomainGuardEnabled=false;
    ME.setTurn(40);
    const rows=[];
    for(const q of [...fixture.queries(),...fixture.domainControls()]){
      trace={};const scope='offline-'+condition+'-'+q.id,corpus=fixture.corpus(q.memoryLanguage);
      const forbidden=['deleted','expired'];
      let worldlineState;
      if(q.reroll){
        const pair=t=>({pairIndex:t,userText:'u'+t,assistantText:'a'+t});
        await api.LibraTurnWorldline.observe(scope,[pair(1),pair(2)],{now:1000});
        const old=api.LibraTurnWorldline.get(scope).nodes.find(n=>n.pairIndex===2&&n.assistantHash);
        await api.LibraTurnWorldline.observe(scope,[pair(1),{...pair(2),assistantText:'rerolled'}],{now:2000});
        worldlineState=api.LibraTurnWorldline.get(scope);
        corpus.push(fixture.make('old-variant',fixture.text[q.memoryLanguage].origin,{imp:10,vh:old.assistantHash}));forbidden.push('old-variant');
      }
      const signed=await ME.prepareMemory({content:fixture.text[q.memoryLanguage].origin,importance:10},2,[],[],null,{id:'foreign-chat'},'offline-source',{scopeKey:'foreign-scope',sourceHash:'offline-source'});
      signed.key='foreign-signed';
      if(!ME.inspectRecallEligibility(signed,{currentTurn:40,scopeKey:'foreign-scope'}).eligible)throw new Error('Foreign-scope positive control is invalid');
      corpus.push(signed);forbidden.push(signed.key);
      // Stable per-query rotation avoids placing the ground truth first in every graph.
      const rotation=crypto.createHash('sha256').update(q.id).digest()[0]%corpus.length;
      corpus.push(...corpus.splice(0,rotation));
      const original=JSON.stringify(corpus),eligibility={currentTurn:40,scopeKey:scope,worldlineState};
      const eligible=ME.filterRecallEligibleEntries(corpus,eligibility).entries;
      api.MemoryState._activeScopeKey=scope;
      H.cacheHybridScopeIndex(H.buildHybridScopeIndexFromEntries(eligible,{scopeKey:scope,currentTurn:40}),scope);
      trace.input=ids(corpus);
      const beforeCalls=networkAttempts,beforeProvider=embeddingAttempts,start=performance.now();
      const selected=await ME.retrieveMemories(q.query,40,corpus,{embeddingAllowed:false,scopeKey:scope,worldlineState,effectiveLorebook:corpus,focusNames:q.focusNames||[]},4);
      const latencyMs=performance.now()-start,selectedIds=ids(selected),debug=ME.getLastRetrievalDebug();
      trace.final=selectedIds;
      const stages=['protected','scope','hybrid','graph_overlap','detail'];
      const coverage=Object.fromEntries(stages.map(stage=>[stage,q.relevant.length?q.relevant.filter(id=>(trace[stage]||[]).includes(id)).length/q.relevant.length:null]));
      const signals=trace.embeddingSignals||[];
      coverage.embedding_signal=q.relevant.length?q.relevant.filter(id=>signals.some(x=>x.key===id&&x.reasons.length>0)).length/q.relevant.length:null;
      coverage.accepted=q.relevant.length?q.relevant.filter(id=>trace.scoreDetails?.some(x=>x.key===id&&x.accepted)).length/q.relevant.length:null;
      const firstCandidateLoss=q.relevant.length?(stages.find(stage=>coverage[stage]<1)||'none'):'no_expected_memory';
      const recovered=q.relevant.some(id=>selectedIds.includes(id));
      const finalDrop=q.relevant.length?(recovered?'recalled':debug.domainGuardBlocked?'query_suppression':coverage.detail<1?'candidate_discovery':coverage.accepted<1?'evidence_or_threshold':'selection'):(selectedIds.length?'unexpected_recall':'abstained_expected');
      rows.push({...q,trace:clone(trace),anchors:Array.from(debug.exactAnchors||[]),negationTerms:Array.from(debug.queryPlan?.excludedTerms||[]),querySuppressed:!!debug.domainGuardBlocked,coverage,firstCandidateLoss,finalDrop,graphRecovered:q.relevant.length>0&&coverage.hybrid<1&&coverage.graph_overlap===1,selected:selectedIds,metrics:metrics(selectedIds,q.relevant,forbidden,4),excludedReturned:selectedIds.filter(id=>(q.excluded||[]).includes(id)),latencyMs,externalCalls:networkAttempts-beforeCalls,providerCalls:embeddingAttempts-beforeProvider,canonicalMutated:original!==JSON.stringify(corpus),safety:{checked:true,forbidden,protectedRejected:forbidden.filter(id=>!(trace.protected||[]).includes(id)),violations:selectedIds.filter(id=>forbidden.includes(id))},pipeline:{scope:debug.hybridMemoryEngine?.scopeIndex,hybrid:debug.hybridMemoryEngine,graph:debug.hmeAssociativeGraph,embedding:debug.embeddingPrefilter}});
    }
    externalCalls+=networkAttempts;providerCalls+=embeddingAttempts;
    const main=rows.filter(x=>!x.supplementary),controls=rows.filter(x=>x.supplementary);
    all.push({name:condition,queries:main,summary:aggregate(main),supplementary:{queries:controls,summary:aggregate(controls)},byCategory:Object.fromEntries([...new Set(main.map(x=>x.category))].map(cat=>[cat,aggregate(main.filter(x=>x.category===cat))]))});
  }
  return {schema:'libra.offline.multilingual_recall.v1',sourceSha256,conditions:all,externalCalls,providerCalls,externalTokens:0,externalCost:0,quality:{linguisticNegationVerified:all.every(c=>c.queries.filter(q=>q.category==='explicit_negation').every(q=>q.negationTerms.length>0&&q.excludedReturned.length===0))},limitations:['Synthetic 40-query main fixture plus 4 separate external-domain controls; no real model proficiency measurement.','Baseline changes only anchor normalization on the selected source artifact; it is not the historical Full(4).js.','Ablation removes intent classifier and domain guards, including origin/family scoring reached through intent. Hybrid kind regex, negation parsing, concept tokenization, exact evidence and all protection gates remain.','Embedding disabled: embedding_signal is lexical/intent/graph eligibility reasons, not vector performance or executed embedding selection.','Provided alias cases use caller focusNames; unmapped transliterations have no added alias table.','Candidate discovery contribution of an independent semantic lane is not measured.','Local single-run latency includes test probes and asynchronous persistence; it is not provider latency.','Negation parser availability is reported per query; zero excluded returns on synthetic fixtures does not verify language understanding.']};
}
module.exports={metrics,transform,run};
if(require.main===module)run().then(report=>{const file=process.argv[2]||path.join(__dirname,'..','test-output','multilingual-recall-offline.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({sourceSha256:report.sourceSha256,externalCalls:report.externalCalls,providerCalls:report.providerCalls,summaries:report.conditions.map(c=>({name:c.name,...c.summary})),report:file},null,2));}).catch(error=>{console.error(error);process.exitCode=1;});
