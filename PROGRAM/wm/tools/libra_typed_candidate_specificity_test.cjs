'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./libra_typed_recall_queue_test.cjs'),{policy}=require('./libra_typed_graph_discovery_test.cjs');
async function setFixture(topic,subject){
 const r=await runtime(null,{admittedHost:true}),facts=['Glacial chest holds a violet compass.','Amber alcove contains a silver sextant.','Jade cabinet preserves an ivory astrolabe.'];
 r.chat.localLore=Array.from({length:100},(_,i)=>{const turn=i+1,summary=[1,5,9].includes(turn)?facts[[1,5,9].indexOf(turn)]:'Daily '+topic+' note '+turn+' confirmed.';
  const payload={schema:'libra.memory.compact_turn.v1',summary,recallAnchors:[{hint:topic},{hint:subject}],mentionedEntityNames:[subject],directEvidenceSnippets:[summary]};
  return {comment:'lmai_memory',key:'lmai_memory::'+turn,content:'[META:'+JSON.stringify({t:turn,ttl:-1,imp:7,ent:[subject]})+']\n'+JSON.stringify(payload)};
 });
 r.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode='off';return {r,facts};
}
for(const [topic,subject]of [['orchard','Caretaker'],['observatory','Astronomer']])test('source-supported '+topic+' set retains distinct old facts before lane truncation',async()=>{
 const {r,facts}=await setFixture(topic,subject),p=policy(),snapshot=r.snap({currentTurn:100}),all=r.corpus.enumerate(snapshot);
 const lane=await r.context.__QUEUE_TEST__.dual.searchHeuristic('Which '+topic+' records are established?',all,snapshot,p);
 const text=lane.hits.map(hit=>all.find(x=>x.identity===hit.identity).text).join('\n');
 for(const fact of facts)assert(text.includes(fact),'distinct source fact lost before bounded lane: '+fact);
 assert(lane.hits.length<=p.laneDepth);assert.equal(r.state.calls.length,0);
});
test('specific numeric query and explicit exclusion retain their source/currentness contracts',async()=>{
 const {r}=await setFixture('workshop','Mechanic'),p=policy(),snapshot=r.snap({currentTurn:100}),all=r.corpus.enumerate(snapshot);
 const first=all.find(x=>x.locator.id==='1');p.exclusions={identities:[first.identity]};
 const lane=await r.context.__QUEUE_TEST__.dual.searchHeuristic('Recall Glacial chest violet compass',all,snapshot,p);
 assert(!lane.hits.some(x=>x.identity===first.identity));
 const numeric=await r.context.__QUEUE_TEST__.dual.searchHeuristic('Daily workshop note 37',all,snapshot,policy());
 assert(numeric.hits.some(x=>JSON.parse(x.identity).at(-1)==='37'),'numeric evidence must remain discoverable');
 assert.equal(r.state.calls.length,0);
});
