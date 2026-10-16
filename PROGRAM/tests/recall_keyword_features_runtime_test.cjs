'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const create=require('../tools/recall_keyword_features.cjs');
const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createModelFixture:createFixture,modelSettings}=require('./fixtures/recall_model_runtime_fixture.cjs');
const core=create();
const expectedBlock=`const RecallKeywordFeatures = (${create.toString()})();`;
for(const file of ['HAYAKU_Locator_Continuity.js','Flashback_Memory.js'])assert.ok(fs.readFileSync(path.join(__dirname,'../plugins',file),'utf8').includes(expectedBlock),'Standalone owner embeds identical reviewed helper');
for(const input of ['What is the city tax?','Explain the itinerary.','Tell me about mathematics.','Where is the storage office?'])assert.equal(core.mode(input),'explicit');
for(const input of ['What did she promise?','그 사람은 어디에 있어?','What about it?'])assert.equal(core.mode(input),'referential');
assert.equal(core.mode('새로운 주제로 넘어가자. 항구의 규칙은?'),'topic_shift');
assert.equal(core.mode('Continue.'),'continuation');
assert.equal(core.hint('storage office','rage'),false);assert.equal(core.hint('storage office','off'),false);
assert.equal(core.hint('angry off duty','off'),true);
assert.equal(core.mentions('A+B는 여기 있어.','A+B'),true);assert.equal(core.mentions('AAB는 여기 있어.','A+B'),false);
assert.equal(core.mentions('Dr. A는 여기 있어.','Dr. A'),true);
for(const input of ['민수에게서는 소식이 왔다.','민수'.normalize('NFD')+'는 왔다.','민\u200b수는 왔다.'])assert.ok(core.mentions(input,'민수'));
assert.ok(core.mentions('Ａｌｉｃｅ는 왔다.','Alice'));assert.ok(core.mentions('린은 왔다.','린'));
assert.deepEqual(core.variants('니콜로는'),['니콜로는','니콜로']);
assert.ok(!core.tokens('니콜로는 어디에 있어?',280,{grams:false}).includes('니콜'));
const names=[{entityId:'nicolo',normalized:'니콜로'},{entityId:'nicole',normalized:'니콜'}];
assert.deepEqual(core.resolveMentions('니콜로는 왔다.',names).map(x=>x.entityId),['nicolo']);
const ambiguous=core.resolveMentions('왕자는 왔다.',[{entityId:'a',normalized:'민수',aliases:['왕자']},{entityId:'b',normalized:'아리아',aliases:['왕자']}]);
assert.equal(ambiguous.length,2);assert.ok(ambiguous.every(x=>x.ambiguous));
assert.equal(core.contextRelevant('민수의 약속 장소는?','아리아는 내일 약속했다.'),false);
assert.equal(core.contextRelevant('민수의 약속 장소는?','민수는 성문에서 약속했다.'),true);
const long=Array.from({length:300},(_,i)=>'배경설명'+i).join(' ')+' 민수의 은빛열쇠는 어디에 있어?';
for(const cap of [160,260,280,480]){const tokens=core.tokens(long,cap);assert.ok(tokens.length<=cap);assert.ok(tokens.some(t=>t.includes('은빛열쇠')));}
const record=(id,text,turn=1,metadata={})=>({id,scopeKey:'scope-one',sourceType:'response',text,turnIndex:turn,pairIndex:turn,responseTurnIndex:turn,sourceHash:id,metadata});
const typed=(name,id,aliases=[])=>({statusDataParsed:{characters:[{name,id,aliases}]}});
(async()=>{
const h=await createHayakuRuntime({autoRepair:false,arguments:{memory_suite_server_mode:'plugin_only'}}),f=await createFixture();
try{
 const ht=h.hayaku._test,ft=f.api._test,sel=f.api._selectionTest,cfg={...await f.api.loadSettings(),...modelSettings,autoEpisodeIndex:false,structuredStateEnabled:false,topK:1,mmrEnabled:false,currentSceneTailEnabled:false,heuristicRecall:true};
 const store=ht.emptyStore();store.entity.characters=[{id:'nicolo',publicRef:'nicolo',name:'니콜로'},{id:'nicole',publicRef:'nicole',name:'니콜'},{id:'rin',publicRef:'rin',name:'린'},{id:'alice',publicRef:'alice',name:'Alice',aliases:['A+B']}];
 const sig=q=>ht.buildRetrievalQuerySignature(store,q,h.hayaku.settings());
 assert.deepEqual(Array.from(sig('니콜로 어디에 있어?').mentionedEntities),['nicolo']);
 assert.ok(sig('린 어디에 있어?').mentionedEntities.includes('rin'));
 assert.ok(sig('A+B 어디에 있어?').mentionedEntities.includes('alice'));
 store.entity.characters.push({id:'a',publicRef:'a',name:'민수',aliases:['왕자']},{id:'b',publicRef:'b',name:'아리아',aliases:['왕자']});
 assert.equal(sig('왕자 어디에 있어?').mentionedEntities.length,2,'Declared ambiguous aliases remain separate candidates');
 assert.equal(sig('왕자 어디에 있어?').knowledgeContext.primaryExplicitActors.length,0,'Ambiguous aliases cannot choose one knowledge actor');
 const scene=ft.buildSceneContextQuery('민수의 약속 장소는?',[{role:'assistant',content:'아리아의 약속 시간은 내일이다.'},{role:'user',content:'민수의 약속 장소는?'}],{...cfg,recallContextMessages:6});
 assert.ok(scene.text.includes('아리아의 약속 시간은 내일이다.'),'Context retains the scene without assuming the requested actor from keyword matches');
 assert.ok(scene.text.includes('민수의 약속 장소는?'),'Current request is retained with the scene');
 const target=record('target','민수는 성문에서 만나기로 약속했다.',1),other=record('other','아리아의 약속 시간은 내일이다.',2);
 for(const records of [[target,other],[other,target]]){
  const a=ft.buildDiscriminativeRecallAnchors(sel.extractRecallAnchors('민수의 약속 장소는?'),records);
  assert.equal(a.entities.size,0,'Raw nouns do not become verified identities');
  const arms=await ft.generateRecallCandidateArms({records,queryText:'민수의 약속 장소는?',queryAnchors:a,settings:cfg});
  assert.ok(Object.values(arms).every(rows=>rows.length===0),'Raw records without comparable model vectors cannot enter any recall arm');
  assert.ok(!arms.forced.some(x=>x.reasons.includes('entity_focused')));
  const plan=sel.selectFlashbackEvidencePlan({queryText:'민수의 약속 장소는?',scopeKey:'scope-one',records:records.map(r=>({record:r,score:r.id==='target'?.4:.9,components:r.id==='other'?{currentSceneTail:1,exactArm:1}:{exactArm:1}}))},cfg,2000);
  assert.equal(plan.items[0].record.id,'target');assert.ok(plan.text.includes('성문'));
 }
 const typedRecord=record('typed','민수는 성문에서 기다렸다.',1,typed('민수','minsu',['은빛 늑대','Min-su']));
 const a=ft.buildDiscriminativeRecallAnchors(sel.extractRecallAnchors('은빛 늑대가 어디에 있어?'),[typedRecord]);
 assert.ok(a.entities.has('민수'));assert.ok(!a.entities.has('늑대'));
 assert.equal(a.surfaceAnchors.length,1,'A resolved alias is one focus, not an extra unrelated noun');
 assert.ok(ft.buildDiscriminativeRecallAnchors(sel.extractRecallAnchors('Min-su는 어디에 있어?'),[typedRecord]).entities.has('민수'),'Resolve aliases from original query spelling');
 const identity=ft.buildSparseFieldsForRecord(typedRecord).identity;
 assert.ok(identity.includes('민수'));assert.ok(!identity.includes('성문'));
 const generic=ft.buildSparseFieldsForRecord({...target,structuredStateFacts:[{entity:'@world',property:'location',value:'항구'}]});assert.ok(!generic.identity.includes('@world'));
 const before=ft.sparseProjectionForRecord({...typedRecord,structuredStateFacts:[]});
 const changed=structuredClone(typedRecord);changed.structuredStateFacts=[];changed.metadata.statusDataParsed.characters[0].aliases=['검은 새'];
 const after=ft.sparseProjectionForRecord(changed);assert.notEqual(before.key,after.key,'Alias metadata invalidates even when structuredStateFacts is present');
 assert.notEqual(ft.sparseProjectionForRecord({...typedRecord,scopeKey:'other'}).key,ft.sparseProjectionForRecord(typedRecord).key);
 assert.equal(ft.sparseProjectionForRecord(record('tf','harbor harbor harbor')).fieldTf.summary.get('harbor'),3,'Vocabulary budgeting preserves BM25F term frequency');
 const longSource='배경의 긴 설명입니다. '.repeat(90)+'민수는 성문에서 만나기로 약속했다.';
 const excerptPlan=sel.selectFlashbackEvidencePlan({scopeKey:'scope-one',queryText:'민수의 약속 장소는?',records:[{record:record('tail',longSource),score:.8,components:{exactArm:1}}]}, {...cfg,rawExcerptMode:'record'},1000);
 assert.ok(excerptPlan.text.includes('민수는 성문'),'Budgeted fragment retains the target, not just its record ID');
 const small=sel.selectFlashbackEvidencePlan({scopeKey:'scope-one',queryText:'민수의 약속 장소는?',records:[{record:target,score:.8,components:{exactArm:1}}]},cfg,20);
 assert.equal(small.items.length,0,'Never fabricate a short substitute under impossible budget');
 const summary=ft.buildRecallShardSummary([target,other],0);
 const route=ft.selectRecallShardIndexes({scopeKey:'scope-one',shardCount:5,shardIndexVersion:4,shardSummaries:Array.from({length:5},(_,i)=>({...summary,shardIndex:i}))},'민수의 약속 장소는?',[],'hash','fact',{...cfg,recallFullScanThreshold:1});
 assert.equal(route.fullScan,true);assert.equal(route.indexes.length,5,'Legacy index cannot hide a shard');
 // Candidate admission now requires real configured-model readiness. Preserve
 // alias retrieval with actual ingested records and a query adapter result.
 f.currentChat.message=[
  {role:'user',chatId:'alias-u1',data:'민수의 위치를 기록해.'},{role:'assistant',chatId:'alias-a1',data:typedRecord.text},
  {role:'user',chatId:'alias-u2',data:'아리아의 약속을 기록해.'},{role:'assistant',chatId:'alias-a2',data:other.text}
 ];f.currentChat.messages=f.currentChat.message;
 await f.api.saveSettings(cfg);await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
 const scope=await f.api.resolveCurrentScope(),stored=(await ft.loadScopeRecords(scope.scopeKey)).records;
 const persistedBefore=JSON.stringify(stored);
 const readyTyped=structuredClone(stored.find(row=>row.sourceType==='response'&&row.text.includes(typedRecord.text)));
 const readyOther=structuredClone(stored.find(row=>row.sourceType==='response'&&row.text.includes(other.text)));
 assert.ok(readyTyped&&readyOther,'Both current source records were durably ingested');
 readyTyped.metadata={...readyTyped.metadata,...typed('민수','minsu',['은빛 늑대','Min-su'])};
 const query=await ft.getCachedQueryEmbedding('은빛 늑대가 어디에 있어?',cfg);
 const request={records:[readyTyped,readyOther],queryText:'은빛 늑대가 어디에 있어?',queryAnchors:a,queryVector:query.vector,settings:{...cfg,contextualRecall:false},
  context:{queryProvider:readyTyped.provider,queryModel:readyTyped.model,queryProfileId:readyTyped.embeddingProfileId}};
 // The non-contextual mode retains lexical arms after model admission.
 const typedArms=await ft.generateRecallCandidateArms(request);
 const contextualArms=await ft.generateRecallCandidateArms({...request,settings:{...cfg,contextualRecall:true}});
 assert.ok(contextualArms.dense.some(x=>x.record.id===readyTyped.id),'Default contextual mode still admits the comparable model record through the dense arm');
 assert.ok(contextualArms.exact.some(x=>x.record.id===readyTyped.id),'Contextual semantic mode keeps the exact-surface arm beside dense (hybrid fusion)');
 assert.equal(contextualArms.hashRecovery.length,0,'Contextual semantic mode never uses the retired hash recovery arm');
 assert.ok(!typedArms.forced.some(x=>x.reasons.includes('entity_focused')),'Partial local metadata cannot certify an alias globally');
 assert.ok(typedArms.exact.some(x=>x.record.id===readyTyped.id),'Unverified aliases retain ordinary retrieval among model-ready records');
 assert.ok(!typedArms.forced.some(x=>x.record.id===readyOther.id&&x.reasons.includes('entity_focused')));
 for(const rejected of [{...readyTyped,text:readyTyped.text+' changed after embedding'},{...readyTyped,provider:'hash',embeddingProvider:'hash'}]){
  const arms=await ft.generateRecallCandidateArms({...request,records:[rejected]});
  assert.ok(Object.values(arms).every(rows=>rows.length===0),'An alias cannot bypass stale-source or legacy-model admission');
 }
 assert.equal(JSON.stringify((await ft.loadScopeRecords(scope.scopeKey)).records),persistedBefore,'Alias candidate preparation preserves persisted source and model vectors');
 assert.equal(h.llmCalls.length,0);
 console.log('recall_keyword_features_runtime_test: PASS');
}finally{await h.dispose();await f.dispose();}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
