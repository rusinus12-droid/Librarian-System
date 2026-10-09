'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const plain=value=>JSON.parse(JSON.stringify(value));

(async()=>{
  const h=await createHayakuRuntime({autoRepair:false,arguments:{memory_suite_server_mode:'plugin_only'}});
  const f=await createFixture();
  try{
    const ft=f.api._selectionTest,ht=h.hayaku._test;
    const hit={record:{id:'one'},score:1};
    assert.equal(ft.reciprocalRankFusion({dense:[hit]},{weights:{dense:0}}).length,0);
    for(const weight of [null,'',false,NaN,-1])assert.equal(ft.reciprocalRankFusion({dense:[hit]},{weights:{dense:weight}})[0].rrfScore,ft.reciprocalRankFusion({dense:[hit]})[0].rrfScore,'Invalid weight uses its default, not implicit zero');
    assert.equal(ft.reciprocalRankFusion({dense:[{record:{id:'same',sourceRevision:1}},{record:{id:'same',sourceRevision:2}}]}).length,2,'Different source revisions are not fused into one identity');
    assert.equal(ft.reciprocalRankFusion({dense:[hit,hit]})[0].rrfScore,ft.reciprocalRankFusion({dense:[hit]})[0].rrfScore);
    assert.ok(ft.reciprocalRankFusion({dense:[hit],sparse:[hit]})[0].rrfScore>ft.reciprocalRankFusion({dense:[hit]})[0].rrfScore);
    const settings={...(await f.api.loadSettings()),topK:2,maxInjectionChars:2500,mmrEnabled:false,heuristicRecall:true,contradictionBundleEnabled:true};
    const make=(id,turn,value)=>({record:{id,sourceType:'response',text:`Alice placed the brass key ${value}. The location was confirmed.`,turnIndex:turn,pairIndex:turn,responseTurnIndex:turn,
      turnRange:{start:turn,end:turn},structuredStateFacts:[{entity:'Alice',property:'location',value,turn,
        evidenceText:`Alice placed the brass key ${value}.`,evidenceStart:0,evidenceEnd:`Alice placed the brass key ${value}.`.length}]},score:.8,cosine:0,lexical:.8,components:{exactArm:1}});
    const recall={records:[make('before',1,'in the tower'),make('after',2,'in the garden')],scopeKey:'fixture',queryText:'Compare where Alice placed the brass key before and now.',temporalIntent:'compare',truthIntent:'disputed',currentStateFacts:[]};
    const before=JSON.stringify(recall);
    const plan=ft.selectFlashbackEvidencePlan(recall,settings,2500);
    assert.ok(plan.requirements.length>0,'Fixture must exercise an actual before/after requirement');
    assert.ok(plan.requirements.every(requirement=>requirement.status==='complete'),'Both values must survive rendering with support aligned by ID');
    assert.ok(plan.text.length>0,'Flashback must deliver a usable record');
    assert.ok(plan.text.length<=2500);
    assert.ok(plan.fragments.length>0);
    assert.equal(JSON.stringify(recall),before,'Selection must not mutate source records');
    for(const fragment of plan.fragments){
      assert.ok(plan.text.slice(fragment.outputStart,fragment.outputEnd).trim().length>0);
      assert.ok(fragment.sourceDigest);
    }
    const repeated=ft.selectFlashbackEvidencePlan({...recall,queryText:'Alice',temporalIntent:'unspecified',truthIntent:'unspecified',records:recall.records.map(item=>({...item,record:{...item.record,text:'Alice returned to the archive. Alice returned to the archive.',structuredStateFacts:[]}}))},settings,2500);
    assert.equal(repeated.fragments.length,2);
    assert.equal(new Set(repeated.fragments.map(fragment=>fragment.id)).size,2,'Equal text from different records keeps separate provenance');
    assert.ok(repeated.fragments[0].outputEnd<=repeated.fragments[1].outputStart,'Repeated text does not use a global first-substring offset');
    const reversed=ft.selectFlashbackEvidencePlan({...recall,records:[...recall.records].reverse()},settings,2500);
    assert.equal(plan.text,reversed.text,'Input order cannot choose the winning pair');
    const empty=ft.selectFlashbackEvidencePlan(recall,settings,0);
    assert.equal(empty.text,'');assert.equal(empty.deliveredIds.length,0);
    const limited=ft.selectFlashbackEvidencePlan(recall,{...settings,topK:1},2500);
    assert.equal(limited.items.length,1,'Explicit topK caps the pair while retaining an independent exact goal');
    assert.ok(limited.requirements.every(requirement=>requirement.status==='partial'),'One exact item does not complete the comparison');
    for(const topK of [2,3,4]) {
      const boundary=ft.selectFlashbackEvidencePlan(recall,{...settings,topK},plan.text.length);
      assert.equal(boundary.items.length,2);
      assert.ok(boundary.text.length<=plan.text.length);
    }
    const lows={...recall,queryText:'unrelated words',temporalIntent:'unspecified',truthIntent:'unspecified',records:recall.records.map((item,index)=>({...item,score:.02-index*.001,components:{}}))};
    assert.equal(ft.selectFlashbackEvidencePlan(lows,{...settings,heuristicRecall:false,mmrEnabled:true,contradictionBundleEnabled:false},2500).items.length,2,'Heuristic OFF must not apply low-novelty suppression');
    const broken=ft.selectFlashbackEvidencePlan({...recall,queryText:'Alice',temporalIntent:'unspecified',truthIntent:'unspecified',records:[recall.records[0],{record:{id:'broken',text:null},score:1}]},settings,2500);
    assert.ok(broken.text.includes('Alice'),'Malformed neighboring record cannot erase valid evidence');
    for(const damage of [{record:null},{record:{id:'bad',text:'',tags:{broken:true}}},{record:{id:'bad',text:'Broken optional record.',structuredStateFacts:[null,{},3]}},{record:{id:'bad',text:'Broken forced reasons.',components:{},tags:3},components:{forcedReasons:3}}]){
      const partial=ft.selectFlashbackEvidencePlan({...recall,records:[recall.records[0],damage]},settings,2500);
      assert.ok(partial.text.includes('Alice'),'A malformed optional neighbor cannot fail the whole plan');
    }
    const token=ft.beginFlashbackRecallRequest('fixture'),branch=token.branch;
    token.branch++;
    assert.equal(ft.flashbackRequestCurrent(token,branch),false,'Normal late result loses authority after emergency transition');
    assert.equal(ft.publishFlashbackRecallDelivery(recall,plan,token,branch,settings),false);
    const saving=ft.beginFlashbackRecallRequest('fixture');
    await f.api.saveSettings(await f.api.loadSettings());
    assert.equal(ft.flashbackRequestCurrent(saving),false,'The real settings transaction invalidates prepared recall');

    const hs={...(h.hayaku.status?.().settings||{}),maxItemsPerAxis:4,memoryLanguage:'en',promptMode:'balanced',effectiveMode:'balanced',rawRecallMaxChars:3000};
    const rows=[
      {axis:'world',category:'world_rule',id:'rule-a',publicRef:'rule-a',publicText:'Magic is forbidden inside the royal academy.',score:.9,importance:.9},
      {axis:'world',category:'world_rule',id:'rule-b',publicRef:'rule-b',publicText:'The archive opens only when the brass bell rings.',score:.8,importance:.8}
    ];
    const prepared=ht.prepareHayakuRecallRows(rows,'What are the academy rules?',hs,{},[],[]);
    const result=ht.selectHayakuEvidencePlan(prepared,'What are the academy rules?',hs,4000);
    assert.ok(result.text.length>0,'HAYAKU must deliver valid structured evidence');
    assert.ok(result.text.length<=4000);
    assert.ok(result.deliveredSelectionKeys.length>0,'Delivery maps back to selection keys');
    assert.ok(result.deliveredRowKeys.every(key=>!result.deliveredSelectionKeys.includes(key)),'Two legacy key formats remain explicitly mapped');
    const duplicates=[rows[0],{...rows[0],id:'rule-copy',publicRef:'rule-copy',packetHash:'another-packet'}];
    const merged=ht.selectHayakuEvidencePlan(ht.prepareHayakuRecallRows(duplicates,'academy rules',hs,{},[],[]),'academy rules',hs,4000);
    assert.equal(merged.renderedEntries,1,'Equivalent structured evidence is serialized once');
    assert.equal(merged.deliveredSources.length,2,'Merged entry retains both original search-key/source mappings');
    assert.equal(ht.selectHayakuEvidencePlan(prepared,'What are the academy rules?',hs,0).text,'');
    const comparison='Compare the academy rules before and now.';
    const pair=ht.prepareHayakuRecallRows(rows,comparison,hs,{},[],[{id:'rules',earliest:rows[0],latest:rows[1]}]);
    const paired=ht.selectHayakuEvidencePlan(pair,comparison,hs,4000);
    assert.ok(paired.plan.requirements.length>0,'HAYAKU fixture exercises grouped source requirements');
    assert.equal(paired.renderedEntries,2);
    const pairReversed=ht.prepareHayakuRecallRows([...rows].reverse(),comparison,hs,{},[],[{id:'rules',earliest:rows[0],latest:rows[1]}]);
    assert.equal(ht.selectHayakuEvidencePlan(pairReversed,comparison,hs,4000).text,paired.text,'Group order does not change HAYAKU output');
    const narrow=ht.selectHayakuEvidencePlan(pair,comparison,{...hs,maxItemsPerAxis:1},4000);
    assert.equal(narrow.renderedEntries,1,'A soft reference group keeps standalone evidence within the axis cap');
    assert.ok(narrow.plan.requirements.every(requirement=>requirement.status==='partial'));
    const raw=ht.selectHayakuEvidencePlan({entity:[],world:[],narrative:[],planner:[],rawRecoveryEvidence:[{id:'raw-one',text:'Alice entered the old archive.',pairIndex:1}]},'Alice',hs,3000);
    assert.ok(raw.text.includes('Alice entered the old archive.'));
    assert.deepEqual(plain(raw.rawDeliveredIds),['raw-one']);
    const oldToken=ht.beginHayakuRecallRequest('old');
    ht.beginHayakuRecallRequest('new');
    assert.equal(ht.publishHayakuRecallDelivery(result,oldToken,'rules',hs),false,'Late prior-scope completion cannot publish feedback');
    process.stdout.write('recall_selection_delivery_runtime_test: PASS\n');
  }finally{await h.dispose();await f.dispose();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
