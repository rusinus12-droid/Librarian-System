'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{
 const h=await createHayakuRuntime({autoRepair:false,arguments:{memory_suite_server_mode:'plugin_only'}});
 const f=await createFixture();
 try{
  const ht=h.hayaku._test,ft=f.api._selectionTest;
  const hs={...h.hayaku.settings(),memoryLanguage:'en',maxItemsPerAxis:4,rawRecallMaxChars:3000};
  const settings={...await f.api.loadSettings(),topK:2,mmrEnabled:false,heuristicRecall:true,contradictionBundleEnabled:true};
  const make=(id,turn,value,body,linked=false)=>({record:{id,sourceType:'response',text:body,turnIndex:turn,pairIndex:turn,responseTurnIndex:turn,
   turnRange:{start:turn,end:turn},structuredStateFacts:value?[{entity:'Alice',property:'location',value,turn,
    ...(linked?{evidenceText:body,evidenceStart:0,evidenceEnd:body.length}:{})}]:[]},score:.8,components:{exactArm:1}});
  const recall={records:[make('before',1,'tower','Bob saw a tower. Alice waved.'),make('after',2,'garden','Bob saw a garden. Alice waved.')],
   scopeKey:'fixture',queryText:'Compare Alice before and now.',temporalIntent:'compare',truthIntent:'disputed',currentStateFacts:[]};
  const unknown=ft.selectFlashbackEvidencePlan(recall,settings,2500);
  assert.equal(unknown.items.length,2,'Uncertain relation does not discard source evidence');
  assert.ok(unknown.requirements.length&&unknown.requirements.every(r=>r.status==='support_unknown'),'Value words do not establish Alice location');
  const linked={...recall,records:[make('before',1,'tower','Alice is in the tower.',true),make('after',2,'garden','Alice is in the garden.',true)]};
  assert.ok(ft.selectFlashbackEvidencePlan(linked,settings,2500).requirements.every(r=>r.status==='complete'),'Exact source links support the delivered relation');
  for(const damage of [{evidenceEnd:9999},{evidenceOffsetsInvalidated:true},{authority:'CURRENT_USER_OVERLAY'},{evidenceText:'A different source sentence.'}]){
   const broken={...linked,records:linked.records.map(item=>({...item,record:{...item.record,structuredStateFacts:item.record.structuredStateFacts.map(fact=>({...fact,...damage}))}}))};
   const plan=ft.selectFlashbackEvidencePlan(broken,settings,2500);
   assert.equal(plan.items.length,2);
   assert.ok(plan.requirements.every(r=>r.status==='support_unknown'),'Unusable exact links remain unknown');
  }
  const narrow=ft.selectFlashbackEvidencePlan(linked,{...settings,topK:1},2500);
  assert.equal(narrow.items.length,1);assert.ok(narrow.text.length>0);
  assert.ok(narrow.requirements.every(r=>r.status==='partial'));
  const onlyPair={...linked,records:linked.records.map(item=>({...item,components:{}}))};
  const none=ft.selectFlashbackEvidencePlan(onlyPair,{...settings,topK:1},2500);
  assert.equal(none.items.length,0,'No independent goal: do not arbitrarily split the required pair');
  assert.ok(none.requirements.every(r=>r.status==='unmet'));
  const costRecall={...recall,queryText:'Alice',temporalIntent:'unspecified',truthIntent:'unspecified',records:[
   make('a-long',1,'','Alice left a detailed note about the royal archive. '+ 'The library contains many shelves of old records. '.repeat(5)),
   make('z-short',2,'','Alice left a note.')]};
  for(const records of [costRecall.records,[...costRecall.records].reverse()]){
   const plan=ft.selectFlashbackEvidencePlan({...costRecall,records},{...settings,topK:1},2500);
   assert.equal(plan.items[0].record.id,'z-short','Actual rendered cost precedes stable ID on equal priority/score');
  }
  const priority={...costRecall,records:costRecall.records.map((item,index)=>index===0?{...item,score:.2,components:{...item.components,currentSceneTail:1}}:item)};
  assert.equal(ft.selectFlashbackEvidencePlan(priority,{...settings,topK:1},2500).items[0].record.id,'z-short','Explicit focus uses relevance before automatic current-scene preference');
  assert.equal(ft.selectFlashbackEvidencePlan({...priority,queryText:'Continue.'},{...settings,topK:1},2500).items[0].record.id,'a-long','Continuation retains existing current-scene preference');
  const overlapRecords=['a','b','c','d','e'].map((id,index)=>({
   ...make(id,index+1,'',`Alice recorded rule ${id.toUpperCase()}.`),score:[1,1,.5,.7,.7][index]
  }));
  const properties=[['first','second'],['first'],['second'],['third'],['third']];
  overlapRecords.forEach((item,index)=>item.record.structuredStateFacts=properties[index].map(property=>({entity:'Alice',property,value:item.record.id})));
  const overlap=ft.selectFlashbackEvidencePlan({...recall,queryText:'How have the rules changed?',temporalIntent:'unspecified',truthIntent:'unspecified',records:overlapRecords},{...settings,topK:4},4000);
  assert.deepEqual(Array.from(overlap.items,item=>item.record.id).sort(),['a','b','d','e'],'An already-picked high-score member cannot inflate the next overlapping group');
  const row={axis:'world',category:'world_rule',id:'rule',publicRef:'rule',publicText:'Magic is forbidden inside the royal academy.',score:.9,importance:.9,scoreBreakdown:{relevanceEvidence:.8}};
  const query='What are the academy rules?';
  const plan=ht.selectHayakuEvidencePlan(ht.prepareHayakuRecallRows([row],query,hs,{},[],[]),query,hs,4000);
  const scope=await ht.currentChatScope(), token=ht.beginHayakuRecallRequest(scope.key);
  assert.equal(ht.hayakuRequestCurrent(token),true);
  await ht.currentChatScope();assert.equal(ht.hayakuRequestCurrent(token),true,'Same scope observations preserve the request');
  const oldId=h.chat.id;
  h.chat.id='conformance-switched-chat';h.chat.chatId=h.chat.id;
  const changed=await ht.currentChatScope();assert.notEqual(changed.key,scope.key);
  assert.equal(ht.hayakuRequestCurrent(token),false,'Observed chat switch without another request expires recall');
  assert.equal(ht.publishHayakuRecallDelivery(plan,token,query,hs),false);
  h.chat.id=oldId;h.chat.chatId=oldId;await ht.currentChatScope();
  assert.equal(ht.hayakuRequestCurrent(token),false,'Switching back cannot revive a cancelled request');
  const messages=[{role:'user',content:'Describe the academy.'},{role:'assistant',content:row.publicText}];
  const focus=ht.buildRecentContextFocus(messages,query,hs), cfg={...hs,retrievalScopeKey:scope.key,retrievalRecentContext:focus};
  assert.equal(ht.publishHayakuRecallDelivery(plan,ht.beginHayakuRecallRequest(scope.key),query,cfg),true);
  assert.ok(ht.applyHayakuRecallStability([row],query,cfg)[0].score>row.score,'The unchanged delivered query still benefits');
  const next='Who founded the academy?', nextFocus=ht.buildRecentContextFocus(messages,next,hs);
  assert.equal(focus.hash,nextFocus.hash,'Exercise changed query with identical recent-chat hash');
  assert.equal(ht.applyHayakuRecallStability([row],next,{...cfg,retrievalRecentContext:nextFocus})[0].score,row.score);
  assert.ok(ht.applyHayakuRecallStability([row],'Continue.',cfg)[0].score>row.score,'Referential continuation remains eligible');
  assert.equal(ht.applyHayakuRecallStability([row],'Continue.',{...cfg,retrievalRecentContext:{...focus,reason:'topic_or_scene_shift'}})[0].score,row.score);
  assert.equal(ht.applyHayakuRecallStability([row],query,{...cfg,recallStabilityEnabled:false})[0].score,row.score);
  assert.equal(ht.applyHayakuRecallStability([row],query,{...cfg,retrievalRecentContext:{...focus,hash:'another-scene'}})[0].score,row.score);
  const rawLong={id:'a-long',text:'Alice wrote a detailed note about the royal archive. '.repeat(10),pairIndex:1,score:.8};
  const rawShort={id:'z-short',text:'Alice left a note.',pairIndex:2,score:.8};
  const rawInput=records=>({entity:[],world:[],narrative:[],planner:[],rawRecoveryEvidence:records});
  const longOnly=ht.selectHayakuEvidencePlan(rawInput([rawLong]),'Alice',hs,2000);
  for(const records of [[rawLong,rawShort],[rawShort,rawLong]]){
   const choice=ht.selectHayakuEvidencePlan(rawInput(records),'Alice',hs,longOnly.text.length);
   assert.deepEqual(Array.from(choice.rawDeliveredIds),['z-short'],'HAYAKU compares actual incremental rendered cost');
  }
  const groupRows=['a','b','c','d','e'].map((id,index)=>({...row,id,publicRef:id,publicText:[
   'Magic is forbidden inside the royal academy.', 'The harbor closes its gates at sunset.',
   'Visitors must leave their weapons outside the palace.', 'Only licensed healers can enter the temple.',
   'Merchants pay silver coins to cross the eastern bridge.'
  ][index],score:[1,1,.5,.7,.7][index]}));
  const pairQuery='Compare these rules before and now.';
  const groups=ht.prepareHayakuRecallRows(groupRows,pairQuery,hs,{},[],[
   {id:'ab',earliest:groupRows[0],latest:groupRows[1]}, {id:'ac',earliest:groupRows[0],latest:groupRows[2]},
   {id:'de',earliest:groupRows[3],latest:groupRows[4]}
  ]);
  const hp=ht.prepareHayakuEvidenceUnits(groups,pairQuery,hs);
  assert.equal(hp.units.length,5,'All distinct rule units must survive preparation');
  // Isolate the group-ranking contract from unrelated query weighting.
  hp.units.forEach(unit=>unit.weight=[1,1,.5,.7,.7]['abcde'.indexOf(unit.origins[0].row.id)]);
  const selected=ht.selectHayakuEvidencePlan(groups,pairQuery,hs,5000);
  assert.deepEqual(Array.from(selected.plan.units,unit=>unit.origins[0].row.id).sort(),['a','b','d','e'],'HAYAKU ranks overlapping groups using only newly added members');
  assert.equal(h.llmCalls.length,0,'No extra analysis model is used');
  console.log('recall_selection_conformance_runtime_test: PASS');
 }finally{await h.dispose();await f.dispose();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

