'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {configure}=require('./helpers/unload_recall_contract_fixture.cjs');
const USER='Where is the blue ledger?',REPLY='The blue ledger is on the upper cabinet shelf.';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async predicate=>{for(let i=0;i<150;i++){const value=await predicate();if(value)return value;await wait(20);}throw Error('live confirmation did not settle');};
test('official output before host commit stays provisional, then confirms the exact committed pair',async()=>{
  const f=await createFixture({source:process.env.FLASHBACK_OUTPUT_SOURCE?require('node:fs').readFileSync(process.env.FLASHBACK_OUTPUT_SOURCE,'utf8'):undefined,chat:{message:[{role:'user',chatId:'u1',data:USER}]}});
  try{
    await configure(f,'hash');
    await until(()=>f.api.getCaptureBackendState().registered);
    await f.api._selectionTest.beforeRequest([{role:'user',chatId:'u1',content:USER}],'model');
    const eventChat={...f.currentChat,message:[{role:'user',chatId:'u1',data:USER},{role:'assistant',chatId:'a1',data:REPLY}]};
    await f.dispatchRisuChatEvent('output',{char:{...f.character,chats:[eventChat]},chat:eventChat,characterIndex:0,chatIndex:0,messageIndex:1});
    const scope=await f.api.resolveCurrentScope(false);
    const provisional=await until(async()=>{const rows=await f.api._test.loadScopeRecords(scope.scopeKey);return rows.records.find(r=>r.metadata?.captureAuthority?.provisional===true);});
    assert.equal(provisional.metadata.captureAuthority.liveConfirmed,false);
    assert.ok(f.api._test.finalizedCaptureMonitorStates().length>0,'durable provisional capture must retain its live monitor');
    f.currentChat.message=eventChat.message;f.currentChat.messages=f.currentChat.message;
    const confirmed=await until(async()=>{const rows=await f.api._test.loadScopeRecords(scope.scopeKey);return rows.records.find(r=>r.metadata?.captureAuthority?.liveConfirmed===true&&r.metadata?.captureAuthority?.provisional!==true);});
    assert.equal(confirmed.text,`User:\n${USER}\n\n---\n\nAssistant:\n${REPLY}`);
    assert.ok(confirmed.sourceMessageIds.includes('u1')&&confirmed.sourceMessageIds.includes('a1'));
  }finally{await f.dispose();}
});
test('a retained provisional source confirms after restart through normal request reconciliation',async()=>{
  let first=await createFixture({chat:{message:[{role:'user',chatId:'u1',data:USER}]}}),fresh;
  try{
    await configure(first,'hash');await until(()=>first.api.getCaptureBackendState().registered);
    await first.api._selectionTest.beforeRequest([{role:'user',chatId:'u1',content:USER}],'model');
    const chat={...first.currentChat,message:[{role:'user',chatId:'u1',data:USER},{role:'assistant',chatId:'a1',data:REPLY}]};
    await first.dispatchRisuChatEvent('output',{char:{...first.character,chats:[chat]},chat,characterIndex:0,chatIndex:0,messageIndex:1});
    const scope=await first.api.resolveCurrentScope(false);
    await until(async()=>{const data=await first.api._test.loadScopeRecords(scope.scopeKey);return data.records.some(row=>row.metadata?.captureAuthority?.provisional);});
    const stores={pluginStorage:first.pluginStorage,safeLocalStorage:first.host.safeLocalStorage};
    await first.dispose();first=null;
    fresh=await createFixture({...stores,chat});await configure(fresh,'hash');
    fresh.currentChat.message.push({role:'user',chatId:'u2',data:'Which shelf holds the ledger?'});fresh.currentChat.messages=fresh.currentChat.message;
    await fresh.api._selectionTest.beforeRequest([{role:'user',chatId:'u2',content:'Which shelf holds the ledger?'}],'model');
    const confirmed=await until(async()=>{const data=await fresh.api._test.loadScopeRecords(scope.scopeKey);return data.records.find(row=>row.metadata?.captureAuthority?.liveConfirmed===true);});
    assert.equal(confirmed.text,`User:\n${USER}\n\n---\n\nAssistant:\n${REPLY}`);
    assert.equal(fresh.api._test.manualEditorRecordStatus(confirmed).label,'활성 기록');
  }finally{if(first)await first.dispose();if(fresh)await fresh.dispose();}
});
