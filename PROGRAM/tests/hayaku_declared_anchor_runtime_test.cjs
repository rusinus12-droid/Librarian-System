'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
(async()=>{const h=await createHayakuRuntime({autoRepair:false});try{
const t=h.hayaku._test,s={...h.hayaku.settings(),hierarchicalEpisodeMemoryEnabled:false};
const phrases=['열쇠와 은색 상자','a silver key beside a tower','钥匙 银色 箱子','鍵と銀色の箱','a stranger regrets a broken promise','누군가 두려워하며 상처를 숨겼다'];
for(const [index,phrase]of phrases.entries()){
  const p=createValidPacket(),store=t.emptyStore();p.meta.summary_memory={summary:phrase,recallAliases:['DeclaredAlias'+index],canonicalAnchors:['object:custom_'+index]};
  t.ingestPacket(store,JSON.stringify(p),'explicit-'+index,{messageIndex:1});
  const summary=store.memory.summaries.find(r=>r.sourcePacket==='explicit-'+index)||store.memory.summaries.find(r=>JSON.stringify(r).includes('DeclaredAlias'+index));
  assert(summary,'summary retained');
  const serialized=JSON.stringify(summary);
  assert(serialized.includes('object:custom_'+index),'declared anchor retained');assert(serialized.includes('DeclaredAlias'+index),'declared alias retained');
  for(const token of ['object:key','color:silver','place:tower','psychology:withdrawal','psychology:collapse'])assert(!serialized.includes(token),'invented anchor '+token);
  t.rebuildIndex(store,{settings:s,deadlineAt:Date.now()+5000});
  const q='DeclaredAlias'+index,plan=t.selectHayakuEvidencePlan(await t.searchIndexCompositeRecall(store,q,s),q,s,14000);assert(plan.text.includes(phrase),'declared alias must reach original summary');
  assert.equal(t.crossLingualTokensForText(phrase).length,0);
}
assert.equal(h.llmCalls.length,0);console.log(JSON.stringify({cases:phrases.length,declaredAliasesRecall:true,explicitAnchorsPreserved:true,inferredAnchors:false,modelCalls:0}));
}finally{await h.dispose();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
