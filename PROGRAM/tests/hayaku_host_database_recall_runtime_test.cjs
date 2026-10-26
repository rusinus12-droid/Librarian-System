'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const summary='The Aurora vault stores a silver spindle.';
const messages=Array.from({length:3},(_,i)=>[
 {role:'user',chatId:'u'+i,data:'Inspect the Aurora vault.'},
 {role:'assistant',chatId:'a'+i,data:hiddenPacketMessage(summary,createValidPacket({turn:i+1,subject:'Archivist',summary}))}
]).flat();

test('host database plugin persistence does not invalidate its own unchanged recall',async()=>{
 const runtime=await createHayakuRuntime({messages,autoRepair:false});
 try{
  const original=runtime.host.getDatabase;
  runtime.host.getDatabase=async fields=>{
   const database=await original();
   // Real host DBs contain the same plugin storage that the readset writer updates.
   database.pluginStorage=Object.fromEntries(runtime.pluginStorage.values);
   return Array.isArray(fields)?Object.fromEntries(fields.map(key=>[key,database[key]??null])):database;
  };
  const output=await runtime.callBeforeRequest([{role:'user',content:'What is inside the Aurora vault?'}],'model');
  const debug=runtime.hayaku.lastDebug();
  assert.equal(debug.lastBeforeRequest?.authoritativeLedger?.reconcileCommit?.durable,true,JSON.stringify(debug.lastBeforeRequest));
  assert.ok(output.some(row=>row.memo==='hayaku-runtime-context-v3'&&String(row.content).includes('silver spindle')));
  assert.equal(runtime.llmCalls.length,0);
 }finally{await runtime.dispose();}
});
