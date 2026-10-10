const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const pair=(n,text)=>[{role:'user',id:'u'+n,chatId:'u'+n,data:'Question '+n},{role:'assistant',id:'a'+n,chatId:'a'+n,data:hiddenPacketMessage(text,createValidPacket({turn:n,subject:'Alice',scene:'office',summary:text}))}];
(async()=>{const r=await createHayakuRuntime({autoRepair:false,messages:pair(1,'Alice waited.')});try{
 const t=r.hayaku._test,c=t.getHayakuSourceEdits();
 async function observe(){const s=await t.currentChatScope();await t.reconcileObservedChatTopology(s,t.authoritativeChatSnapshot(s.chatMessages,s),'audit');}
 await observe();await r.hayaku.setSourceEditTrackingMode('off');await r.hayaku.setSourceEditTrackingMode('silent');
 r.chat.message.push(...pair(2,'Alice signed the agreement.'),...pair(3,'Alice waited outside.'));await observe();
 r.chat.message[3].data=hiddenPacketMessage('Alice did not sign the agreement.',createValidPacket({turn:2,subject:'Alice',scene:'office',summary:'Alice signed the agreement.'}));
 const raw=await t.hayakuSourceEditSnapshot();const affected=Array.from(raw.units.filter(u=>u.changed),u=>u.key);assert.deepEqual(affected,['2','3']);
 await c.beforeRequest(raw);c.afterRequest();const actual=Array.from(c.status().tasks,t=>t.key);assert.deepEqual(actual,['2','3']);
 console.log(JSON.stringify({id:'F2',environment:'actual HAYAKU source, owner ledger and snapshot producer, mock host',producerAffected:affected,registered:actual,modelCalls:r.llmCalls.length}));
}finally{await r.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});
