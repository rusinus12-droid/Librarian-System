const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const pair=(n,text)=>[{role:'user',id:'u'+n,chatId:'u'+n,data:'Question '+n},{role:'assistant',id:'a'+n,chatId:'a'+n,data:hiddenPacketMessage(text,createValidPacket({turn:n,subject:'Alice',scene:'office',summary:text}))}];
(async()=>{const r=await createHayakuRuntime({autoRepair:false,messages:pair(1,'Alice waited.')});try{
 const t=r.hayaku._test;
 async function observe(){const s=await t.currentChatScope();await t.reconcileObservedChatTopology(s,t.authoritativeChatSnapshot(s.chatMessages,s),'audit');}
 await observe();assert.equal(typeof r.hayaku.setSourceEditTrackingMode,'undefined');
 r.chat.message.push(...pair(2,'Alice signed the agreement.'),...pair(3,'Alice waited outside.'));await observe();
 r.chat.message[3].data=hiddenPacketMessage('Alice did not sign the agreement.',createValidPacket({turn:2,subject:'Alice',scene:'office',summary:'Alice signed the agreement.'}));
 const raw=await t.hayakuSourceEditSnapshot(),inventory=await r.hayaku.listReanalysisRanges();const affected=Array.from(raw.units,u=>u.key),actual=Array.from(inventory.ranges,u=>u.key);assert.deepEqual(actual,['1','2','3']);assert.deepEqual(actual,affected);assert.ok(inventory.ranges.every(r=>r.identity&&r.start>0));assert.equal(r.llmCalls.length,0,'source inventory is read-only and cannot dispatch affected suffix automatically');const before=JSON.stringify(inventory);await r.callBeforeRequest([{role:'user',content:'Continue.'}],'model');await r.callAfterRequest('', 'model');assert.equal(r.llmCalls.length,0);assert.equal(JSON.stringify(await r.hayaku.listReanalysisRanges()),before);
 console.log(JSON.stringify({id:'F2',environment:'actual HAYAKU source, owner ledger and snapshot producer, mock host',producerAffected:affected,registered:actual,modelCalls:r.llmCalls.length}));
}finally{await r.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});
