'use strict';
const assert=require('node:assert/strict');
const core=require('../tools/recall_keyword_features.cjs')();
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
const entries=[{entityId:'minsu',normalized:'민수',aliases:['선생','별지기']},{entityId:'aria',normalized:'아리아',aliases:['선생']}];
const plan=core.compile('민수의 약속 장소는?',{entries,binding:{scope:'s',commit:'c',catalogComplete:true}});
assert.ok(!plan.targets[0].aliases.includes('선생'));
assert.equal(core.evidence({id:'wrong',scopeKey:'s',text:'선생의 약속 장소는 항구이다.'},plan,{entities:[entries[1]]}).length,0);
assert.equal(core.evidence({id:'alias',scopeKey:'s',text:'별지기는 성문에서 약속했다.'},plan,{entities:[entries[0]]}).length,0,'Document metadata does not certify an alias span');
const record={id:'right',scopeKey:'s',text:'민수는 성문에서 약속했다.'};
const evidence=core.evidence(record,plan,{entities:[entries[0]]});
assert.ok(evidence.some(e=>e.kind==='entity_mention'));
assert.ok(evidence.every(e=>record.text.slice(e.start,e.end)==='민수'));
assert.equal(core.fragmentEvidence({...record,text:'민수는 항구에서 약속했다.'},record.text,evidence).length,0,'Changed source invalidates old evidence');
const twice={...record,text:'민수는 성문에 있다. 민수는 항구에 있다.'};
const twiceEvidence=core.evidence(twice,plan,{entities:[entries[0]]});
assert.ok(core.fragmentEvidence(twice,'민수는 항구에 있다.',twiceEvidence).every(e=>e.start>=twice.text.indexOf('민수는 항구')),'Repeated names must not relocate evidence to another sentence');
assert.ok(core.fragmentEvidence(record,record.text,evidence).length);
const partial=core.compile('민수의 약속 장소는?',{entries,binding:{scope:'s',catalogComplete:false}});
assert.ok(core.evidence(record,partial,{entities:[entries[0]]}).every(e=>e.kind==='text_match'));
assert.ok(core.evidence({...record,scopeKey:'other'},plan,{entities:[entries[0]]}).every(e=>e.kind==='text_match'));
const link={entity:'minsu',property:'location',value:'성문',renderable:true,authority:'SOURCE_EVIDENCE',evidenceText:record.text,evidenceStart:0,evidenceEnd:record.text.length};
assert.ok(core.evidence(record,plan,{entities:[entries[0]],facts:[link],properties:['location']}).some(e=>e.kind==='fact_support'));
for(const bad of [{...link,evidenceEnd:3},{...link,authority:'CURRENT_USER_OVERLAY'},{...link,entity:'aria'},{...link,evidenceOffsetsInvalidated:true}])assert.ok(!core.evidence(record,plan,{entities:[entries[0]],facts:[bad]}).some(e=>e.kind==='fact_support'));
const scoped=core.compile('민수의 약속은?',{entries:[{...entries[0],scopeKey:'a'},{...entries[0],scopeKey:'b'}]});
assert.ok(scoped.resolvedEntities.every(e=>e.ambiguous));
for(const q of ['붉은 수정구슬 어디에 있어?','붉은 수정구슬은 어디에 있어?','작은 방에 누가 있어?'])assert.ok(!core.compile(q).targets.some(t=>['붉','작','누'].includes(t.normalized)));
const compound=core.compile('민수의 예전 위치와 아리아의 현재 위치는?',{entries});
assert.deepEqual(compound.goals.map(g=>g.intent.temporal),['past','current']);assert.equal(compound.intent.temporal,'uncertain');
assert.equal(new Set(compound.goals.map(g=>g.id)).size,2);
const quote=core.compile('“과거 비교 충돌 새로운 주제”라는 문구를 설명해줘.');
assert.equal(quote.intent.temporal,'unspecified');assert.equal(quote.intent.compare,false);assert.equal(quote.context.topicShift,false);
const raw='> 참고\n'.repeat(2000)+'질문: 민수의 약속은?',owned=core.requestSpec(raw,{requestIndex:2});
assert.equal(core.compile(owned).rawQuery,raw);const projected=core.prepareInput(raw);assert.ok(projected.length<=6000);assert.equal(core.compile(projected).rawQuery,projected);
const repeated=Array.from({length:4096},()=>entries[0]);const t=Date.now();assert.equal(core.resolveMentions('민수와 별지기는 민수에게 별지기의 기록을 전달했다.',repeated).length,2);assert.ok(Date.now()-t<1500,'Deduplication must remove quadratic repeated hits');
const families=core.tokenFamilies('수정구슬',core.documentTokens('수정구슬'));assert.ok(Math.abs([...families.values()].reduce((n,e)=>n+e.weight,0)-1)<1e-9);
async function runHook(f,cases,queries,metadata=[]){
 const cfg={...await f.api.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',embeddingEnabled:true,autoEpisodeIndex:false,structuredStateEnabled:false,topK:1,currentSceneTailEnabled:false,heuristicRecall:true,mmrEnabled:false};
 f.currentChat.message=cases.flatMap((body,i)=>[{role:'user',chatId:'u'+i,data:'기록해.'},{role:'assistant',chatId:'a'+i,data:body}]);f.currentChat.messages=f.currentChat.message;
 await f.api.saveSettings(cfg);await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
 const ft=f.api._test,sel=f.api._selectionTest,scope=await f.api.resolveCurrentScope();
 if(metadata.length){const rows=(await ft.loadScopeRecords(scope.scopeKey)).records;await ft.saveAllRecords(rows.map((r,i)=>({...r,metadata:{...r.metadata,statusDataParsed:{characters:metadata[i]||[]}}})),cfg,scope);}
 const before=JSON.stringify((await ft.loadScopeRecords(scope.scopeKey)).records);
 for(const [query,expected,excluded] of queries){
   const prepared=await sel.prepareFlashbackRecall(query,cfg,scope),out=await sel.beforeRequest([{role:'system',content:'질문에 답해.'},{role:'user',content:query}],'model');
   const delivered=out.find(m=>m.flashbackDynamic)?.content||'';
   assert.ok(delivered.includes(expected),query+'\n'+delivered);if(excluded)assert.ok(!delivered.includes(excluded),delivered);
   if(query.includes('지금'))assert.equal(prepared.temporalIntent,'current');
   const selected=sel.selectFlashbackEvidencePlan(prepared,cfg,2400,{selectionOnly:true});assert.ok(selected.targetCoverage.every(e=>!e.delivered));
   const tiny=sel.selectFlashbackEvidencePlan(prepared,cfg,1);assert.equal(tiny.text,'');assert.ok(tiny.targetCoverage.every(e=>!e.delivered));
 }
 assert.equal(JSON.stringify((await ft.loadScopeRecords(scope.scopeKey)).records),before);
}
(async()=>{
 for(const reverse of [false,true]){let f=await createFixture();try{
   const cases=['수정구슬은 지하 금고에 보관되어 있다.','붉은 망토는 성문에 걸려 있다.'];
   await runHook(f,reverse?cases.reverse():cases,[['붉은 수정구슬 어디에 있어?','수정구슬','망토'],['붉은 수정구슬은 어디에 있어?','수정구슬','망토']]);
 }finally{await f.dispose();}}
 let f=await createFixture();try{await runHook(f,['민수는 성문에서 만나기로 약속했다.','선생의 약속 장소는 항구이다. 약속 시간은 내일 아침이다. 약속 장소와 시간을 다시 확인했다.'],[['민수의 약속 장소는?','민수는 성문','선생의 약속']],[[{id:'minsu',name:'민수',aliases:['선생']}],[{id:'aria',name:'아리아',aliases:['선생']}]]);}finally{await f.dispose();}
 f=await createFixture();try{await runHook(f,['민수는 지금 성문에서 기다리고 있다.'],[['> 참고: 과거의 비교와 충돌은 새 주제이다.\n질문: 민수는 지금 어디에 있어?','민수는 지금 성문']]);}finally{await f.dispose();}
 const h=await createHayakuRuntime({autoRepair:false,arguments:{memory_suite_server_mode:'plugin_only'}});try{
 const store=h.hayaku._test.emptyStore();store.entity.characters=[{id:'minsu',publicRef:'minsu',name:'민수',aliases:['선생']},{id:'aria',publicRef:'aria',name:'아리아',aliases:['선생']}];
 const a=h.hayaku._test.buildRetrievalQuerySignature(store,'민수는 지금 어디에 있어?',h.hayaku.settings());
 const b=h.hayaku._test.buildRetrievalQuerySignature(store,'> 과거의 전쟁과 비밀, 새로운 주제\n질문: 민수는 지금 어디에 있어?',h.hayaku.settings());
 assert.equal(a.presentStateQuery,b.presentStateQuery);assert.deepEqual(a.channelWeights,b.channelWeights);assert.ok(!b.expandedText.includes('선생'));assert.equal(h.llmCalls.length,0);
 }finally{await h.dispose();}
 console.log('recall_evidence_policy_runtime_test: PASS');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
