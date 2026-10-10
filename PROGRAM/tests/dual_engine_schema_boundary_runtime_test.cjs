'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{const report={hayaku:[],flashback:[]};
 const h=await createHayakuRuntime({autoRepair:false});try{
  const t=h.hayaku._test,s={...h.hayaku.settings(),hierarchicalEpisodeMemoryEnabled:false,retrievalRecentContext:{topics:[]}};
  for(const field of ['secrets','secret_boundaries','hiddenKnowledge','pov_memories','povMemories']){
   const p=createValidPacket();p.entity.characters=[{name:'AuditOwner'},{name:'AuditVisitor'}];
   const marker='The concealed access code is copper-lantern';
   p.entity[field]=[{id:'restricted-record',summary:marker,ownerEntityId:'AuditOwner',holderEntityIds:['AuditOwner']}];
   const packet={raw:JSON.stringify(p),hash:'privacy-'+field,messageIndex:1,targetPairIndex:1},store=t.emptyStore();
   t.ingestPacket(store,packet.raw,packet.hash,{messageIndex:1});t.rebuildIndex(store,{settings:s,deadlineAt:Date.now()+5000});
   const query='AuditVisitor asks about the concealed access code';
   const canonical=t.localRecallCandidates({index:store.index},query,s);
   await t.localRecallPrepareSources([packet],store,{...s,retrievalCurrentQuery:query},'privacy-'+field,Date.now()+5000);
   const sourceRows=store._recallSourceRows.filter(r=>r.publicText.includes(marker));
   const candidates=await t.searchIndexCompositeRecall(store,query,s),plan=t.selectHayakuEvidencePlan(candidates,query,s,15000);
   const ownerQuery='AuditOwner recalls the concealed access code';
   const ownerPlan=t.selectHayakuEvidencePlan(await t.searchIndexCompositeRecall(store,ownerQuery,s),ownerQuery,s,15000);
   report.hayaku.push({kind:'knowledge_boundary',field,engineRows:store.index.filter(r=>r.category==='secret'||r.category==='pov_memory').map(r=>({category:r.category,visibility:r.visibility})),canonicalAdmits:canonical.some(r=>r.publicText.includes(marker)),sourceRows:sourceRows.map(r=>({category:r.category,visibility:r.visibility})),finalAdmits:plan.text.includes(marker),ownerAdmits:ownerPlan.text.includes(marker),sourceUnchanged:packet.raw===JSON.stringify(p)});
  }
 }finally{h.dispose();}
 for(const mode of ['ids','no_ids_one_pair','no_ids_two_pairs','wrapper','no_ids_prefill','no_ids_memory_suffix']){
  const f=await createFixture();try{
   const t=f.api._test,sel=f.api._selectionTest,cfg=t.normalizeSettings({...await f.api.loadSettings(),embeddingProvider:'openai_compat',embeddingModel:'boundary-audit',embeddingUrl:'https://fixture.invalid/v1',embeddingDimensions:3,embeddingMaxRetries:0,fallbackHashEmbedding:false,embeddingEnabled:true,contextualRecall:true,autoEpisodeIndex:false,episodeIndexEnabled:false,currentSceneTailEnabled:false,recallContextMessages:6});
   await t.saveEmbeddingKeyLocal('offline-fixture-key');await f.api.saveSettings(cfg);
   const inputs=[];f.host.nativeFetch=async(url,init)=>{const body=JSON.parse(init.body),batch=Array.isArray(body.input)?body.input:[body.input];inputs.push(...batch);return new Response(JSON.stringify({data:batch.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200});};
   const history=[{role:'user',chatId:'u1',content:'Open the outer gate.'},{role:'assistant',chatId:'a1',content:'The outer gate opened beside a stone bridge.'}];
   if(mode==='no_ids_two_pairs')history.push({role:'user',chatId:'u2',content:'Cross the bridge.'},{role:'assistant',chatId:'a2',content:'A locked iron door stood ahead.'});
   f.currentChat.message=history.map(m=>({...m,data:m.content}));f.currentChat.messages=f.currentChat.message;
   await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
   const scope=await f.api.resolveCurrentScope(),before=JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records);
   let outgoing=[...history,{role:'user',chatId:'u-current',content:'Inspect the bronze lock.'}];
   if(mode!=='ids')outgoing=outgoing.map(({chatId,...m})=>m);
   if(mode==='wrapper')outgoing[outgoing.length-1].content='<current_message>Inspect the bronze lock.</current_message>';
   if(mode==='no_ids_prefill')outgoing.push({role:'assistant',content:'The scene continues:'});
   if(mode==='no_ids_memory_suffix')outgoing.push({role:'user',content:'[VECTOR RAG MEMORY] Archived supporting material.'});
   const resolved=t.resolveFlashbackCurrentTurn(outgoing);inputs.length=0;t.invalidateQueryEmbeddingCache();
   await sel.beforeRequest(outgoing,'model');
   const state=await f.api.debugState(),pending=t.pendingCaptureRuntimeSnapshot();
   report.flashback.push({mode,expectedCurrent:'Inspect the bronze lock.',resolved:{text:resolved.text,source:resolved.source,requestIndex:resolved.requestIndex,terminalPrefillIndex:resolved.terminalPrefillIndex},embeddingInputs:inputs.slice(),lastRecall:{skipped:state.lastRecall?.skipped,reason:state.lastRecall?.reason,delivery:state.lastRecall?.delivery?.stage},pendingTurns:pending.pendingTurns,recordsUnchanged:JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records)===before,realProviderCalls:0});
  }finally{await f.dispose();}
 }
 assert.ok(report.hayaku.every(r=>!r.finalAdmits&&r.ownerAdmits&&r.sourceUnchanged));assert.ok(report.flashback.every(r=>r.resolved.text===r.expectedCurrent&&r.embeddingInputs.some(x=>x.endsWith(r.expectedCurrent))&&r.pendingTurns[0]?.latestUser===r.expectedCurrent&&r.recordsUnchanged&&r.lastRecall.delivery==='returned_to_hook'));console.log('dual_engine_schema_boundary_runtime_test: PASS');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
