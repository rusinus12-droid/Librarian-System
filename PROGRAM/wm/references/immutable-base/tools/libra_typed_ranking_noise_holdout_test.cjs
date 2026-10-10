'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {runtime}=require('./libra_typed_recall_queue_test.cjs'),{policy}=require('./libra_typed_graph_discovery_test.cjs');
// Independent holdout: neither these facts, names nor their positions occur in
// the earlier orchard/observatory specificity fixture or product ranking code.
const facts=['Copper reliquary contains a pearl lens.','Saffron drawer secures a ceramic dial.','Slate locker shelters a cobalt prism.'],factTurns=[2,7,13];
const makeRow=(turn,topic,subject,summary,extra={})=>({comment:'lmai_memory',key:'lmai_memory::'+turn,
 content:'[META:'+JSON.stringify({t:turn,ttl:-1,imp:7,ent:[subject],...extra})+']\n'+JSON.stringify({schema:'libra.memory.compact_turn.v1',summary,recallAnchors:[{hint:topic},{hint:subject}],mentionedEntityNames:[subject],directEvidenceSnippets:[summary]})});
async function fixture(topic,subject){const r=await runtime(null,{admittedHost:true,dist:process.env.WM_NOISE_HOLDOUT_DIST});r.chat.localLore=Array.from({length:100},(_,i)=>makeRow(i+1,topic,subject,factTurns.includes(i+1)?facts[factTurns.indexOf(i+1)]:'Daily '+topic+' note '+(i+1)+' confirmed.'));r.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode='off';return r}
async function search(r,query,p=policy(),extra=[]){const snapshot=r.snap({currentTurn:100}),all=r.corpus.enumerate(snapshot);const lane=await r.context.__QUEUE_TEST__.dual.searchHeuristic(query,[...all,...extra],snapshot,p);return {lane,all,snapshot}}
const view=lane=>lane.hits.map(x=>({identity:x.identity,rank:x.rank,score:x.score,rawScore:x.rawScore}));
for(const [topic,subject]of [['herbarium','Conservator'],['harbor','Harbormaster']]){
 test(`actual ${topic} caller blocks hidden/excluded/foreign inputs before public ranking`,async()=>{
  const r=await fixture(topic,subject),query='Which '+topic+' records are established?',baseline=await search(r,query);
  r.chat.localLore.push(...Array.from({length:4},(_,i)=>({...makeRow(100,topic,subject,'Private '+topic+' rare payload '+i,{hiddenFromPrompt:true}),key:'lmai_memory::hidden-'+i})),
   ...Array.from({length:4},(_,i)=>({...makeRow(100,topic,subject,'Excluded '+topic+' rare payload '+i),key:'lmai_memory::excluded-'+i})));
  const snapshot=r.snap({currentTurn:100}),all=r.corpus.enumerate(snapshot),excluded=all.filter(x=>x.locator.id.startsWith('excluded-')).map(x=>x.identity),p=policy();p.exclusions={identities:excluded};
  const hidden=all.filter(x=>x.locator.id.startsWith('hidden-'));
  assert.equal(hidden.length,4);for(const unit of hidden){const verdict=r.corpus.adapters.memory.eligibility(unit,snapshot);assert.equal(verdict.eligible,false);assert.equal(verdict.reason,'inactive')}
  const foreign=baseline.all.slice(0,4).map(x=>({...x,scopeKey:'foreign-scope',identity:JSON.stringify(['foreign-scope',x.family,x.subtype,x.locator.id]),text:'Foreign '+topic+' rare payload'}));
  const result=await r.context.__QUEUE_TEST__.dual.searchHeuristic(query,[...all,...foreign],snapshot,p);
  assert.deepEqual(view(result),view(baseline.lane));
  assert.equal(result.trace.scanned,baseline.lane.trace.scanned);
  for(const unit of [...hidden,...all.filter(x=>excluded.includes(x.identity)),...foreign])assert(result.trace.drops.some(x=>x.identity===unit.identity),'missing hard-gate evidence for '+unit.identity);
  for(const unit of foreign)assert(result.trace.drops.some(x=>x.identity===unit.identity&&x.reason==='scope_or_identity'));
  assert.equal(r.state.calls.length,0);
 });
 for(const format of ['hex','uuid','numeric','prefixed'])test(`${topic} broad-question facts survive unrelated unique ${format} IDs in repeated evidence`,async()=>{
  const r=await fixture(topic,subject),query='Which '+topic+' records are established?',baseline=await search(r,query);
  const baselineText=baseline.lane.hits.map(hit=>baseline.all.find(x=>x.identity===hit.identity).text).join('\n');for(const fact of facts)assert(baselineText.includes(fact),'baseline missing '+fact);
  const baselineFinal=await r.context.__QUEUE_TEST__.dual.retrieve(query,baseline.snapshot,null,policy()),baselineSelected=baselineFinal.selection.map(x=>x.unit.text).join('\n');
  for(const fact of facts)assert(baselineSelected.includes(fact),'baseline final selection missing '+fact);
  r.chat.localLore=r.chat.localLore.map((entry,index)=>{
   if(factTurns.includes(index+1))return entry;
   const split=entry.content.indexOf('\n'),payload=JSON.parse(entry.content.slice(split+1));
   const ids=Array.from({length:16},(_,n)=>{const h=crypto.createHash('sha256').update(topic+':'+index+':'+n).digest('hex');
    return format==='hex'?h.slice(0,32):format==='uuid'?h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20,32):format==='numeric'?String(100000000000+index*16+n):'audit_'+h.slice(0,20)});
   payload.summary+=' Audit identifiers: '+ids.join(' ');payload.directEvidenceSnippets=[payload.summary];
   return {...entry,content:entry.content.slice(0,split+1)+JSON.stringify(payload)};
  });
  const after=await search(r,query),text=after.lane.hits.map(hit=>after.all.find(x=>x.identity===hit.identity).text).join('\n');
  for(const fact of facts)assert(text.includes(fact),'unrelated IDs displaced '+fact);
  const final=await r.context.__QUEUE_TEST__.dual.retrieve(query,after.snapshot,null,policy()),selected=final.selection.map(x=>x.unit.text).join('\n');
  for(const fact of facts)assert(selected.includes(fact),'final bounded selection lost '+fact);
  assert(after.lane.hits.length<=policy().laneDepth);assert.equal(r.state.calls.length,0);
 });
}
