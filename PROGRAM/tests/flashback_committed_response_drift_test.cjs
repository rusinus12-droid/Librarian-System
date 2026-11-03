'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {configure}=require('./helpers/unload_recall_contract_fixture.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<480;i++){const v=await fn();if(v)return v;await wait(25);}throw Error('capture did not settle');}
for(const changedUser of [false,true])test(`committed response drift with ${changedUser?'edited':'unchanged'} bound user`,async()=>{
 const user='Where is the blue ledger?',candidate='The ledger is on the upper shelf.',committed='The blue ledger rests on the upper cabinet shelf after final formatting.';
 const f=await createFixture({captureBackend:'afterRequest',chat:{message:[{role:'user',chatId:'u1',data:user}]}});
 try{
  await configure(f,'hash');
  await f.api._selectionTest.beforeRequest([{role:'user',chatId:'u1',content:user}],'model');
  await f.api._selectionTest.afterRequest(candidate,'model');
  if(changedUser)f.currentChat.message[0].data='A different request.';
  f.currentChat.message.push({role:'assistant',chatId:'a1',data:committed});f.currentChat.messages=f.currentChat.message;
  const scope=await f.api.resolveCurrentScope(false);
  if(changedUser){await wait(350);const data=await f.api._test.loadScopeRecords(scope.scopeKey);assert.ok(!data.records.some(row=>row.text.includes(committed)));}
  else{const record=await until(async()=>{const data=await f.api._test.loadScopeRecords(scope.scopeKey);return data.records.find(row=>row.metadata?.captureAuthority?.liveConfirmed);});assert.ok(record.text.includes(committed));assert.ok(!record.text.includes(candidate));}
 }finally{await f.dispose();}
});
