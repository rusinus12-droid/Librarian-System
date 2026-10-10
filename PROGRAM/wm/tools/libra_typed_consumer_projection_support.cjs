'use strict';
const assert = require('node:assert/strict');
const {runtime} = require('./libra_typed_recall_queue_test.cjs');
const fixture = require('./fixtures/typed-recall-v1.json');
const clone = value => JSON.parse(JSON.stringify(value));
const expose = code => {
  const close = code.lastIndexOf('})();'); assert.ok(close > 0, 'actual bundle closure');
  return code.slice(0, close) + '\n;globalThis.__BINDING_PROJECTION__=typeof enumerateTypedConsumerBindings === "function" ? enumerateTypedConsumerBindings : null;\n' + code.slice(close);
};
async function setup(dist, transformCode = expose, size = 0) {
  const r = await runtime(null, {admittedHost:true, dist, transformCode});
  const scope = r.snap().scopeKey;
  const memories = fixture.memory.map(m => {
    const meta = clone(m.meta);
    r.api.IntegrityMetaManager.annotateMemoryMeta(meta, m.text, {domain:'memory',recordSchema:'libra.memory.entry.v1',recordId:m.id,scopeKey:scope,turn:meta.t});
    return {comment:'lmai_memory',key:'lmai_memory::'+m.id,content:'[META:'+JSON.stringify(meta)+']\n'+m.text};
  });
  const graph = clone(fixture.worldGraph), narrative = clone(fixture.narrative), states = clone(fixture.worldStates);
  narrative.storylines[0].memoryRefs=['promise'];
  states.consolidated=[{id:'summary-4',upToTurn:4,type:'periodic',description:'Checkpoint summary',changes:['Pendant was promised'],entities:['민지']}];
  for (let i=0;i<size;i++) {
    graph.nodes.push(['extra-world-'+i,{id:'extra-world-'+i,parent:'world_main',name:'Extra world '+i,rules:{custom:{rule:'Repeated source '+i+' '.repeat(100)}}}]);
    narrative.storylines.push({id:100+i,arcKey:'extra-'+i,name:'Extra story '+i,turns:[4],memoryRefs:['promise'],continuityBrief:'Repeated narrative source '+i+' '.repeat(100)});
  }
  const codex={scopeKey:scope,worldCodex:[clone(fixture.safetyReview.codexFact),clone(fixture.safetyReview.codexDisabled)],deletedItemKeys:[]};
  const e=(comment,key,record,domain,id)=>r.entry(comment,key,r.signed(record,domain,id));
  r.chat.localLore=[...memories,...fixture.entity.map(v=>e('lmai_entity','lmai_entity::'+v.name,v,'entity',v.name)),
    e('lmai_entity','lmai_entity::현우',{id:'partner',name:'현우',meta:{created:2,aliases:['Partner']}},'entity','현우'),
    e('lmai_relation','lmai_relation::pendant',fixture.relation,'relation',fixture.relation.id),
    e('lmai_world_graph','lmai_world_graph::compact',graph,'world','world_graph'),
    e('lmai_world_states','lmai_world_states::core',states,'world','world_state'),
    e('lmai_world_additional','lmai_world_additional::core',codex,'world','world_additional'),
    e('lmai_narrative','lmai_narrative::core',narrative,'narrative','narrative_state')];
  r.original=clone(r.chat.localLore);
  r.policy=r.context.__QUEUE_TEST__.rollout.begin().policy;
  assert.equal(r.policy.mode,'production');
  r.project=r.context.__BINDING_PROJECTION__;
  r.consumer=r.context.__QUEUE_TEST__.consumers;
  r.snapshot=r.snap(); r.all=r.corpus.enumerate(r.snapshot);
  r.eligible=r.all.filter(u=>r.corpus.adapters[u.family].eligibility(u,r.snapshot).eligible);
  r.select=(family,id,subtype)=>r.eligible.find(u=>u.family===family&&(id===undefined||u.locator.id===id)&&(subtype===undefined||u.subtype===subtype));
  r.reset=()=>{r.chat.localLore=clone(r.original);};
  r.change=(comment,fn,{id,sign=true}={})=>{
    const entry=r.chat.localLore.find(e=>e.comment===comment&&(!id||JSON.parse(e.content).id===id));assert.ok(entry,comment);
    let record=JSON.parse(entry.content);fn(record);
    if(sign){const domain=comment==='lmai_entity'?'entity':comment==='lmai_relation'?'relation':comment==='lmai_narrative'?'narrative':'world';record=r.signed(record,domain,record.id||record.name||{lmai_world_graph:'world_graph',lmai_world_states:'world_state',lmai_world_additional:'world_additional',lmai_narrative:'narrative_state'}[comment]);}
    entry.content=JSON.stringify(record);
  };
  r.compose=(units,baseline=[],guard=()=>true)=>r.consumer.compose({baseline,selection:units.map(unit=>({identity:unit.identity,unit})),snapshot:r.snapshot,policy:r.policy,requestGuard:guard});
  r.finish=(composed,mode='hybrid',snapshot=()=>r.snap(),policy=r.policy)=>r.consumer.finalize({sections:composed.sections,currentSnapshot:snapshot,policy,mode,budget:{maxTokens:100000,maxChars:400000}});
  return r;
}
const retained=['identity','family','subtype','locator','record','entry','parentRecord','scopeKey','contentHash','dependencyHash','representationVersion','text','trim','partial','roles','sourceRefs','lineage'];
const withoutPersistent=unit=>Object.fromEntries(Object.entries(unit).filter(([key])=>!['persistentContentHash','persistentDependencyHash'].includes(key)));
const plain=clone;
module.exports={setup,expose,fixture,clone,plain,retained,withoutPersistent};
