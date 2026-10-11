'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
for(const change of ['none','source_before_run','scope','identity','delete'])test('Flashback selected owner current-input boundary '+change,async()=>{
 const f=await createFixture();try{
  f.currentChat.message=[{role:'user',chatId:'u1',data:'Question'},{role:'assistant',chatId:'a1',data:'Alice signed.'},{role:'user',chatId:'u2',data:'Then?'},{role:'assistant',chatId:'a2',data:'Alice waited.'}];f.currentChat.messages=f.currentChat.message;
  await f.api.saveSettings({...await f.api.loadSettings(),embeddingEnabled:false,autoEpisodeIndex:false});await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
  const scope=await f.api.resolveCurrentScope(),before=await f.api._test.loadScopeRecords(scope.scopeKey),unselected=before.records.filter(r=>r.text.includes('Alice waited')).map(r=>({id:r.id,text:r.text}));
  assert.ok(unselected.length,'durable unselected source exists');const inventory=await f.api.listReanalysisRanges();assert.equal(inventory.ranges.length,2);const selection={...inventory,ranges:inventory.ranges.filter(r=>r.key==='1')};
  if(change==='none'||change==='source_before_run')f.currentChat.message[1].data='Alice did not sign.';
  if(change==='scope')f.currentChat.id=f.currentChat.chatId='other';if(change==='identity')f.currentChat.message[1].chatId='new-assistant';if(change==='delete')f.currentChat.message.splice(0,2);
  const result=await f.api.reanalyzeSelectedRanges(selection);assert.equal(result.ok,['none','source_before_run'].includes(change),JSON.stringify(result));
  const after=await f.api._test.loadScopeRecords(scope.scopeKey);
  if(result.ok){assert.ok(after.records.some(r=>r.text.includes('Alice did not sign.')));for(const old of unselected)assert.ok(after.records.some(r=>r.id===old.id&&r.text===old.text),'unselected source remains active');assert.equal(f.currentChat.message[1].data,'Alice did not sign.');assert.equal(f.api.getReanalysisStatus().lastResult.ok,true)}
  else assert.deepEqual(after.records.map(r=>r.text),before.records.map(r=>r.text),'refused operation preserves stored source');
 }finally{await f.dispose()}
});
