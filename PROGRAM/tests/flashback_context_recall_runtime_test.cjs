'use strict';
// Protocol and ordering tests with controlled vectors. These do not measure a
// real embedding model's language understanding or real RisuAI behavior.
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const core=require('../tools/recall_conversation.cjs')();
const plain=x=>JSON.parse(JSON.stringify(x));
(async()=>{
 const f=await createFixture({arguments:{hook_recall_timeout_ms:'10000'}});
 try{
  const t=f.api._test,sel=f.api._selectionTest;
  const latest='그럼 약속했던 곳으로 갈게.';
  const scene=[{role:'user',chatId:'scene-user',content:'연우와의 이야기를 이어간다.'},{role:'assistant',chatId:'scene-assistant',content:'해가 저물자 그녀가 외투를 집어 든다.'}];
  const context=t.buildSceneContextQuery(latest,scene,{...await f.api.loadSettings(),recallContextMessages:6});
  assert.equal(context.messageCount,2,'Completed live U+A remains in context when new input is not in live chat');
  assert.ok(context.text.includes(scene[0].content)&&context.text.includes(scene[1].content)&&context.text.includes(latest),'No token-overlap gate');
  assert.ok(context.text.indexOf(scene[0].content)<context.text.indexOf(scene[1].content));
  const outgoing=[{role:'system',content:'SYSTEM MUST NOT ENTER EMBEDDING'},...scene,{role:'user',chatId:'current-user',content:latest}];
  const direct=t.buildSceneContextQuery(latest,outgoing,{recallContextMessages:6,contextualRecall:true},{sourceKind:'request'});
  assert.equal(direct.messageCount,2);assert.ok(!direct.text.includes('SYSTEM MUST'));
  assert.equal(direct.text.split(latest).length-1,1,'Current input is labeled exactly once');
  const reroll=t.buildSceneContextQuery(latest,[...outgoing,{role:'assistant',content:'REJECTED RESPONSE'}],{recallContextMessages:6,contextualRecall:true},{sourceKind:'request'});
  assert.ok(!reroll.text.includes('REJECTED RESPONSE'));
  assert.equal(t.buildSceneContextQuery(latest,outgoing,{recallContextMessages:0,contextualRecall:true}).text,'');
  assert.equal(t.buildSceneContextQuery('"좋아요."',scene,{recallContextMessages:6,contextualRecall:true}).messageCount,2,'Quoted RP dialogue is not an empty context request');
  assert.equal(core.build('now',[{role:'assistant',body:'new'},{role:'tool',body:'private'}],{maxMessages:2}).recent,'ASSISTANT: new');
  assert.ok(!core.build('now',[{role:'assistant',body:'older '.repeat(100)},{role:'assistant',body:'new'}],{maxChars:25}).recent.includes('older'),'Drop oldest whole messages at budget boundary');
  const longScene=t.buildSceneContextQuery(latest,[{role:'assistant',content:'바람이 조용히 불었다. '.repeat(200)+'마지막에 연우가 목적지를 바꿨다.'}],{recallContextMessages:5,contextualRecall:true});
  assert.ok(longScene.text.includes('마지막에 연우가 목적지를 바꿨다.'),'Do not cut every assistant at 1500 characters before embedding');
  const oversized=core.build(latest,[{role:'assistant',body:'x'.repeat(8000)+'ending'}],{maxChars:6000});
  assert.ok(oversized.recent.endsWith('ending')&&oversized.truncated&&oversized.entries[0].partial);
  assert.ok(oversized.recent.length<=6000&&oversized.recent.includes('[Earlier part omitted]'));
  const cfg=t.normalizeSettings({...await f.api.loadSettings(),embeddingProvider:'openai_compat',embeddingModel:'context-test',embeddingUrl:'https://fixture.invalid/v1',embeddingDimensions:3,embeddingMaxRetries:0,embeddingBatchSize:8,fallbackHashEmbedding:false,embeddingEnabled:true,contextualRecall:true,autoEpisodeIndex:false,episodeIndexEnabled:false,currentSceneTailEnabled:false,topK:1,minScore:.1,mmrEnabled:false,recallContextMessages:6});
  await t.saveEmbeddingKeyLocal('offline-fixture-key');await f.api.saveSettings(cfg);
  const target='연우는 별을 관측하는 탑에서 세린과 만나기로 했다. 그 합의는 며칠 전에 이루어졌다.';
  const distractor='그럼 약속했던 곳으로 갈게라는 말은 발성 연습 문장이었다.';
  const requests=[];
  f.host.nativeFetch=async(url,init)=>{
    const body=JSON.parse(init.body),inputs=Array.isArray(body.input)?body.input:[body.input];requests.push(inputs);
    // Assigned fixture vectors intentionally put contextual evidence above a
    // current-input exact-word distractor. They are not a semantic oracle test.
    const embedding=x=>String(x).startsWith('RECENT CONVERSATION')||String(x).includes(target)?[1,0,0]:String(x).includes('NOT_RELATED_QUERY')?[0,0,1]:[0,1,0];
    return new Response(JSON.stringify({data:inputs.map((x,index)=>({index,embedding:embedding(x)}))}),{status:200});
  };
  f.currentChat.message=[{role:'user',chatId:'u1',data:'일정에 대해 말한다.'},{role:'assistant',chatId:'a1',data:target},{role:'user',chatId:'u2',data:'발음 연습.'},{role:'assistant',chatId:'a2',data:distractor}];f.currentChat.messages=f.currentChat.message;
  await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
  const scope=await f.api.resolveCurrentScope();
  const before=JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records);
  requests.length=0;
  const raw=await sel.prepareFlashbackRecall(latest,cfg,scope,{currentUser:latest,messages:outgoing,liveMessages:scene});
  const plan=sel.selectFlashbackEvidencePlan(raw,cfg,3000);
  assert.equal(raw.contextualRecall.mode,'semantic_embedding');
  assert.equal(requests.length,1,'One embedding request for the whole conversation');
  assert.equal(requests[0].length,1,'No separately weighted current-input query');
  assert.ok(requests[0][0].includes(scene[0].content)&&requests[0][0].includes(scene[1].content)&&requests[0][0].includes(latest));
  assert.equal(raw.queryType,'context');assert.equal(raw.temporalIntent,'unspecified');
  // Hybrid recall: keyword arms run beside the dense arm and only add a bounded
  // rank-based boost; the retired hash recovery arm never runs.
  assert.equal(raw.diagnostics.candidateArms.hashRecovery,0,'No hash recovery arm in semantic recall');
  assert.equal(plan.items.length,1);assert.ok(plan.text.includes(target),'The complete relation is retained through final injection selection');
  assert.ok(!plan.text.includes(distractor),'Exact word priority cannot override contextual ranking');
  const repeat=await sel.prepareFlashbackRecall(latest,cfg,scope,{currentUser:latest,messages:outgoing,liveMessages:scene});
  assert.equal(requests.length,1,'Warm identical context hits query cache');
  await sel.prepareFlashbackRecall(latest,cfg,scope,{currentUser:latest,messages:outgoing,liveMessages:[...scene.slice(0,1),{role:'assistant',content:'다른 대화로 변경됐다.'}]});
  assert.equal(requests.length,2,'Changed scene cannot reuse the old contextual vector');
  const absent=await sel.prepareFlashbackRecall('NOT_RELATED_QUERY',cfg,scope,{currentUser:'NOT_RELATED_QUERY'});
  assert.equal(sel.selectFlashbackEvidencePlan(absent,cfg,3000).items.length,0,'No arbitrary top-one when semantic relevance is below threshold');
  const semanticItem=raw.records.find(item=>item.record.text.includes(target));
  assert.ok(semanticItem?.components.contextualSemantic);
  const signals=t.recallSemanticSignals(semanticItem.record,[1,0,0],cfg,{queryProvider:'openai_compat',queryModel:'context-test',sceneContext:{active:true,vector:[0,1,0],modelUsed:'different-model',supportWeight:.75}});
  assert.equal(signals.sceneContextComparable,false,'Different context embedding space cannot influence rank');
  assert.equal(signals.vectorComparable,true,'The mismatch test otherwise uses a compatible current-query vector');
  const distractorRecord=(await t.loadScopeRecords(scope.scopeKey)).records.find(record=>record.text.includes(distractor));
  assert.ok(distractorRecord);const other={record:distractorRecord};
  const mmr=sel.selectFlashbackEvidencePlan({scopeKey:scope.scopeKey,queryText:latest,records:[
    {...semanticItem,score:.8,components:{contextualSemantic:true,semanticCosine:.8}},
    {...other,score:.7,components:{contextualSemantic:true,semanticCosine:.7,exactArm:1,currentSceneTail:1}}
  ]},{...cfg,mmrEnabled:true},3000);
  assert.ok(mmr.text.includes(target),'MMR must not discount only the non-keyword candidate');
  const mixed=sel.selectFlashbackEvidencePlan({scopeKey:scope.scopeKey,queryText:latest,records:[
    {...semanticItem,score:.6,components:{contextualSemantic:true,semanticCosine:.6}},
    {...other,score:.99,components:{contextualSemantic:false,exactArm:1,currentSceneTail:1}}
  ]},cfg,3000);
  assert.ok(mixed.text.includes(target),'A lexical fallback score is not comparable to semantic relevance');
  const manifest=await t.loadScopeManifest(scope.scopeKey);
  const shardRows=Array.from({length:8},(_,i)=>({...semanticItem.record,id:'shard-'+i,sourceHash:'shard-'+i,text:i===0?target:distractor,vector:i===0?[1,0,0]:[0,1,0],responseTurnIndex:i+1,pairIndex:i+1}));
  const summaries=shardRows.map((r,i)=>t.buildRecallShardSummary([r],i,cfg));
  const routed=t.selectRecallShardIndexes({...manifest,shardCount:8,shardSummaries:summaries,responseTurnMax:8},latest,[1,0,0],'openai_compat','fact',{...cfg,recallFullScanThreshold:1,recallShardLimit:2},'context-test');
  assert.equal(routed.fullScan,false);assert.ok(routed.indexes.includes(0),'Semantic shard survives many exact-word distractors before record loading');
  assert.equal(JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records),before,'Recall never rewrites memories or vectors');
  assert.ok(sel.selectFlashbackEvidencePlan(repeat,cfg,10).text.length<=10,'Physical output budget remains enforced');
  f.currentChat.message.push(...scene.map((m,i)=>({role:m.role,chatId:'scene-'+i,data:m.content})));f.currentChat.messages=f.currentChat.message;
  const delivered=await sel.beforeRequest(outgoing,'model');
  assert.ok(delivered.some(m=>m.flashbackDynamic&&m.content.includes(target)),'Real beforeRequest returns semantically selected evidence');
  assert.equal((await f.api.debugState()).lastRecall.delivery.stage,'returned_to_hook');
  assert.equal((await f.api.debugState()).lastRecall.contextualRecall.mode,'semantic_embedding');
  assert.equal(JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records),before,'BeforeRequest preserves durable evidence');
  f.host.nativeFetch=async()=>{throw Error('offline fixture unavailable');};
  const degraded=await sel.prepareFlashbackRecall('새 실패 질의',cfg,scope,{currentUser:'새 실패 질의',liveMessages:scene});
  assert.equal(degraded.modelReadiness.status,'lexical_fallback');assert.equal(degraded.modelReadiness.reason,'query_failed');assert.equal(degraded.modelReadiness.ready,false);{const storedIds=new Set(JSON.parse(before).map(r=>r.id));assert.ok(degraded.records.every(item=>storedIds.has((item.record||item).id)),'keyword fallback returns only stored, admitted records (scene keywords may match)');}assert.equal(JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records),before,'query failure preserves durable evidence');
  const off={...cfg,embeddingProvider:'hash',embeddingModel:'hash-3'};
  assert.equal(t.recallSemanticSignals({...semanticItem.record,provider:'hash',model:'hash-3',vector:[1,0,0]},[1,0,0],off,{queryProvider:'hash',queryModel:'hash-3'}).contextualSemantic,false,'Hash vectors are not labeled semantic');
  console.log('flashback_context_recall_runtime_test: PASS (offline protocol and ranking; real model NOT_RUN)');
 }finally{await f.dispose();}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
