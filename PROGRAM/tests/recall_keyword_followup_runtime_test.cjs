'use strict';
const assert=require('node:assert/strict');
const core=require('../tools/recall_keyword_features.cjs')();
const {createModelFixture:createFixture,modelSettings}=require('./fixtures/recall_model_runtime_fixture.cjs');
const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
assert.equal(core.mode("What is Minsu's next appointment location?"),'explicit');
assert.equal(core.mode('Next?'),'referential');
assert.equal(core.mode('What did she promise?'),'referential');
assert.equal(core.mode('Continue.'),'continuation');
const names=[{entityId:'mary-jane',normalized:'Mary Jane'},{entityId:'jane',normalized:'Jane'}];
assert.deepEqual(core.resolveMentions('Mary Jane는 어디에 있어?',names).map(r=>r.entityId),['mary-jane']);
assert.deepEqual(core.resolveMentions('Mary Jane와 Jane는 어디에 있어?',names).map(r=>r.entityId),['mary-jane','jane']);
const request='마지막 요청으로 붉은 수정구슬 위치를 알려줘?';
const long=Array.from({length:350},(_,i)=>`참고기록${i} 내용${i} 배경${i}`).join('\n')+'\n'+request;
for(const cap of [160,260,280,480]){
 const tokens=core.tokens(long,cap);assert.ok(tokens.includes('수정구슬'));assert.ok(tokens.length<=cap);
 const quoted='```\n'+Array.from({length:350},(_,i)=>`배경${i} 물음${i}?`).join('\n')+'\n```\n'+request;
 assert.ok(core.tokens(quoted,cap).includes('수정구슬'));
}
const rec=(id,text,turn=1)=>({id,scopeKey:'test',sourceType:'response',text,turnIndex:turn,pairIndex:turn,responseTurnIndex:turn,sourceHash:id});
(async()=>{const f=await createFixture(),h=await createHayakuRuntime({autoRepair:false,arguments:{memory_suite_server_mode:'plugin_only'}});try{
 const sel=f.api._selectionTest,ft=f.api._test,ht=h.hayaku._test;
 const cfg={...await f.api.loadSettings(),...modelSettings,topK:1,heuristicRecall:true,mmrEnabled:false,currentSceneTailEnabled:false};
 const store=ht.emptyStore();store.entity.characters=names.map(r=>({id:r.entityId,publicRef:r.entityId,name:r.normalized}));
 assert.deepEqual(Array.from(ht.buildRetrievalQuerySignature(store,'Mary Jane 어디에 있어?',h.hayaku.settings()).mentionedEntities),['mary-jane']);
 assert.ok(ht.buildRetrievalQuerySignature(store,long,h.hayaku.settings()).tokens.includes('수정구슬'));
 assert.ok(sel.extractRecallAnchors(long).tokens.has('수정구슬'));
 const target=rec('target','Minsu has an appointment at the harbor.'),other=rec('other','Aria has an appointment tomorrow.',2);
 for(const query of ["What is Minsu's next appointment location?","What is Minsu's appointment and what did she promise?"]){
  const items=[{record:target,score:.4,components:{exactArm:1}},{record:other,score:.9,components:{exactArm:1,currentSceneTail:1}}];
  for(const records of [items,[...items].reverse()]){
   const plan=sel.selectFlashbackEvidencePlan({scopeKey:'test',queryText:query,records},cfg,2000);
   assert.equal(plan.items[0].record.id,'target');assert.ok(plan.text.includes('Minsu'));
  }
  const off=sel.selectFlashbackEvidencePlan({scopeKey:'test',queryText:query,records:items},{...cfg,heuristicRecall:false},2000);
  assert.equal(off.items[0].record.id,'other','Opt-out preserves score/scene preference');
 }
 const anchors=sel.extractRecallAnchors("What is Minsu's next appointment location?");
 const distractors=Array.from({length:20},(_,i)=>({record:rec('d'+i,'Aria has an appointment tomorrow.',i+2),rrfScore:1-i*.01,armHits:['exact','dense','sparse']}));
 const weak={record:target,rrfScore:.001,armHits:['exact']},pool=[...distractors,weak];
 const before=JSON.stringify(pool);
 for(const rows of [pool,[...pool].reverse().sort((a,b)=>b.rrfScore-a.rrfScore)]){
  const selected=sel.selectFusedRecallCandidates(rows,anchors,cfg,8,1);
  assert.ok(selected.some(r=>r.record.id==='target'));assert.ok(selected.length<=9);
  const off=sel.selectFusedRecallCandidates(rows,anchors,{...cfg,heuristicRecall:false},8,1);
  assert.ok(!off.some(r=>r.record.id==='target'));
 }
 assert.equal(JSON.stringify(pool),before,'Candidate protection does not mutate evidence');
 const nicolo={...rec('nicolo','니콜로는 항구에 있다.'),metadata:{statusDataParsed:{characters:[{id:'nicolo',name:'니콜로'}]}}};
 const np=core.compile('니콜로는 어디에 있어?',{entries:[{entityId:'nicolo',normalized:'니콜로'}],binding:{scope:'test',catalogComplete:true}});
 const na=ft.buildDiscriminativeRecallAnchors(sel.extractRecallAnchors('니콜로는 어디에 있어?',[],np),[nicolo]);
 assert.equal(ft.collectEntityFocusedCandidates(na,[{record:nicolo,score:.8,components:{}}],{...cfg,entityFocusedRecallEnabled:true,entityFocusedPerAnchor:2,entityFocusedMaxTotal:4})[0].record.id,'nicolo');
 // Public ingest/recall and the real hook, using a mock host and actual configured-model adapter.
 f.currentChat.message=[{role:'user',chatId:'u1',data:'Record Minsu.'},{role:'assistant',chatId:'a1',data:target.text},{role:'user',chatId:'u2',data:'Record Aria.'},{role:'assistant',chatId:'a2',data:other.text}];f.currentChat.messages=f.currentChat.message;
 await f.api.saveSettings({...cfg,embeddingEnabled:true,structuredStateEnabled:false,autoEpisodeIndex:false});
 await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
 const scope=await f.api.resolveCurrentScope(),stored=JSON.stringify((await ft.loadScopeRecords(scope.scopeKey)).records);
 const hook=await sel.beforeRequest([{role:'system',content:'Answer the question.'},{role:'user',content:"What is Minsu's next appointment location?"}],'model');
 const text=hook.find(m=>m.flashbackDynamic)?.content||'';
 assert.ok(text.includes('Minsu'));assert.ok(!text.includes('Aria'));
 assert.equal(JSON.stringify((await ft.loadScopeRecords(scope.scopeKey)).records),stored);
 assert.equal(h.llmCalls.length,0);
 console.log('recall_keyword_followup_runtime_test: PASS');
}finally{await f.dispose();await h.dispose();}})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
