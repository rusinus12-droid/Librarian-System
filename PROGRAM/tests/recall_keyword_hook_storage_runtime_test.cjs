'use strict';
const assert=require('node:assert/strict');
const {createModelFixture:createFixture,modelSettings}=require('./fixtures/recall_model_runtime_fixture.cjs');
(async()=>{
 for(const reverse of [false,true]){
  const f=await createFixture();
  try{
   const pairs=[['민수의 약속을 기록해.','민수는 성문에서 만나기로 약속했다.'],['아리아의 약속을 기록해.','아리아의 약속 시간은 내일이다.']];
   if(reverse)pairs.reverse();
   f.currentChat.message=pairs.flatMap((pair,i)=>[{role:'user',chatId:'u'+i,data:pair[0]},{role:'assistant',chatId:'a'+i,data:pair[1]}]);f.currentChat.messages=f.currentChat.message;
   const cfg={...await f.api.loadSettings(),...modelSettings,embeddingEnabled:true,autoEpisodeIndex:false,topK:1,currentSceneTailEnabled:false,structuredStateEnabled:false,mmrEnabled:false};
   await f.api.saveSettings(cfg);await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
   const scope=await f.api.resolveCurrentScope(),ft=f.api._test;
   const storedBefore=JSON.stringify((await ft.loadScopeRecords(scope.scopeKey)).records);
   for(const topK of [1,2]){
    await f.api.saveSettings({...cfg,topK});
    const result=await f.api.recallRecords('민수의 약속 장소는?',{...cfg,topK});
    assert.ok(result.records.some(r=>r.record.text.includes('민수는 성문')));
    if(topK===1)assert.equal(result.records[0].record.text.includes('아리아'),false);
    const hook=await f.api._selectionTest.beforeRequest([{role:'system',content:'이야기 속 질문에 답해.'},{role:'user',content:'민수의 약속 장소는?'}],'model');
    const dynamic=hook.find(m=>m.flashbackDynamic)?.content||'';
    assert.ok(dynamic.includes('민수는 성문'));if(topK===1)assert.ok(!dynamic.includes('아리아'));
    assert.equal((await f.api.debugState()).lastRecall.delivery.stage,'returned_to_hook');
   }
   const records=(await ft.loadScopeRecords(scope.scopeKey)).records;
   const beforeVectors=JSON.stringify(records.map(r=>r.vector));
   const first=records[0];
   // A deterministic comparable vector gives a dense-only synonym candidate;
   // keyword separation must not turn exact matching into an admission gate.
   const dense=await ft.generateRecallCandidateArms({records,queryText:'quay rendezvous',queryVector:first.vector,settings:cfg,
     context:{queryProvider:first.provider,queryModel:first.model,queryProfileId:first.embeddingProfileId}});
   assert.ok(dense.dense.length>0,'Semantic candidates survive without exact lexical matches');
   assert.equal(JSON.stringify(records.map(r=>r.vector)),beforeVectors);
   assert.equal(JSON.stringify((await ft.loadScopeRecords(scope.scopeKey)).records),storedBefore,'Recall preserves stored originals and vectors');
   // Each reader observes physical bytes independently. Current C0 projection
   // caching cannot borrow a different request's physical read authority.
   const manifest=await ft.loadScopeManifest(scope.scopeKey);ft.invalidateRecallShardCache(scope.scopeKey);
   let physicalReads=0;const stores=[f.pluginStorage,f.host.safeLocalStorage];const reads=stores.map(store=>store.getItem.bind(store));
   stores.forEach((store,i)=>{store.getItem=async key=>{physicalReads++;return reads[i](key);};});
   const [left,right]=await Promise.all([ft.loadScopeRecordsForRecall(scope.scopeKey,null,{manifest}),ft.loadScopeRecordsForRecall(scope.scopeKey,null,{manifest})]);
   assert.equal(left.records.length,right.records.length);assert.notEqual(left.records,right.records);
   assert.ok(physicalReads>=2,'Distinct readers retain independent physical observations');
   stores.forEach((store,i)=>{store.getItem=reads[i];});
  }finally{await f.dispose();}
 }
 console.log('recall_keyword_hook_storage_runtime_test: PASS');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
