'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{const f=await createFixture();try{
 const t=f.api._test;
 for(const body of ['미라는 항구에 도착했다.','미라는 항구에 도착했다고 믿었다.','Mira arrived at the harbor.']) {
  assert.equal(t.structuredStateFactsFromMetadata.visible(body,{role:'assistant'}).length,0,'prose cannot create typed state');
 }
 const old={id:'old',sourceType:'response',text:'Mira arrived at the harbor.',turnIndex:1,stateUpdate:true,
 structuredStateFacts:[{entity:'Mira',property:'location',value:'harbor',authority:'VISIBLE_UA',evidenceType:'visible_u+a',turn:1}]};
 const declared={id:'declared',sourceType:'response',text:'A record of Mira.',turnIndex:2,
 structuredStateFacts:[{entity:'Mira',property:'location',value:'archive',authority:'STATUS_DATA',turn:2}]};
 const before=JSON.stringify(old);
 assert.equal(t.buildLatestStateByEntity([old]).size,0,'legacy inferred state is not authoritative');
 const state=t.buildLatestStateByEntity([old,declared]);
 assert.ok([...state.values()].some(entry=>entry.fact?.value==='archive'),'declared state remains usable');
 assert.equal(JSON.stringify(old),before,'legacy source and metadata remain intact');
 const cfg=t.normalizeSettings({...await f.api.loadSettings(),embeddingProvider:'hash',autoEpisodeIndex:false,episodeIndexEnabled:false});
 await f.api.saveSettings(cfg);
 f.currentChat.message=[{role:'user',chatId:'u',data:'Describe the journey.'},{role:'assistant',chatId:'a',data:old.text}];
 f.currentChat.messages=f.currentChat.message;
 await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
 const scope=await f.api.resolveCurrentScope();
 const records=(await t.loadScopeRecords(scope.scopeKey)).records;
 assert.ok(records.some(r=>r.text.includes(old.text)),'raw narrative is still saved');
 assert.ok(records.every(r=>!r.structuredStateFacts?.length),'new ingest does not synthesize state');
 const legacyRecords=records.map(r=>({...r,stateUpdate:true,structuredStateFacts:old.structuredStateFacts}));
 await t.saveAllRecords(legacyRecords,cfg,scope);
 const reread=(await t.loadScopeRecords(scope.scopeKey)).records;
 assert.ok(reread.every(r=>r.structuredStateFacts.some(fact=>fact.authority==='VISIBLE_UA')),'durable read preserves legacy metadata');
 assert.equal(t.buildLatestStateByEntity(reread).size,0,'durable legacy metadata does not regain authority');
 console.log('PASS no prose state inference; legacy state ignored without source mutation; declared state retained; raw ingest preserved');
}finally{await f.dispose();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
