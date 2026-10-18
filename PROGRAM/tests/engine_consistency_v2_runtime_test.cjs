'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {executeOperation,DEFINITIONS}=require('./fixtures/retired_compute_reference_kernels.cjs');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const create=require('../tools/recall_keyword_features.cjs'),tokenizer=require('../tools/libra_recall_tokenizer.cjs');
const plain=v=>JSON.parse(JSON.stringify(v));
(async()=>{let cases=0;
execFileSync(process.execPath,[path.join(__dirname,'../tools/sync_libra_recall_tokenizer.cjs'),'--check']);
execFileSync(process.execPath,[path.join(__dirname,'../tools/sync_recall_keyword_features.cjs'),'--check']);
const l=await createLibraVmHarness();try{
const tokenize=tokenizer();
for(const query of ['돈 물','가 나','너를 사랑','민수는 지금 어디에 있어?','東京 图书馆 academy','한'.repeat(50000)]){
 assert.deepEqual(plain(l.api.debugRecallTokenStream(query)),tokenize(query));assert(tokenize(query).length<=1600);cases++;
 const rows=['돈 물','너를 사랑','東京 图书馆 academy'].map((text,i)=>({id:'m'+i,memory:{retrieval:{sparseFields:{summary:text,full_text:text}}}}));
 if(typeof l.api.debugBuildRecallBm25fInput==='function'){
  const input=plain(l.api.debugBuildRecallBm25fInput(rows,query)),before=JSON.stringify(input);
  assert.deepEqual(plain(l.api.debugRunRecallBm25fComputeLocal(input)),plain(executeOperation('libra.recall-bm25f.v1',input)));assert.equal(JSON.stringify(input),before);
 }
}
assert.deepEqual(tokenize('돈 물'),['돈','물']);assert(!tokenize('너를 사랑').includes('를사'));
assert.notEqual(DEFINITIONS['libra.recall-bm25f.v1'].fingerprint,'dea19e8a1c43caf8050d8225b15bf5a0d755a9974a56d22b996b4c4826c120fd');
}finally{await l.cleanup();}
const h=await createHayakuRuntime({autoRepair:false}),f=await createFixture();try{
const cores=[create(),h.hayaku._test.RecallKeywordFeatures,f.api._selectionTest.RecallKeywordFeatures];
for(const query of ['민수의 예전 위치와 아리아의 현재 위치는?',{rawQuery:'object sentinel',intent:{temporal:'past'}},{rawQuery:'object sentinel',declaredIntent:{temporal:'current'}},'time:current sentinel']){
const values=cores.map(c=>plain(c.compile(query)));assert.deepEqual(values[0],values[1]);assert.deepEqual(values[1],values[2]);assert(!values[0].rawQuery.includes('[object Object]'));cases++;
}
const t=f.api._test,record={id:'roles',scopeKey:'a',sourceType:'response',text:'love friend now current arrived event promised yesterday tomorrow 관계 위치 사건 어제',structuredStateFacts:[],metadata:{}};
const before=JSON.stringify(record),fields=t.sparseProjectionForRecord(record).fields;
for(const role of ['relation','state','event','temporal'])assert.equal(fields[role],'');assert(t.sparseProjectionForRecord(record).fieldTf.summary.has('love'));assert.equal(JSON.stringify(record),before);
const declared={...record,metadata:{recallFields:{event:'declared_event',temporal:['declared_time']}}};
assert(t.sparseProjectionForRecord(declared).fields.event.includes('declared_event'));assert.notEqual(t.sparseProjectionForRecord(record).key,t.sparseProjectionForRecord(declared).key);cases++;
}finally{await h.dispose();await f.dispose();}
// Use configured model vectors through the real adapter. Retired hash vectors
// cannot authorize current recall; this offline provider preserves the ranking
// and order-independence positive controls.
const fixtureVector=text=>String(text).includes('수정구슬')?[1,0,0]:String(text).includes('망토')?[0,1,0]:[0,0,1];
for(const reverse of [false,true]){const f=await createFixture({nativeFetch:async(_url,init)=>{const body=JSON.parse(init.body);return new Response(JSON.stringify({data:body.input.map((text,index)=>({index,embedding:fixtureVector(text)}))}),{status:200});}});try{
const cfg={...await f.api.loadSettings(),embeddingProvider:'openai_compat',embeddingUrl:'https://fixture.invalid/v1',embeddingModel:'consistency-fixture',embeddingDimensions:3,embeddingKey:'fixture-only',embeddingEnabled:true,autoEpisodeIndex:false,structuredStateEnabled:false,topK:1,currentSceneTailEnabled:false,heuristicRecall:true,mmrEnabled:false};
const bodies=['수정구슬은 지하 금고에 보관되어 있다.','붉은 망토는 성문에 걸려 있다.'];if(reverse)bodies.reverse();
f.currentChat.message=bodies.flatMap((data,i)=>[{role:'user',chatId:'u'+i,data:'기록해.'},{role:'assistant',chatId:'a'+i,data}]);f.currentChat.messages=f.currentChat.message;
await f.api.saveSettings(cfg);await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
const scope=await f.api.resolveCurrentScope(),before=JSON.stringify((await f.api._test.loadScopeRecords(scope.scopeKey)).records);
for(const [query,expected,excluded]of [['붉은 수정구슬 어디에 있어?','수정구슬','망토'],['수정구슬 어디에 있어?','수정구슬','망토'],['붉은 망토 어디에 있어?','망토','수정구슬']]){
const out=await f.api._selectionTest.beforeRequest([{role:'system',content:'질문에 답해.'},{role:'user',content:query}],'model');
const delivered=out.find(m=>m.flashbackDynamic)?.content||'';assert(delivered.includes(expected));assert(!delivered.includes(excluded));cases++;
}assert.equal(JSON.stringify((await f.api._test.loadScopeRecords(scope.scopeKey)).records),before);
}finally{await f.dispose();}}
console.log(JSON.stringify({test:'engine_consistency_v2',passed:cases,externalModelCalls:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
